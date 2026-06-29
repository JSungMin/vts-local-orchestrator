/*
 * agent-core.mjs — the local-LLM↔vts agentic loop as a reusable, event-emitting module (used by the web
 * dashboard). STREAMS model tokens and emits a structured event per step so a UI can render the loop live.
 *
 * The CLI (vts-bridge.mjs) stays self-contained; this module duplicates the small helpers on purpose
 * so the proven CLI path is never touched. Shared behaviour: locator-only tools, projectPath injection,
 * tool-call-from-text fallback (qwen-coder template has parser=""), dup + unproductive loop guards.
 */
// @modelcontextprotocol/sdk is imported DYNAMICALLY inside createAgent() (after ensureDeps) — never a
// top-level static import — so a fresh plugin install with no node_modules self-heals instead of crashing.
import { ensureDeps } from "./scripts/ensure-deps.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, clangdIndexUsable } from "./config-loader.mjs";
import { definitionSearches, detectLang } from "./defn-patterns.mjs";

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
- WHERE IS X DECLARED / DEFINED -> def_search name="X" (FIRST choice). Builds the right definition regex per
  language, skips usages/#includes/comments. Use before search_symbol/search_text for any declaration hunt.
- Find a symbol/class/function/type/variable -> search_symbol. Never guess paths.
- Find a file by name -> find_files.
- who-calls / usages -> find_references. The definition -> goto_definition. One body -> read_symbol.
- raw strings/comments/config the index can't answer -> search_text.
- search_text / find_files: NEVER pass a directory (or the project root) as \`path\` — it scopes to a single
  FILE, so a directory matches nothing. OMIT \`path\` to search the WHOLE tree; use \`glob\` ("*.h") to limit.
- DECLARATION hunt via search_text: ALWAYS search the DEFINITION pattern, not the bare name — \`class .*Name\` /
  \`struct .*Name\` for a type, \`Name\\s*\\(\` for a function (bare name floods with usages/#includes/comments
  and the time-box buries the declaration → false "no match"). Holds even for loose requests ("the game-instance
  class" → \`class .*GameInstance\`, glob "*.h").
- UNINDEXED / NOT-YET-INDEXED C/C++: search_symbol / document_symbols may be ABSENT, or present but return
  empty / "timed out" / error fast (index not ready). EITHER way, don't retry them — fall back:
  1) find_files for the likely file (class FooBar usually in FooBar.h; strip a UE prefix U/A/F/S/E for the name).
  2) search_text for the bare NAME as a SUBSTRING or regex \`class .*Name\` — NOT "class Name" (UE decls read
     \`class MODULE_API UName : public Base\`). Omit \`path\` (or glob "*.h"). The file:line returned IS the answer.

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

// search_text / find_files scope `path` to a single FILE; a DIRECTORY (esp. the project root) matches NOTHING,
// so a small model passing the repo root as `path` yields a false "no match". Drop a directory path so the
// locate covers the whole tree. A real file path or a glob never stats as a directory and is preserved.
const PATH_SCOPE_TOOLS = new Set(["search_text", "find_files"]);
const PATH_ARGS = ["path", "dir", "file"];
function sanitizeScopeArgs(name, args, project) {
  if (!PATH_SCOPE_TOOLS.has(name) || !args) return args;
  for (const k of PATH_ARGS) {
    const v = args[k];
    if (typeof v !== "string" || !v) continue;
    let isDir = false;
    try {
      const abs = path.isAbsolute(v) ? v : path.join(project || process.cwd(), v);
      isDir = fs.statSync(abs).isDirectory();
    } catch { /* glob/pattern — leave alone */ }
    if (isDir) delete args[k];
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

// def_search — synthetic deterministic declaration locator over search_text (see vts-bridge.mjs). Tries the
// language's definition regexes in priority order and returns the first that matches.
const DEF_EMPTY = /\bno (text |symbol )?match|\bnot found\b|\(0\)/i;
async function defSearch(client, args, project) {
  const sym = String(args.name || args.symbol || args.q || "").trim();
  if (!sym) return "def_search needs a 'name' (the symbol/type/function to locate the declaration of).";
  const lang = (args.lang && String(args.lang).toLowerCase()) || detectLang(project) || "";
  const cands = definitionSearches(sym, lang || undefined).slice(0, 6);
  for (const c of cands) {
    let out;
    try {
      const r = await client.callTool({ name: "search_text", arguments: { q: c.q, projectPath: project } });
      out = (r.content || []).map((x) => (x.type === "text" ? x.text : JSON.stringify(x))).join("\n");
      if (r.isError) out = `TOOL ERROR:\n${out}`;
    } catch (e) {
      out = `TOOL EXCEPTION: ${e.message}`;
    }
    if (!DEF_EMPTY.test(out) && !/^TOOL E/.test(out)) {
      return `def_search(${sym}, lang=${lang || "auto"}) — definition pattern /${c.q}/ [${c.kind}]:\n${out}`;
    }
  }
  return `no match — def_search(${sym}) tried ${cands.length} definition pattern(s) for lang=${lang || "auto"}; none matched.`;
}

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
  // Language-server-backed for C/C++ (clangd) → hang/error on a big UNINDEXED tree. Drop ALL of them when
  // clangd is unusable, leaving only the index-free walk/grep locators (find_files, search_text). VERIFIED:
  // document_symbols times out (clangd) / errors (treesitter backend); read_symbol/concept_search need the
  // index too. Kept for JS/TS/Python and indexed C/C++ (narrow is gated by clangdIndexUsable).
  const INDEX_TOOLS = new Set([
    "search_symbol", "find_references", "goto_definition", "hover", "diagnostics",
    "document_symbols", "read_symbol", "concept_search",
  ]);
  // AUTO-NARROW mode (default "soft" — see vts-bridge.mjs): soft = keep clangd tools but FAST-FAIL their
  // queries (short LSP timeouts) so the model falls back to find_files/search_text; hard = drop them; off =
  // keep them with normal long waits. Fast-fail/hard engage only on an UNUSABLE C/C++ index.
  const NARROW_OFF = /^(0|false|off|no)$/i.test(process.env.QVTS_AUTO_NARROW || "");
  const NARROW_HARD = /^hard$/i.test(process.env.QVTS_AUTO_NARROW || "");
  const INDEX_USABLE = clangdIndexUsable(project);
  const FAST_FAIL = !INDEX_USABLE && !NARROW_OFF && !NARROW_HARD;
  const LSP_TIMEOUT = process.env.VTS_LSP_TIMEOUT_MS ?? (FAST_FAIL ? (process.env.QVTS_FASTFAIL_TIMEOUT_MS || "4000") : "30000");
  const LSP_INDEX_WAIT = process.env.VTS_LSP_INDEX_WAIT_MS ?? (FAST_FAIL ? "2000" : "15000");
  const toolsSpec = process.env.QVTS_TOOLS || CFG.tools;
  let requested;
  if (toolsSpec) {
    requested = toolsSpec.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    requested = [...DEFAULT_TOOLS];
    // Only HARD mode drops the clangd-backed tools; SOFT/OFF keep them (soft relies on the short timeouts).
    if (NARROW_HARD && !INDEX_USABLE) requested = requested.filter((n) => !INDEX_TOOLS.has(n));
  }
  const allowed = new Set(requested.filter((n) => DEFAULT_TOOLS.has(n) || allowMutation));

  if (!VTS_SERVER) throw new Error("vs-token-safer server path not found. Run setup.ps1, or set VTS_SERVER / vtsServer in qvts.config.json.");
  // Self-heal the one runtime dep, then dynamically load the SDK (see the import note at the top).
  await ensureDeps();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [VTS_SERVER],
    env: { ...process.env, VTS_PREWARM: process.env.VTS_PREWARM ?? "0", VTS_AUTO_LEARN: process.env.VTS_AUTO_LEARN ?? "0", VTS_CLANGD_BG_INDEX: process.env.VTS_CLANGD_BG_INDEX ?? "0", VTS_LSP_INDEX_WAIT_MS: LSP_INDEX_WAIT, VTS_LSP_TIMEOUT_MS: LSP_TIMEOUT },
    stderr: "ignore",
  });
  const client = new Client({ name: "vts-local-dashboard", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const allTools = (await client.listTools()).tools;
  const tools = allTools.filter((t) => allowed.has(t.name));
  const ollamaTools = tools.map(toOllamaTool);
  // Synthetic deterministic declaration locator (handled in run(), never sent to vs-search). Disable: QVTS_DEF_SEARCH=0.
  if (!/^(0|false|off|no)$/i.test(process.env.QVTS_DEF_SEARCH || "")) {
    tools.push({ name: "def_search", inputSchema: { type: "object", properties: { name: { type: "string" }, lang: { type: "string" } }, required: ["name"] } });
    ollamaTools.push({
      type: "function",
      function: {
        name: "def_search",
        description:
          "Locate a DECLARATION/definition by name using language-aware definition regexes. PREFER over " +
          "search_text for 'where is X declared/defined' — skips usages/#includes/comments. args: name " +
          "(required); lang (optional cpp|csharp|ts|js|python|go|java|kotlin|rust — auto-detected if omitted).",
        parameters: { type: "object", properties: { name: { type: "string" }, lang: { type: "string" } }, required: ["name"] },
      },
    });
  }
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
      const a = estTok(answer); // delegate: Claude only sees the local model's summary
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
        if (name === "def_search") {
          const sig = "def_search " + JSON.stringify(args);
          if (executed.has(sig)) {
            dupCount++;
            onEvent({ type: "tool_call", tool: name, args, dup: true });
            resultText = "ALREADY CALLED def_search with these args; give your FINAL answer or try a different name/lang.";
            ok = false;
            if (dupCount >= 3) {
              const ans = "(stopped: looped on def_search.)";
              const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: step + 1, savings: savings(ans) };
              onEvent({ type: "stopped", reason: "looped on def_search", trace, stats });
              return { answer: ans, trace, stats };
            }
          } else {
            dupCount = 0;
            onEvent({ type: "tool_call", tool: name, args, dup: false });
            resultText = await defSearch(client, args, project);
            executed.set(sig, resultText);
            const ot = estTok(resultText);
            outTokSum += ot;
            rawTokSum += ot * (ratios.search_text || ratios._global || 1);
            if (isEmptyResult(resultText)) {
              unproductive++;
              if (unproductive >= 4) {
                onEvent({ type: "tool_result", tool: name, ok: false, text: resultText });
                const ans = "(stopped: no results after 4 tries.)";
                const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: step + 1, savings: savings(ans) };
                onEvent({ type: "stopped", reason: "no results after 4 tries", trace, stats });
                return { answer: ans, trace, stats };
              }
            } else unproductive = 0;
          }
        } else if (!schema) {
          resultText = `ERROR: unknown tool "${name}".`;
          ok = false;
        } else {
          injectProject(schema, args, project);
          sanitizeScopeArgs(name, args, project);
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
