/*
 * agent-core.mjs — the Qwen↔vts agentic loop as a reusable, event-emitting module (used by the web
 * dashboard). STREAMS model tokens and emits a structured event per step so a UI can render the loop live.
 *
 * The CLI (vts-bridge.mjs) stays self-contained; this module duplicates the small helpers on purpose
 * so the proven CLI path is never touched. Shared behaviour: locator-only tools, projectPath injection,
 * tool-call-from-text fallback (qwen-coder template has parser=""), dup + unproductive loop guards.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, clangdIndexUsable } from "./config-loader.mjs";

const CFG = loadConfig();
const OLLAMA_HOST = CFG.ollamaHost;
const MODEL = CFG.model;
const VTS_SERVER = CFG.vtsServer;
const MAX_STEPS = CFG.maxSteps;
const NUM_CTX = CFG.numCtx;

const DEFAULT_TOOLS = new Set([
  "search_symbol", "find_references", "goto_definition", "hover",
  "document_symbols", "read_symbol", "search_text", "find_files",
  "concept_search", "diagnostics",
]);

const SYSTEM = `You are a code-navigation agent for a software repository (any language — C/C++, C#, JS/TS,
Python, etc.). You have vs-search tools backed by an official language-server index (or tree-sitter when
there is no toolchain). They return COMPACT file:line results, never whole files — trust them and do NOT
ask to read entire files.

Pick the right tool:
- Find a symbol/class/function/type/variable -> search_symbol. Never guess paths.
- Find a file by name -> find_files.
- who-calls / usages -> find_references. The definition -> goto_definition. One body -> read_symbol.
- raw strings/comments/config the index can't answer -> search_text.
- If search_symbol is NOT in your tool list (or returns nothing) for a C/C++ declaration, find it without the
  index: find_files for the likely file (a class is usually in <ClassName>.h), then document_symbols on it.

Reporting rules (critical — you are a locator, your job is to REPORT what the tools find):
- When a tool returns a result (a file path, a symbol at file:line), that result is GROUND TRUTH. Report it
  directly. Do NOT re-search to "double-check" a POSITIVE result, and never overturn a found result into "no match".
- Copy search terms from the request EXACTLY, character for character — a typo'd query returns nothing.
- Never call search_text with a catch-all pattern like ".*". Use a concrete term.
- If a search genuinely returns no matches twice, STOP and report "no match" — do not keep guessing variants.

FINAL ANSWER FORMAT (strict — your answer goes to another program, not a human):
- Output ONLY the locations, one per line, as \`path:line\` (group several lines of one file as \`path:line1,line2\`).
- NO prose, NO sentences, NO "The function is declared at…", NO markdown headers/bullets, NO code fences,
  NO closing remarks. Just the bare \`path:line\` lines. If nothing was found, output exactly: no match`;

// ~chars/4 token estimate (BPE avg for code). Labelled as an estimate in the UI.
const estTok = (s) => Math.ceil(String(s || "").length / 4);

// Per-tool raw:out ratio from vts's own savings.json — how much bigger the UNCAPPED language-server/grep
// response is than the capped file:line vts returns. Used to estimate what a raw grep / direct-LSP read
// would have cost Claude. Falls back to 1.0 (no savings claimed) when history is absent.
function loadRawRatios() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".vs-token-safer", "savings.json"), "utf8"));
    const r = {};
    for (const [tool, v] of Object.entries(j.tools || {})) {
      if (v.outTok > 0 && v.rawTok > 0) r[tool] = Math.max(1, v.rawTok / v.outTok);
    }
    r._global = j.outTok > 0 && j.rawTok > 0 ? Math.max(1, j.rawTok / j.outTok) : 1;
    return r;
  } catch {
    return { _global: 1 };
  }
}

export function readProjectPath() {
  if (process.env.VTS_PROJECT) return process.env.VTS_PROJECT;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".vs-token-safer", "config.json"), "utf8"),
    );
    return cfg.projectPath || null;
  } catch {
    return null;
  }
}

function toOllamaTool(t) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: (t.description || "").slice(0, 1024),
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  };
}

const ROOT_ARGS = ["projectPath", "root", "cwd"];
function injectProject(toolSchema, args, project) {
  if (!project) return args;
  const props = toolSchema?.inputSchema?.properties || {};
  for (const k of ROOT_ARGS) {
    // ALWAYS override — the model must not choose the project root (it emits placeholders like
    // "<your-project-path>" or wrong paths). The bridge knows the real target; force it.
    if (k in props) {
      args[k] = project;
      break;
    }
  }
  return args;
}

function extractJsonBlobs(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { out.push(s.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
}

function parseToolCallsFromText(content, validNames) {
  if (!content) return [];
  const tagged = [];
  for (const m of String(content).matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) tagged.push(m[1]);
  for (const m of String(content).matchAll(/```(?:json|tool_call)?\s*([\s\S]*?)```/g)) tagged.push(m[1]);
  const sources = tagged.length ? tagged : [content];
  const calls = [];
  const seen = new Set();
  for (const src of sources) {
    for (const blob of extractJsonBlobs(src)) {
      let parsed;
      try { parsed = JSON.parse(blob); } catch { continue; }
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!c || typeof c.name !== "string" || !validNames.has(c.name)) continue;
        const args = c.arguments ?? c.parameters ?? {};
        const key = c.name + JSON.stringify(args);
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ function: { name: c.name, arguments: args } });
      }
    }
    if (calls.length) break;
  }
  return calls;
}

const isEmptyResult = (r) => {
  if (!r || r.trim().length < 3) return true;
  const s = r.toLowerCase();
  return (
    /\bno (text |symbol )?match/.test(s) ||
    /\bno (results?|symbols?|references?|files?)\b/.test(s) ||
    /\b0 (match|matches|results?|references?)\b/.test(s) ||
    /\(0\)/.test(s) ||
    /\bnot found\b/.test(s) ||
    /\bnothing\b/.test(s)
  );
};

// Streamed /api/chat. Calls onDelta(text) per token chunk; resolves with the assembled message + timing.
async function ollamaChatStream(messages, tools, onDelta) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: true,
      options: { num_ctx: NUM_CTX, temperature: 0.15 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let toolCalls = [];
  let stats = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const delta = obj.message?.content || "";
      if (delta) { content += delta; onDelta?.(delta); }
      if (obj.message?.tool_calls?.length) toolCalls = obj.message.tool_calls;
      if (obj.done) {
        stats = {
          evalCount: obj.eval_count || 0,
          evalMs: Math.round((obj.eval_duration || 0) / 1e6),
          promptCount: obj.prompt_eval_count || 0,
          loadMs: Math.round((obj.load_duration || 0) / 1e6),
        };
      }
    }
  }
  return { content, tool_calls: toolCalls, stats };
}

// Connect MCP, filter to locator tools. Returns the agent handle.
export async function createAgent({ onEvent = () => {} } = {}) {
  const project = readProjectPath();
  // QVTS_TOOLS may only NARROW the read-only set (never grant edit/admin tools) unless QVTS_ALLOW_MUTATION=1.
  const allowMutation = /^(1|true|on|yes)$/i.test(process.env.QVTS_ALLOW_MUTATION || "");
  // precedence: QVTS_TOOLS env > qvts.config.json `tools` > full read-only DEFAULT (see vts-bridge.mjs).
  const INDEX_TOOLS = new Set(["search_symbol", "find_references", "goto_definition", "hover", "diagnostics"]);
  const toolsSpec = process.env.QVTS_TOOLS || CFG.tools;
  let requested;
  if (toolsSpec) {
    requested = toolsSpec.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    requested = [...DEFAULT_TOOLS];
    // AUTO-NARROW (general): drop clangd-dependent tools on a C/C++ project with no usable index (they hang).
    const autoNarrow = !/^(0|false|off|no)$/i.test(process.env.QVTS_AUTO_NARROW || "");
    if (autoNarrow && !clangdIndexUsable(project)) requested = requested.filter((n) => !INDEX_TOOLS.has(n));
  }
  const allowed = new Set(requested.filter((n) => DEFAULT_TOOLS.has(n) || allowMutation));

  if (!VTS_SERVER) throw new Error("vs-token-safer server path not found. Run setup.ps1, or set VTS_SERVER / vtsServer in qvts.config.json.");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [VTS_SERVER],
    env: { ...process.env, VTS_PREWARM: process.env.VTS_PREWARM ?? "0", VTS_AUTO_LEARN: process.env.VTS_AUTO_LEARN ?? "0", VTS_CLANGD_BG_INDEX: process.env.VTS_CLANGD_BG_INDEX ?? "0", VTS_LSP_INDEX_WAIT_MS: process.env.VTS_LSP_INDEX_WAIT_MS ?? "15000" },
    stderr: "ignore",
  });
  const client = new Client({ name: "vts-local-dashboard", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const allTools = (await client.listTools()).tools;
  const tools = allTools.filter((t) => allowed.has(t.name));
  const ollamaTools = tools.map(toOllamaTool);
  const validNames = new Set(tools.map((t) => t.name));
  const ratios = loadRawRatios();

  onEvent({ type: "ready", project, model: MODEL, tools: tools.map((t) => t.name) });

  async function run(task) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: task }];
    const trace = [];
    const executed = new Map();
    let dupCount = 0, unproductive = 0;
    const t0 = Date.now();
    let totalEval = 0, totalEvalMs = 0;
    // token accounting for the 3-way savings panel:
    //   outTokSum = capped vts results (what CC-using-vts would eat) ; rawTokSum = estimated uncapped
    //   grep/LSP response (what CC-using-grep/raw would eat, via vts's measured per-tool ratio).
    let outTokSum = 0, rawTokSum = 0;
    const savings = (answer) => {
      const a = estTok(answer); // delegate: Claude only sees Qwen's summary
      return {
        delegateTok: a,
        ccVtsTok: outTokSum,
        ccGrepTok: Math.round(rawTokSum),
        savedVsVts: Math.max(0, outTokSum - a),
        savedVsGrep: Math.max(0, Math.round(rawTokSum) - a),
      };
    };

    onEvent({ type: "task", task });

    for (let step = 0; step < MAX_STEPS; step++) {
      onEvent({ type: "step", step: step + 1 });
      const msg = await ollamaChatStream(messages, ollamaTools, (d) => onEvent({ type: "delta", text: d }));
      messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
      totalEval += msg.stats.evalCount || 0;
      totalEvalMs += msg.stats.evalMs || 0;
      onEvent({ type: "assistant_done", text: msg.content, stats: msg.stats });

      let calls = msg.tool_calls?.length ? msg.tool_calls : parseToolCallsFromText(msg.content, validNames);
      if (!calls.length) {
        const ans = msg.content || "(no answer)";
        const stats = { ms: Date.now() - t0, evalCount: totalEval, tokPerSec: totalEvalMs ? +(totalEval / (totalEvalMs / 1000)).toFixed(1) : 0, steps: step + 1, savings: savings(ans) };
        onEvent({ type: "final", answer: ans, trace, stats });
        return { answer: ans, trace, stats };
      }

      for (const call of calls) {
        const name = call.function?.name;
        let args = call.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const schema = tools.find((t) => t.name === name);
        trace.push({ tool: name, args });
        let resultText, ok = true;
        if (!schema) {
          resultText = `ERROR: unknown tool "${name}".`;
          ok = false;
        } else {
          injectProject(schema, args, project);
          const sig = name + " " + JSON.stringify(args);
          if (executed.has(sig)) {
            dupCount++;
            onEvent({ type: "tool_call", tool: name, args, dup: true });
            resultText = `ALREADY CALLED with identical args; result unchanged. Change the query (check spelling) or give your FINAL answer.`;
            ok = false;
            if (dupCount >= 3) {
              const ans = "(stopped: model looped on the same failing call.)";
              const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: step + 1, savings: savings(ans) };
              onEvent({ type: "stopped", reason: "looped on identical call", trace, stats });
              return { answer: ans, trace, stats };
            }
          } else {
            dupCount = 0;
            onEvent({ type: "tool_call", tool: name, args, dup: false });
            try {
              const out = await client.callTool({ name, arguments: args });
              resultText = (out.content || []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
              if (out.isError) { resultText = `TOOL ERROR:\n${resultText}`; ok = false; }
            } catch (e) { resultText = `TOOL EXCEPTION: ${e.message}`; ok = false; }
            executed.set(sig, resultText);
            const ot = estTok(resultText);
            outTokSum += ot;
            rawTokSum += ot * (ratios[name] || ratios._global || 1);
            if (isEmptyResult(resultText)) {
              unproductive++;
              if (unproductive >= 4) {
                onEvent({ type: "tool_result", tool: name, ok: false, text: resultText });
                const ans = "(stopped: no results after 4 tries — likely misspelled or absent.)";
                const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: step + 1, savings: savings(ans) };
                onEvent({ type: "stopped", reason: "no results after 4 tries", trace, stats });
                return { answer: ans, trace, stats };
              }
            } else unproductive = 0;
          }
        }
        onEvent({ type: "tool_result", tool: name, ok, text: resultText });
        messages.push({ role: "tool", content: resultText.slice(0, 8000), tool_name: name });
      }
    }
    const ans = `(stopped: ${MAX_STEPS}-step limit)`;
    const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: MAX_STEPS, savings: savings(ans) };
    onEvent({ type: "stopped", reason: `hit ${MAX_STEPS}-step limit`, trace, stats });
    return { answer: ans, trace, stats };
  }

  return { run, project, model: MODEL, tools: tools.map((t) => t.name), close: () => client.close() };
}
