#!/usr/bin/env node
/*
 * vts-bridge — a local Qwen2.5-Coder (Ollama, full-GPU) agent that DRIVES the
 * vs-token-safer `vs-search` MCP tools.
 *
 * vs-token-safer itself ships NO model and transmits nothing — it is a token-capped,
 * language-server-backed code search/edit surface for Claude Code. Claude Code can't swap its
 * own model to a local one, so to let Qwen use those same tools we run a separate MCP host:
 * this script. It spawns the vs-search server over stdio (official MCP SDK client), hands every
 * vs-search tool to Qwen as an Ollama tool, and runs the call -> tool -> call loop until Qwen
 * answers.
 *
 *   Single shot:  node vts-bridge.mjs "where is UGameInstance::Init defined?"
 *   REPL:         node vts-bridge.mjs
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
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawn } from "node:child_process";
import { loadConfig } from "./config-loader.mjs";

const CFG = loadConfig();
const OLLAMA_HOST = CFG.ollamaHost;
const MODEL = CFG.model;
const VTS_SERVER = CFG.vtsServer;
const MAX_STEPS = CFG.maxSteps;
const NUM_CTX = CFG.numCtx;
const KEEP_ALIVE = process.env.QVTS_KEEP_ALIVE || "30m"; // keep the model resident between calls (perf)

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

// Shrink the final answer's token cost: strip the (long, absolute) project-root prefix so cited paths
// are repo-relative (search_symbol/goto return absolute paths; find_files/find_references return relative).
// PROJECT reflects the -p / VTS_PROJECT target. No-op when PROJECT is unset.
function relAnswer(s) {
  if (!PROJECT) return s;
  const p = PROJECT.replace(/\/+$/, "");
  return String(s)
    .split(p + "/")
    .join("")
    .split(p)
    .join("");
}

// ---- token-savings ledger -------------------------------------------------------------------------
// The whole point of delegation: Claude pays only for the compact final answer, not the raw search loop.
// We estimate, per delegation, what Claude WOULD have spent under each strategy and persist the running
// total to ~/.vts-local/savings.json (mirrors vs-token-safer's own savings.json).
//   delegateTok = tokens of the answer Claude actually receives  (the only real cost)
//   ccVtsTok    = Σ capped tool-result tokens   (what CC eats running vs-search itself)
//   ccGrepTok   = Σ estimated uncapped response (what CC eats with grep/raw, via vts's measured ratio)
const estTok = (s) => Math.ceil(String(s || "").length / 4); // ~chars/4 BPE estimate (labelled an estimate)

// Per-tool raw:out ratio from vts's own savings.json — how much bigger the uncapped grep/LSP response is
// than the capped file:line vts returns. Falls back to 1.0 (claim no grep savings) when history is absent.
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
const RATIOS = loadRawRatios();
const LEDGER_PATH = process.env.QVTS_SAVINGS_FILE || path.join(os.homedir(), ".vts-local", "savings.json");

// Fold one delegation's accounting (acct from runAgent) + the delivered answer into the persistent ledger.
function recordSavings(acct, answer) {
  const delegateTok = estTok(answer);
  const ccVtsTok = Math.round(acct.outTok);
  const ccGrepTok = Math.round(acct.rawTok);
  let led;
  try {
    led = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    led = { delegations: 0, delegateTok: 0, ccVtsTok: 0, ccGrepTok: 0, byTool: {} };
  }
  led.delegations += 1;
  led.delegateTok += delegateTok;
  led.ccVtsTok += ccVtsTok;
  led.ccGrepTok += ccGrepTok;
  for (const [t, v] of Object.entries(acct.byTool)) {
    const b = (led.byTool[t] ||= { calls: 0, outTok: 0, rawTok: 0 });
    b.calls += v.calls;
    b.outTok += Math.round(v.outTok);
    b.rawTok += Math.round(v.rawTok);
  }
  led.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(led, null, 2) + "\n");
  } catch {
    /* best-effort; a read-only home shouldn't break a locate */
  }
  return {
    delegateTok,
    ccVtsTok,
    ccGrepTok,
    savedVsVts: Math.max(0, ccVtsTok - delegateTok),
    savedVsGrep: Math.max(0, ccGrepTok - delegateTok),
  };
}

// Render the cumulative ledger as a compact report (for `qvts --savings`).
function savingsReport() {
  let led;
  try {
    led = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return `vts-local savings: no ledger yet (${LEDGER_PATH}). Run a delegation first.`;
  }
  const usd = Number(process.env.VTS_USD_PER_MTOK || 3);
  const savedVts = Math.max(0, led.ccVtsTok - led.delegateTok);
  const savedGrep = Math.max(0, led.ccGrepTok - led.delegateTok);
  const lines = [
    `vts-local savings (local, ${led.delegations} delegation(s))  ${LEDGER_PATH}`,
    `  Claude actually received (answers): ~${led.delegateTok.toLocaleString()} tok  ← the only real cost`,
    `  if Claude ran vs-search itself:     ~${led.ccVtsTok.toLocaleString()} tok   → saved ~${savedVts.toLocaleString()} (${pct(savedVts, led.ccVtsTok)})`,
    `  if Claude grepped raw:              ~${led.ccGrepTok.toLocaleString()} tok   → saved ~${savedGrep.toLocaleString()} (${pct(savedGrep, led.ccGrepTok)})`,
    `  est. value: ~$${(savedGrep / 1e6 * usd).toFixed(2)} (@ $${usd}/Mtok — set VTS_USD_PER_MTOK)`,
  ];
  const tools = Object.entries(led.byTool).sort((a, b) => b[1].rawTok - a[1].rawTok);
  if (tools.length) {
    lines.push("  by tool:");
    for (const [t, v] of tools) lines.push(`    ${t.padEnd(16)} ${v.calls} call(s), ~${Math.round(v.rawTok).toLocaleString()} grep-tok avoided`);
  }
  return lines.join("\n");
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + "%" : "0%");

// ---- locate result cache --------------------------------------------------------------------------
// A repeated identical locate should cost ZERO model time. Cache {answer, trace, acct} under
// ~/.vts-local/cache/, keyed by model+project+query. Invalidation:
//   - git repo, CLEAN  → key includes HEAD; valid until HEAD changes (strong, content-exact)
//   - git repo, DIRTY  → DON'T cache (you're actively editing; content changes without HEAD moving)
//   - non-git          → time-bound (QVTS_CACHE_TTL seconds, default 1h)
// `--no-cache` bypasses entirely. On a hit the savings ledger is still credited (Claude avoided the cost again).
const CACHE_DIR = process.env.QVTS_CACHE_DIR || path.join(os.homedir(), ".vts-local", "cache");
const CACHE_TTL_MS = Number(process.env.QVTS_CACHE_TTL || 3600) * 1000;
const CACHE_MAX = Number(process.env.QVTS_CACHE_MAX || 500);

// Cheap repo-change fingerprint. {head, dirty} for a git repo (3s-bounded), else {head:null}.
function repoFingerprint(project) {
  if (!project) return { head: null };
  try {
    const head = execSync("git rev-parse HEAD", { cwd: project, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const status = execSync("git status --porcelain", { cwd: project, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return { head, dirty: status.length > 0 };
  } catch {
    return { head: null }; // not a git repo (or git unavailable) → TTL mode
  }
}

const normQuery = (q) => String(q).trim().replace(/\s+/g, " ");
function cacheKey(model, project, query) {
  return crypto.createHash("sha1").update([model, project || "", normQuery(query)].join("\0")).digest("hex");
}
const cachePath = (key) => path.join(CACHE_DIR, key + ".json");

// Return a valid cached entry or null. fp is the current repoFingerprint.
function cacheRead(key, fp) {
  let e;
  try {
    e = JSON.parse(fs.readFileSync(cachePath(key), "utf8"));
  } catch {
    return null;
  }
  if (fp.head) return e.head === fp.head ? e : null; // git: HEAD must match
  return e.exp && Date.now() < e.exp ? e : null; // non-git: within TTL
}

function cacheWrite(key, fp, entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const rec = { ...entry, head: fp.head || null, ts: Date.now() };
    if (!fp.head) rec.exp = Date.now() + CACHE_TTL_MS;
    fs.writeFileSync(cachePath(key), JSON.stringify(rec));
    pruneCache();
  } catch {
    /* best-effort */
  }
}

// Keep the cache dir bounded — drop the oldest files past CACHE_MAX.
function pruneCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    if (files.length <= CACHE_MAX) return;
    const stat = files.map((f) => ({ f, m: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs })).sort((a, b) => a.m - b.m);
    for (const { f } of stat.slice(0, files.length - CACHE_MAX)) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
  } catch {
    /* ignore */
  }
}

// Content-addressed cache for digest/triage (keyed by model + the artifact's content hash, not git HEAD —
// a digest only changes when the bytes do). Repeated digests of the same file then cost ZERO model time.
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
function contentCacheGet(kind, contentHash, extra) {
  const key = sha1([kind, MODEL, extra || "", contentHash].join("\0"));
  try {
    return JSON.parse(fs.readFileSync(cachePath(key), "utf8"));
  } catch {
    return null;
  }
}
function contentCachePut(kind, contentHash, extra, value) {
  const key = sha1([kind, MODEL, extra || "", contentHash].join("\0"));
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify(value));
    pruneCache();
  } catch {
    /* best-effort */
  }
}

// ---- warm daemon -----------------------------------------------------------------------------------
// Spawning the vs-search server (and re-warming the tsserver/clangd index) per `qvts` call is the main
// per-call latency. The daemon keeps ONE MCP+model session warm and serves locates over 127.0.0.1, so
// repeat calls skip the cold spawn. It serves the project it was started with; calls for another project
// fall back to a per-call spawn. Local-only; nothing transmitted.
const DAEMON_FILE = process.env.QVTS_DAEMON_FILE || path.join(os.homedir(), ".vts-local", "daemon.json");
const DAEMON_PORT = Number(process.env.QVTS_DAEMON_PORT || 7879);
const daemonRead = () => {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  } catch {
    return null;
  }
};
function httpJson(method, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, timeout: 600000, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
// A daemon that is up AND serving this exact project (else a one-shot must spawn its own server).
async function daemonFor(project) {
  const st = daemonRead();
  if (!st || !st.port) return null;
  try {
    const r = await httpJson("GET", st.port, "/health", null);
    if (r.status === 200 && r.json && r.json.project === (project || null)) return st;
  } catch {
    /* not alive */
  }
  return null;
}

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

// QVTS_THINK controls reasoning models (qwen3, gemma3/4 "thinking"): unset = model default,
// "0"/"false" = think:false (fast deterministic tool-driving — recommended for the locator role),
// "1"/"true" = think:true. Omitted from the body when unset so non-thinking models are unaffected.
const THINK_ENV = process.env.QVTS_THINK;
const THINK = THINK_ENV === undefined ? undefined : /^(1|true|on|yes)$/i.test(THINK_ENV);

async function ollamaChat(messages, tools) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      keep_alive: KEEP_ALIVE,
      ...(THINK !== undefined ? { think: THINK } : {}),
      options: { num_ctx: NUM_CTX, temperature: 0.15 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()).message;
}

// ---- local-model READING/DIGESTING (the "delegate reading, not just searching" axis) -----------------
// A plain (no-tools) chat turn — used by `digest` and `triage-diff`. Reasoning is OFF by default
// (summarization doesn't need it; faster), but an explicit QVTS_THINK still wins.
async function ollamaPlain(system, user) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      keep_alive: KEEP_ALIVE,
      think: THINK !== undefined ? THINK : false,
      options: { num_ctx: NUM_CTX, temperature: 0.15 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return (await res.json()).message?.content || "";
}

function readSource(src) {
  if (!src || src === "-") {
    if (process.stdin.isTTY) throw new Error("no input — pass a file path, or pipe text (or use '-' with a pipe)");
    return fs.readFileSync(0, "utf8"); // stdin
  }
  if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
  return fs.readFileSync(src, "utf8");
}

// `digest`: distill a big artifact into the shortest faithful brief. Map-reduce when it exceeds one window.
const DIGEST_CHUNK = Number(process.env.QVTS_DIGEST_CHUNK || 40000); // ~10k tok/chunk
async function digestText(text, focus) {
  const sys =
    "You are a context distiller. Produce the SHORTEST faithful brief that lets an engineer act WITHOUT " +
    "reading the original. Lead with a one-line gist, then terse bullets (facts, decisions, errors, " +
    "file:line refs, numbers, names). Preserve concrete identifiers/paths/values EXACTLY. No preamble, " +
    "no 'here is', no closing remarks." + (focus ? ` FOCUS on: ${focus}.` : "");
  const chunks = [];
  for (let i = 0; i < text.length; i += DIGEST_CHUNK) chunks.push(text.slice(i, i + DIGEST_CHUNK));
  if (chunks.length <= 1) return (await ollamaPlain(sys, text || "(empty)")).trim();
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stderr.write(`  · digest chunk ${i + 1}/${chunks.length}\n`);
    parts.push((await ollamaPlain(sys + ` (Part ${i + 1}/${chunks.length}.)`, chunks[i])).trim());
  }
  return (await ollamaPlain(sys + " Merge these partial briefs into ONE deduplicated brief.", parts.join("\n\n---\n\n"))).trim();
}

// `triage-diff`: a git diff → strict JSON {summary, hotspots[], open[]} so Claude opens only flagged files.
async function triageDiff(diff) {
  const sys =
    "You are a code-review triage assistant. Given a git diff, output STRICT JSON ONLY (no prose around it): " +
    '{"summary":"<=2 sentences","hotspots":[{"file":"path","why":"short risk"}],"open":["paths worth reading"]}. ' +
    "List only genuinely risky/important files; keep it short.";
  const raw = await ollamaPlain(sys, diff.length > DIGEST_CHUNK ? diff.slice(0, DIGEST_CHUNK) + "\n…(diff truncated)" : diff);
  for (const blob of extractJsonBlobs(raw)) {
    try {
      const o = JSON.parse(blob);
      if (o && (o.summary || o.hotspots || o.open)) return o;
    } catch {
      /* next */
    }
  }
  return { summary: raw.trim().slice(0, 400), hotspots: [], open: [] };
}

const SYSTEM = `You are a code-navigation agent for a software repository (any language — C/C++, C#, JS/TS,
Python, etc.). You have vs-search tools backed by an official language-server index (or tree-sitter when
there is no toolchain). They return COMPACT file:line results, never whole files — trust them and do NOT
ask to read entire files.

Pick the right tool:
- Find a symbol/class/function/type/variable -> search_symbol. Never guess paths.
- Find a file by name -> find_files.
- Who-calls / usages -> find_references. The definition -> goto_definition. One body -> read_symbol.
- Raw strings/comments/config keys the symbol index can't answer -> search_text.

Reporting rules (critical — you are a locator, your job is to REPORT what the tools find):
- When a tool returns a result (a file path, a symbol at file:line), that result is GROUND TRUTH. Report it
  directly. Do NOT run more searches to "double-check" a POSITIVE result, and never overturn a found result
  into "no match".
- Do not invent file paths, line numbers, or symbols. Only report what a tool actually returned.
- Copy search terms from the request EXACTLY, character for character (spelling and case). A typo returns nothing.
- Never call search_text with a catch-all pattern like ".*" — it is meaningless. Use a concrete term.
- If a search genuinely returns no matches twice, STOP and report "no match" — do not keep guessing variants.

FINAL ANSWER FORMAT (strict — your answer goes to another program, not a human):
- Output ONLY the locations, one per line, as \`path:line\` (group several lines of one file as \`path:line1,line2\`).
- NO prose, NO sentences, NO "The function is declared at…", NO markdown headers/bullets, NO code fences,
  NO closing remarks like "Let me know if…". Just the bare \`path:line\` lines.
- If nothing was found, output exactly: no match
- Example of a GOOD final answer:
  config-loader.mjs:40
  agent-core.mjs:14,16`;

async function runAgent(client, toolSchemas, ollamaTools, task, history) {
  const messages = history;
  messages.push({ role: "user", content: task });
  const trace = []; // { tool, args } per call — surfaced in --json so the Claude orchestrator can audit
  const acct = { outTok: 0, rawTok: 0, byTool: {} }; // savings accounting (fed to the ledger by the caller)
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
      return { answer: msg.content || "(no answer)", trace, acct };
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
              acct,
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
          // Savings accounting: what Claude would have eaten for THIS tool result (capped vs raw-grep est.).
          {
            const ot = estTok(resultText);
            const r = RATIOS[name] || RATIOS._global || 1;
            acct.outTok += ot;
            acct.rawTok += ot * r;
            const b = (acct.byTool[name] ||= { calls: 0, outTok: 0, rawTok: 0 });
            b.calls += 1;
            b.outTok += ot;
            b.rawTok += ot * r;
          }
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
                acct,
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
  return { answer: `(stopped: hit ${MAX_STEPS}-step limit without a final answer)`, trace, acct };
}

// One locate: cache-check → run the model on a FRESH history (independent of other queries) → cache-write
// → credit the savings ledger. Shared by the one-shot and the --batch paths. Returns a compact record.
async function locate(client, tools, ollamaTools, query, noCache) {
  const fp = repoFingerprint(PROJECT);
  const cacheable = !noCache && !(fp.head && fp.dirty); // skip cache on a dirty git tree (content in flux)
  const key = cacheKey(MODEL, PROJECT, query);
  let out, trace, acct, cached = false;
  const hit = cacheable ? cacheRead(key, fp) : null;
  if (hit) {
    ({ answer: out, trace, acct } = hit);
    cached = true;
    process.stderr.write(`  · [cache hit] ${query}\n`);
  } else {
    const history = [{ role: "system", content: SYSTEM }];
    const r = await runAgent(client, tools, ollamaTools, query, history);
    out = relAnswer(r.answer);
    trace = r.trace;
    acct = r.acct;
    if (cacheable) cacheWrite(key, fp, { answer: out, trace, acct });
  }
  const savings = recordSavings(acct, out); // credited even on a cache hit (Claude avoided the cost again)
  return { q: query, answer: out, trace, cached, savings };
}

async function main() {
  // `qvts --savings` just prints the cumulative ledger — no model, no MCP server needed.
  if (process.argv.includes("--savings")) {
    process.stdout.write(savingsReport() + "\n");
    return;
  }

  // Reading-delegation subcommands — local model only, NO vs-search server needed.
  const rawArgs = process.argv.slice(2);
  const sub = rawArgs[0];
  // NOTE: the qvts.sh wrapper consumes --json into QVTS_JSON env, so check both.
  const wantJson = process.argv.includes("--json") || /^(1|true|on|yes)$/i.test(process.env.QVTS_JSON || "");

  // qvts digest <file|-> [--focus "..."]  — distill a big artifact into a compact brief.
  if (sub === "digest") {
    const fi = rawArgs.indexOf("--focus");
    const focus = fi !== -1 ? rawArgs[fi + 1] || "" : "";
    const srcArg = rawArgs.slice(1).find((a) => a !== "--json" && a !== "--focus" && a !== focus);
    let text;
    try {
      text = readSource(srcArg);
    } catch (e) {
      process.stderr.write(`digest: ${e.message}\n`);
      process.exit(2);
    }
    const noCache = process.argv.includes("--no-cache");
    const ch = sha1(text);
    let brief, cached = false;
    const hit = noCache ? null : contentCacheGet("digest", ch, focus);
    if (hit) {
      brief = hit.brief;
      cached = true;
      process.stderr.write("  · [cache hit] (no model run)\n");
    } else {
      brief = await digestText(text, focus);
      if (!noCache) contentCachePut("digest", ch, focus, { brief });
    }
    const origTok = estTok(text);
    const savings = recordSavings(
      { outTok: origTok, rawTok: origTok, byTool: { digest: { calls: 1, outTok: origTok, rawTok: origTok } } },
      brief,
    );
    if (wantJson) process.stdout.write(JSON.stringify({ mode: "digest", source: srcArg || "(stdin)", brief, savings, cached }) + "\n");
    else process.stdout.write("\n" + brief + "\n");
    return;
  }

  // qvts triage-diff [<file>|--staged|-]  — local model triages a git diff to {summary,hotspots,open}.
  if (sub === "triage-diff" || sub === "triage") {
    const staged = process.argv.includes("--staged");
    const fileArg = rawArgs.slice(1).find((a) => a !== "--json" && a !== "--staged");
    let diff = "";
    try {
      if (fileArg) diff = readSource(fileArg);
      else diff = execSync(`git ${staged ? "diff --staged" : "diff"}`, { cwd: PROJECT || process.cwd(), maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch (e) {
      process.stderr.write(`triage-diff: could not read a diff (${e.message}). Pass a file, '-', or run inside a git repo.\n`);
      process.exit(2);
    }
    if (!diff.trim()) {
      process.stdout.write((wantJson ? JSON.stringify({ mode: "triage-diff", summary: "no changes", hotspots: [], open: [] }) : "no changes") + "\n");
      return;
    }
    const noCache = process.argv.includes("--no-cache");
    let t = noCache ? null : contentCacheGet("triage", sha1(diff), "");
    if (t) process.stderr.write("  · [cache hit] (no model run)\n");
    else {
      t = await triageDiff(diff);
      if (!noCache) contentCachePut("triage", sha1(diff), "", t);
    }
    const origTok = estTok(diff);
    const savings = recordSavings(
      { outTok: origTok, rawTok: origTok, byTool: { triage: { calls: 1, outTok: origTok, rawTok: origTok } } },
      JSON.stringify(t),
    );
    if (wantJson) process.stdout.write(JSON.stringify({ mode: "triage-diff", ...t, savings }) + "\n");
    else {
      process.stdout.write(`\n${t.summary}\n`);
      if (t.hotspots?.length) process.stdout.write("hotspots:\n" + t.hotspots.map((h) => `  ${h.file} — ${h.why}`).join("\n") + "\n");
      if (t.open?.length) process.stdout.write("open:\n" + t.open.map((f) => `  ${f}`).join("\n") + "\n");
    }
    return;
  }

  // qvts daemon start|stop|status — warm-session manager (keeps one vs-search index hot across calls).
  if (sub === "daemon") {
    const action = rawArgs[1] || "status";
    if (action === "stop") {
      const st = daemonRead();
      if (st?.pid) {
        try {
          process.kill(st.pid);
        } catch {
          /* already gone */
        }
      }
      try {
        fs.rmSync(DAEMON_FILE);
      } catch {
        /* ignore */
      }
      process.stdout.write("daemon stopped\n");
      return;
    }
    if (action === "start") {
      if (await daemonFor(PROJECT)) {
        process.stdout.write("daemon already running for this project\n");
        return;
      }
      const child = spawn(process.execPath, [process.argv[1]], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, QVTS_DAEMON_SERVE: "1", VTS_PROJECT: PROJECT || "" },
      });
      child.unref();
      process.stdout.write(`daemon starting on 127.0.0.1:${DAEMON_PORT} for ${PROJECT || "(cwd)"}\n`);
      return;
    }
    const st = await daemonFor(PROJECT);
    process.stdout.write(st ? `daemon up: 127.0.0.1:${st.port} · project ${st.project} · pid ${st.pid}\n` : "daemon: not running for this project\n");
    return;
  }

  // Auto-route a one-shot to a warm daemon for this project (skip the per-call server spawn). The daemon
  // is OPTIONAL: if none is up, control falls through to the normal per-call path below. --no-daemon opts out.
  if (sub !== "daemon" && !process.env.QVTS_DAEMON_SERVE && !process.argv.includes("--no-daemon")) {
    const oneShotEarly = rawArgs.filter((a) => !["--json", "--no-cache", "--no-daemon", "--savings"].includes(a)).join(" ").trim();
    if (oneShotEarly) {
      const st = await daemonFor(PROJECT);
      if (st) {
        const r = await httpJson("POST", st.port, "/locate", { query: oneShotEarly, noCache: process.argv.includes("--no-cache") });
        if (r.status === 200 && r.json) {
          if (wantJson) process.stdout.write(JSON.stringify({ task: oneShotEarly, answer: r.json.answer, trace: r.json.trace, savings: r.json.savings, cached: r.json.cached, viaDaemon: true }) + "\n");
          else process.stdout.write("\n" + r.json.answer + "\n");
          return;
        }
      }
    }
  }

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
  const client = new Client({ name: "vts-local-bridge", version: "0.1.0" }, { capabilities: {} });
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

  // Daemon serve mode: hold this warm MCP+model session and answer locates over 127.0.0.1 until killed.
  if (process.env.QVTS_DAEMON_SERVE) {
    let chain = Promise.resolve(); // serialize requests over the shared session
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, project: PROJECT || null, model: MODEL }));
      }
      if (req.method === "POST" && req.url === "/locate") {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
          chain = chain.then(async () => {
            try {
              const { query, noCache } = JSON.parse(b || "{}");
              const r = await locate(client, tools, ollamaTools, String(query || ""), !!noCache);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(r));
            } catch (e) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("error", (e) => {
      process.stderr.write(`vts-local daemon: cannot listen on 127.0.0.1:${DAEMON_PORT} — ${e.message}\n`);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
    server.listen(DAEMON_PORT, "127.0.0.1", () => {
      try {
        fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true });
        fs.writeFileSync(DAEMON_FILE, JSON.stringify({ pid: process.pid, port: DAEMON_PORT, project: PROJECT || null }));
      } catch {
        /* ignore */
      }
      process.stderr.write(`vts-local daemon on 127.0.0.1:${DAEMON_PORT} (project ${PROJECT})\n`);
    });
    const cleanup = () => {
      try {
        fs.rmSync(DAEMON_FILE);
      } catch {
        /* ignore */
      }
      try {
        client.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    return; // stay resident; do not fall through to one-shot/REPL
  }

  const history = [{ role: "system", content: SYSTEM }];
  const JSON_OUT = /^(1|true|on|yes)$/i.test(process.env.QVTS_JSON || "");
  const noCache = process.argv.includes("--no-cache");

  // --batch '["q1","q2",...]' (inline JSON, a file path, or - for stdin): run many locates over ONE warm
  // MCP connection + warm model, return a single {results:[…]} map. Cache + ledger apply per query.
  const bi = process.argv.indexOf("--batch");
  if (bi !== -1) {
    let raw = process.argv[bi + 1] || "";
    try {
      if (raw === "-") raw = fs.readFileSync(0, "utf8");
      else if (raw && fs.existsSync(raw)) raw = fs.readFileSync(raw, "utf8");
    } catch {
      /* fall through: treat as inline JSON */
    }
    let queries;
    try {
      queries = JSON.parse(raw);
    } catch {
      process.stderr.write("--batch needs a JSON array of strings (inline, a file path, or - for stdin)\n");
      await client.close();
      process.exit(2);
    }
    if (!Array.isArray(queries)) {
      process.stderr.write("--batch payload must be a JSON array of query strings\n");
      await client.close();
      process.exit(2);
    }
    // Bounded-concurrency pool: overlap each query's tool round-trips + generation. One GPU serializes
    // generation, so the default is modest (2); raise QVTS_CONCURRENCY if Ollama has spare parallelism.
    const conc = Math.max(1, Number(process.env.QVTS_CONCURRENCY || 2));
    const results = new Array(queries.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(conc, queries.length) }, async () => {
        for (let i = next++; i < queries.length; i = next++) {
          // Isolate per-query failures so one bad query can't reject the whole batch.
          try {
            results[i] = await locate(client, tools, ollamaTools, String(queries[i]), noCache);
          } catch (e) {
            results[i] = { q: String(queries[i]), answer: `(error: ${e.message})`, trace: [], cached: false, error: true };
          }
        }
      }),
    );
    process.stdout.write(JSON.stringify({ batch: true, results }) + "\n");
    await client.close();
    return;
  }

  const FLAGS = new Set(["--json", "--savings", "--no-cache"]);
  const argv = process.argv.slice(2).filter((a) => !FLAGS.has(a));
  if (process.argv.includes("--json")) process.env.QVTS_JSON = "1";
  const oneShot = argv.join(" ").trim();

  if (oneShot) {
    const { answer: out, trace, savings, cached } = await locate(client, tools, ollamaTools, oneShot, noCache);
    if (JSON_OUT || process.env.QVTS_JSON === "1") {
      process.stdout.write(JSON.stringify({ task: oneShot, answer: out, trace, savings, cached }) + "\n");
    } else {
      process.stdout.write("\n" + out + "\n");
    }
    await client.close();
    return;
  }

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("vts-local agent — ask about the codebase, Ctrl-C to quit.\n");
  rl.setPrompt("qvts> ");
  rl.prompt();
  rl.on("line", async (line) => {
    const task = line.trim();
    if (!task) return rl.prompt();
    if (/^(exit|quit|:q)$/i.test(task)) return rl.close();
    try {
      const { answer, acct } = await runAgent(client, tools, ollamaTools, task, history);
      const out = relAnswer(answer);
      recordSavings(acct, out);
      process.stdout.write("\n" + out + "\n\n");
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
