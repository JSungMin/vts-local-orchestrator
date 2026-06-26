#!/usr/bin/env node
/*
 * qwen-mcp-bridge — a local Qwen2.5-Coder (Ollama, full-GPU) agent that DRIVES the
 * vs-token-safer `vs-search` MCP tools.
 *
 * vs-token-safer itself ships NO model and transmits nothing — it is a token-capped,
 * language-server-backed code search/edit surface for Claude Code. Claude Code can't swap its
 * own model to a local one, so to let Qwen use those same tools we run a separate MCP host:
 * this script. It spawns the vs-search server over stdio (official MCP SDK client), hands every
 * vs-search tool to Qwen as an Ollama tool, and runs the call -> tool -> call loop until Qwen
 * answers.
 *
 *   Single shot:  node qwen-mcp-bridge.mjs "where is UGameInstance::Init defined?"
 *   REPL:         node qwen-mcp-bridge.mjs
 *
 * Env overrides (else from qvts.config.json, written by setup.ps1):
 *   OLLAMA_HOST     default http://127.0.0.1:11434
 *   QVTS_MODEL      default qwen-coder-vts
 *   VTS_SERVER      path to vs-token-safer/server/index.js (else auto-resolved)
 *   VTS_PROJECT     default: read from ~/.vs-token-safer/config.json projectPath
 *   QVTS_MAXSTEPS   default 25  (tool-call rounds before giving up)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "./config-loader.mjs";

const CFG = loadConfig();
const OLLAMA_HOST = CFG.ollamaHost;
const MODEL = CFG.model;
const VTS_SERVER = CFG.vtsServer;
const MAX_STEPS = CFG.maxSteps;
const NUM_CTX = CFG.numCtx;

// ---- resolve the target project root (so we can inject it into tool args Qwen forgets) ----
function readProjectPath() {
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
const PROJECT = readProjectPath();

// ---- MCP tool schema -> Ollama (OpenAI-style) tool ----
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

// vs-search tools take a project root under one of these arg names. If Qwen omits it, inject the
// configured project so the call lands on the target repo instead of the bridge's cwd.
const ROOT_ARGS = ["projectPath", "root", "cwd"];
function injectProject(toolSchema, args) {
  if (!PROJECT) return args;
  const props = toolSchema?.inputSchema?.properties || {};
  for (const k of ROOT_ARGS) {
    // ALWAYS override — the model emits placeholders ("<your-project-path>") or wrong paths; force the real root.
    if (k in props) {
      args[k] = PROJECT;
      break;
    }
  }
  return args;
}

// Extract balanced {...} / [...] JSON blobs embedded in free text (one level of nesting tracking).
function extractJsonBlobs(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0,
      inStr = false,
      esc = false;
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
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

// Ollama doesn't structure tool calls for the qwen-coder template (parser=""), so the model emits the
// call as content text: a bare JSON object, a ```json fence, a <tool_call>…</tool_call> tag, or an array
// of them. Recover them here. A blob counts as a tool call only if its `name` is a REAL tool (validNames)
// and it carries an `arguments`/`parameters` object — so a genuine final answer that merely mentions JSON
// is not misread as a call.
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
      try {
        parsed = JSON.parse(blob);
      } catch {
        continue;
      }
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!c || typeof c.name !== "string" || !validNames.has(c.name)) continue;
        const args = c.arguments ?? c.parameters ?? {};
        const key = c.name + JSON.stringify(args);
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ function: { name: c.name, arguments: args } });
      }
    }
    if (calls.length) break; // first source that yields valid calls wins
  }
  return calls;
}

async function ollamaChat(messages, tools) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      options: { num_ctx: NUM_CTX, temperature: 0.15 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()).message;
}

const SYSTEM = `You are a code-navigation and editing agent for a large Unreal Engine C++ codebase.
You have a set of vs-search tools backed by an official language-server index (clangd). They return
COMPACT file:line results, never whole files — trust them and do NOT ask to read entire files.

Rules:
- To find a symbol/class/function/type/variable use search_symbol. Never guess paths.
- For who-calls / usages use find_references. For the definition use goto_definition.
- To read ONE declaration's body use read_symbol (not a whole-file read).
- For raw strings/comments/config keys the symbol index can't answer, use search_text.
- Chain tools as needed, then give a short, direct answer with the relevant file:line citations.
- Do not invent file paths, line numbers, or symbols. If a tool returns nothing, say so.
- Copy search terms from the user's request EXACTLY, character for character. Do not change spelling,
  add or drop letters, or alter case of an identifier. A typo'd query returns nothing.
- If a search returns no matches twice, STOP retrying variants and report "no match" — do not keep guessing.`;

async function runAgent(client, toolSchemas, ollamaTools, task, history) {
  const messages = history;
  messages.push({ role: "user", content: task });
  const trace = []; // { tool, args } per call — surfaced in --json so the Claude orchestrator can audit
  const validNames = new Set(toolSchemas.map((t) => t.name));
  const executed = new Map(); // call signature -> prior result, to break the repeat-same-call loop
  let dupCount = 0; // consecutive duplicate calls; small local model can fixate on a failing query
  let unproductive = 0; // consecutive empty/no-match results — catches a mutated-args fixation loop
  const isEmpty = (r) => {
    if (!r || r.trim().length < 3) return true;
    const s = r.toLowerCase();
    // vts no-match phrasings: "No text matches for …", "No symbols …", "… every match (0).", "not found".
    return (
      /\bno (text |symbol )?match/.test(s) ||
      /\bno (results?|symbols?|references?|files?)\b/.test(s) ||
      /\b0 (match|matches|results?|references?)\b/.test(s) ||
      /\(0\)/.test(s) ||
      /\bnot found\b/.test(s) ||
      /\bnothing\b/.test(s)
    );
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await ollamaChat(messages, ollamaTools);
    messages.push(msg);

    // Prefer structured tool_calls; fall back to parsing them out of content (qwen-coder template).
    let calls = msg.tool_calls || [];
    if (!calls.length) calls = parseToolCallsFromText(msg.content, validNames);
    if (!calls.length) {
      return { answer: msg.content || "(no answer)", trace };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const schema = toolSchemas.find((t) => t.name === name);
      trace.push({ tool: name, args });
      let resultText;
      if (!schema) {
        resultText = `ERROR: unknown tool "${name}". Available: ${toolSchemas.map((t) => t.name).join(", ")}`;
      } else {
        injectProject(schema, args);
        const sig = name + " " + JSON.stringify(args);
        if (executed.has(sig)) {
          // The model is repeating an identical call (a fixation loop — typically a misspelled query that
          // keeps returning nothing). Don't re-run the tool; tell it so and nudge it to change tack or stop.
          dupCount++;
          process.stderr.write(`  · (dup) ${sig}\n`);
          resultText =
            `ALREADY CALLED this exact tool with these exact args; the result was unchanged:\n` +
            `${executed.get(sig).slice(0, 400)}\n` +
            `Do NOT repeat it. Either change the arguments (check spelling of the query!) or, if you have ` +
            `enough information, give your FINAL answer now as plain text.`;
          if (dupCount >= 3) {
            messages.push({ role: "tool", content: resultText, tool_name: name });
            return {
              answer:
                "(stopped: the local model looped on the same failing call. Last attempts: " +
                trace.slice(-3).map((t) => t.tool + "(" + JSON.stringify(t.args) + ")").join(", ") +
                ". Likely a misspelled query or no match.)",
              trace,
            };
          }
        } else {
          dupCount = 0;
          process.stderr.write(`  · ${name}(${JSON.stringify(args)})\n`);
          try {
            const out = await client.callTool({ name, arguments: args });
            resultText = (out.content || [])
              .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
              .join("\n");
            if (out.isError) resultText = `TOOL ERROR:\n${resultText}`;
          } catch (e) {
            resultText = `TOOL EXCEPTION: ${e.message}`;
          }
          executed.set(sig, resultText);
          // Productivity tracking: many small models loop on a failing query while tweaking one arg each
          // turn (dodging the exact-signature dup guard). Count consecutive empty results and bail.
          if (isEmpty(resultText)) {
            unproductive++;
            if (unproductive >= 4) {
              messages.push({
                role: "tool",
                content:
                  "Four consecutive searches returned nothing. STOP searching and reply in plain text: " +
                  "state that no match was found and what term you tried (double-check its spelling).",
                tool_name: name,
              });
              return {
                answer:
                  "(stopped: no results after 4 tries. Tried: " +
                  trace.slice(-4).map((t) => `${t.tool} q=${JSON.stringify(t.args.q ?? t.args.symbol ?? t.args)}`).join(" | ") +
                  ". Likely a misspelled query term or genuinely absent.)",
                trace,
              };
            }
          } else {
            unproductive = 0;
          }
        }
      }
      messages.push({
        role: "tool",
        content: resultText.slice(0, 8000),
        tool_name: name,
      });
    }
  }
  return { answer: `(stopped: hit ${MAX_STEPS}-step limit without a final answer)`, trace };
}

async function main() {
  if (!PROJECT) {
    process.stderr.write(
      "WARN: no project root resolved (set VTS_PROJECT or ~/.vs-token-safer/config.json). " +
        "Tools will default to the bridge cwd.\n",
    );
  } else {
    process.stderr.write(`project: ${PROJECT}\nmodel:   ${MODEL}\n`);
  }

  // vs-token-safer default-prewarms (full background index) on every server spawn. The bridge spawns a
  // FRESH server per process, so leaving prewarm on would re-pay a full UE-tree index each run. vts already
  // indexes INCREMENTALLY/lazily on demand and persists to its db/, so we disable the eager prewarm and the
  // boot-time transcript auto-learn — the first query lazy-indexes only what it needs, later runs reuse the
  // persisted index. Override by exporting VTS_PREWARM=1 before launching if you DO want eager warming.
  if (!VTS_SERVER) {
    process.stderr.write(
      "ERROR: vs-token-safer server path not found. Run setup.ps1, or set VTS_SERVER / vtsServer in qvts.config.json.\n",
    );
    process.exit(1);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [VTS_SERVER],
    env: {
      ...process.env,
      VTS_PREWARM: process.env.VTS_PREWARM ?? "0",
      VTS_AUTO_LEARN: process.env.VTS_AUTO_LEARN ?? "0",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "qwen-vts-bridge", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  // Expose only READ-ONLY LOCATOR tools to the local model. Edit tools (replace_symbol_body, insert_symbol,
  // rename, safe_delete) and vts_admin (gen_compile_db etc. — heavy / mutating) are withheld: a 14B model
  // wandering into them caused both accidental-edit risk and a multi-minute hang on gen_compile_db. Override
  // the set with QVTS_TOOLS="a,b,c" if you deliberately want more. The Claude orchestrator does the edits.
  const DEFAULT_TOOLS = new Set([
    "search_symbol", "find_references", "goto_definition", "hover",
    "document_symbols", "read_symbol", "search_text", "find_files",
    "concept_search", "diagnostics",
  ]);
  const allowed = process.env.QVTS_TOOLS
    ? new Set(process.env.QVTS_TOOLS.split(",").map((s) => s.trim()).filter(Boolean))
    : DEFAULT_TOOLS;
  const allTools = (await client.listTools()).tools;
  const tools = allTools.filter((t) => allowed.has(t.name));
  const ollamaTools = tools.map(toOllamaTool);
  process.stderr.write(`vs-search locator tools: ${tools.map((t) => t.name).join(", ")}\n\n`);

  const history = [{ role: "system", content: SYSTEM }];
  const JSON_OUT = /^(1|true|on|yes)$/i.test(process.env.QVTS_JSON || "");
  const argv = process.argv.slice(2).filter((a) => a !== "--json");
  if (process.argv.includes("--json")) process.env.QVTS_JSON = "1";
  const oneShot = argv.join(" ").trim();

  if (oneShot) {
    const { answer, trace } = await runAgent(client, tools, ollamaTools, oneShot, history);
    if (JSON_OUT || process.env.QVTS_JSON === "1") {
      process.stdout.write(JSON.stringify({ task: oneShot, answer, trace }) + "\n");
    } else {
      process.stdout.write("\n" + answer + "\n");
    }
    await client.close();
    return;
  }

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("qwen-vts agent — ask about the codebase, Ctrl-C to quit.\n");
  rl.setPrompt("qvts> ");
  rl.prompt();
  rl.on("line", async (line) => {
    const task = line.trim();
    if (!task) return rl.prompt();
    if (/^(exit|quit|:q)$/i.test(task)) return rl.close();
    try {
      const { answer } = await runAgent(client, tools, ollamaTools, task, history);
      process.stdout.write("\n" + answer + "\n\n");
    } catch (e) {
      process.stdout.write(`\nERROR: ${e.message}\n\n`);
    }
    rl.prompt();
  });
  rl.on("close", async () => {
    await client.close();
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack || e.message}\n`);
  process.exit(1);
});
