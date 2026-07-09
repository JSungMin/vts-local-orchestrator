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
import { loadConfig, clangdIndexUsable, clangdIndexState, dynamicTextTimebox, hasSyntacticIndex } from "./config-loader.mjs";
import { definitionSearches, detectLang, rankHits } from "./defn-patterns.mjs";
import { buildSystem } from "./system-prompt.mjs";
import { logActivity } from "./activity-log.mjs";
import { recordLspOutcome, lspVerdict, LSP_TRACK } from "./lsp-stats.mjs";
// SHARED answer/tool-call helpers — single source of truth with vts-bridge.mjs (the CLI path) so the two
// never drift again. Brings the gemma bare-call parser + the full final-answer pipeline (fabrication guard,
// control-token strip, normalise, group) the dashboard was previously missing. See answer-pipeline.mjs.
import { parseToolCallsFromText, salvageLocs, finalizeAnswer, detectComplexQuery } from "./answer-pipeline.mjs";

const CFG = loadConfig();
const OLLAMA_HOST = CFG.ollamaHost;
const MODEL = CFG.model;
const VTS_SERVER = CFG.vtsServer;
const MAX_STEPS = CFG.maxSteps;
const NUM_CTX = CFG.numCtx;
const ANSWER_RESERVE = Number(process.env.QVTS_ANSWER_RESERVE || 2048); // ctx tokens kept free for the final answer
const CTX_KEEP_RECENT = Number(process.env.QVTS_CTX_KEEP_RECENT || 4);  // most-recent tool results kept in full

const DEFAULT_TOOLS = new Set([
  "search_symbol", "find_references", "goto_definition", "hover",
  "document_symbols", "read_symbol", "search_text", "find_files",
  "concept_search", "diagnostics",
]);

// SYSTEM prompt shared with vts-bridge.mjs via system-prompt.mjs (inline copies had drifted).
const SYSTEM = buildSystem({ lang: detectLang(readProjectPath()) });

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
// When ONLY the split-root cluster has a syntactic symbol index, route symbol queries to it (engine symbols
// resolve even when scoped to the game sub-project). createAgent sets this. Mirrors vts-bridge.mjs.
let SYMBOL_ROOT_OVERRIDE = null;
const SYMBOL_INDEX_TOOLS = new Set(["search_symbol", "document_symbols", "find_references", "read_symbol"]); // find_references: the server (vts ≥0.42.7) answers it from the committed index + decl-file usage scan on crawl-risk trees, so it needs the CLUSTER root too — scoped to the game sub-project it can't see an engine-side symbol at all (live: who-calls dead-ended while the decl+callers sat one level up).
function injectProject(toolSchema, args, project) {
  if (!project) return args;
  const props = toolSchema?.inputSchema?.properties || {};
  const root = (SYMBOL_ROOT_OVERRIDE && SYMBOL_INDEX_TOOLS.has(toolSchema?.name)) ? SYMBOL_ROOT_OVERRIDE : project;
  for (const k of ROOT_ARGS) {
    // ALWAYS override — the model must not choose the project root (it emits placeholders like
    // "<your-project-path>" or wrong paths). The bridge knows the real target; force it.
    if (k in props) {
      args[k] = root;
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
    let drop = false;
    try {
      const abs = path.isAbsolute(v) ? v : path.join(project || process.cwd(), v);
      if (fs.statSync(abs).isDirectory()) drop = true; // a dir scopes to nothing
    } catch {
      if (!/[*?[\]]/.test(v)) drop = true; // nonexistent + not a glob = a path the model invented → drop
    }
    if (drop) delete args[k];
  }
  return args;
}

// extractJsonBlobs / parseToolCallsFromText now live in the shared answer-pipeline.mjs (imported above) —
// the imported parser adds gemma bare-call recovery the local copy lacked.

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

// Split-root / cluster widening — a PROJECT-scoped scan misses an ENGINE/sibling-package declaration that
// lives outside PROJECT (UE `<root>/{Engine, Game}`, monorepo `<root>/{pkgA, pkgB}`). widenRoot returns the
// cluster root so a dry scan can retry across it. Specific heuristic (real Engine sibling / workspace marker)
// so it never climbs into an umbrella folder of unrelated repos. Mirrors vts-bridge.mjs. Disable: QVTS_WIDEN=0.
function isUnrealRoot(dir) {
  try {
    const eng = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && /^engine$/i.test(e.name));
    if (!eng) return false;
    const ep = path.join(dir, eng.name);
    return ["Source", "Build", "Binaries"].some((s) => { try { return fs.statSync(path.join(ep, s)).isDirectory(); } catch { return false; } });
  } catch { return false; }
}
function isWorkspaceRoot(dir) {
  for (const f of ["pnpm-workspace.yaml", "lerna.json", "go.work", "nx.json", "turbo.json", "rush.json"]) {
    try { if (fs.statSync(path.join(dir, f)).isFile()) return true; } catch { /* none */ }
  }
  try { if (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).workspaces) return true; } catch { /* none */ }
  try { if (/^\s*\[workspace\]/m.test(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"))) return true; } catch { /* none */ }
  return false;
}
function widenRoot(project) {
  if (!project || /^(0|false|off|no)$/i.test(process.env.QVTS_WIDEN || "")) return null;
  let cur = path.resolve(project);
  for (let i = 0; i < 2; i++) { // immediate parent + grandparent only — never walk to the fs/umbrella root
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    if (isUnrealRoot(parent) || isWorkspaceRoot(parent)) return parent;
    cur = parent;
  }
  return null;
}

// def_search — synthetic deterministic declaration locator over search_text (see vts-bridge.mjs). Tries the
// language's definition regexes in priority order and returns the first that matches.
const TIME_BOXED = /time-box hit|time-boxed|NOT conclusive|INCONCLUSIVE/i;
// Strip search_text's model-facing chrome (steer / completeness cert / log hint / savings line) — inside
// def_search it's pure context waste; we want just the declaration hits. Mirrors vts-bridge.mjs.
function stripVtsChrome(text) {
  return String(text)
    .split("\n")
    .filter((l) => !/^↪ /.test(l) && !/^\[completeness:/.test(l) && !/Looking for something in a LOG\?/.test(l) && !/^✓ Saved/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
async function defSearch(client, args, project) {
  const sym = String(args.name || args.symbol || args.q || "").trim();
  if (!sym) return "def_search needs a 'name' (the symbol/type/function to locate the declaration of).";
  const lang = (args.lang && String(args.lang).toLowerCase()) || detectLang(project) || "";
  const cands = definitionSearches(sym, lang || undefined);
  // Combined-walk: run SPECIFIC patterns together in one search so class AND field both surface (ranked),
  // instead of the first match preempting. BARE-name pattern excluded from the combine (floods), broad fallback
  // only when specific find nothing. Mirrors vts-bridge.mjs.
  const BROAD = new Set(["function-decl", "callable", "method"]);
  const specific = cands.filter((c) => !BROAD.has(c.kind));
  const broad = cands.filter((c) => BROAD.has(c.kind));
  const sourceRoot = () => {
    for (const d of ["Source", "source", "src"]) {
      try { const p = path.join(project, d); if (fs.statSync(p).isDirectory()) return p; } catch { /* none */ }
    }
    return null;
  };
  const HIT_RE = /^\s*(.+?):(\d+):\s?(.*)$/;
  const parseHits = (out) => {
    const hits = [];
    for (const l of stripVtsChrome(out).split("\n")) {
      const m = HIT_RE.exec(l);
      if (!m) continue;
      let candIdx = specific.length, kind = "decl", headerish = false;
      for (let i = 0; i < specific.length; i++) {
        try { if (new RegExp(specific[i].q).test(m[3])) { candIdx = i; kind = specific[i].kind; headerish = specific[i].headerish; break; } } catch { /* skip */ }
      }
      hits.push({ file: m[1], line: Number(m[2]), text: m[3], candIdx, kind, headerish });
    }
    return hits;
  };
  // Optional `glob` narrows the walk by extension — the cluster WIDEN uses it to scan only headers so a giant
  // engine tree doesn't make the vs-search server walk every file and crash. Mirrors vts-bridge.mjs.
  const runCombined = async (patterns, root, glob) => {
    if (!patterns.length) return { hits: [], timeBoxed: false };
    const q = patterns.map((c) => `(?:${c.q})`).join("|");
    const callArgs = { q, projectPath: root };
    if (glob) callArgs.glob = glob;
    let out;
    try {
      const r = await client.callTool({ name: "search_text", arguments: callArgs });
      out = (r.content || []).map((x) => (x.type === "text" ? x.text : JSON.stringify(x))).join("\n");
      if (r.isError) return { hits: [], timeBoxed: false };
    } catch { return { hits: [], timeBoxed: false }; }
    return { hits: parseHits(out), timeBoxed: TIME_BOXED.test(out) };
  };
  const WIDEN_GLOB = process.env.QVTS_WIDEN_GLOB ?? ((lang === "cpp" || lang === "c") ? "*.h" : null);
  const format = (hits, note) => {
    const ranked = rankHits(hits).slice(0, 8);
    const kinds = [...new Set(ranked.map((h) => h.kind))].join(", ");
    return `def_search(${sym}, lang=${lang || "auto"}) — ${ranked.length} decl candidate(s) [${kinds}]${note ? ` ${note}` : ""}:\n` +
      ranked.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
  };
  // A broad (bare-name) hit reading `obj.Name(` / `ptr->Name(` is a CALL SITE, not a declaration. Drop call
  // sites so an engine function whose only project hits are calls doesn't masquerade as a def — and so the
  // widen below can fire to find the real engine decl. Mirrors vts-bridge.mjs.
  const reSym = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isCallSite = (t) => new RegExp(`(?:\\.|->)\\s*${reSym}\\s*\\(`).test(t);
  const declOnly = (hits) => hits.filter((h) => !isCallSite(h.text));
  // SPLIT-ROOT widen: no real decl under PROJECT → retry across the cluster root (Engine/sibling packages).
  // SPECIFIC first (real engine decl beats a game call site), then declOnly(broad). Mirrors vts-bridge.mjs.
  const wider = widenRoot(project);
  const tryWider = async () => {
    if (!wider) return null;
    const rs = await runCombined(specific, wider, WIDEN_GLOB);
    let hits = rs.hits;
    if (!hits.length && !rs.timeBoxed && broad.length) hits = declOnly((await runCombined(broad, wider, WIDEN_GLOB)).hits);
    return hits.length ? format(hits, `— in the wider cluster root (outside ${path.basename(project)}; likely engine/shared)`) : null;
  };
  let r = await runCombined(specific, project);
  if (r.hits.length) return format(r.hits);
  if (r.timeBoxed) {
    const src = sourceRoot();
    if (src) {
      const r2 = await runCombined(specific, src);
      if (r2.hits.length) return format(r2.hits);
      if (r2.timeBoxed) return `inconclusive — def_search(${sym}) scans timed out even scoped to ${src}; narrow further or raise QVTS_TEXT_TIMEBOX_MS (do NOT treat as absent).`;
      const rb2 = declOnly((await runCombined(broad, src)).hits);
      if (rb2.length) return format(rb2);
      const w1 = await tryWider();
      if (w1) return w1;
      return `no match — def_search(${sym}) found nothing under ${src} (scoped scan COMPLETE, authoritative)${wider ? " or in the wider cluster root" : ""}.`;
    }
    return `inconclusive — def_search(${sym}) tree scan timed out; pass a narrower projectPath (do NOT treat as absent).`;
  }
  const rb = declOnly((await runCombined(broad, project)).hits);
  if (rb.length) return format(rb);
  const w = await tryWider();
  if (w) return w;
  return `no match — def_search(${sym}) tried ${cands.length} definition pattern(s) for lang=${lang || "auto"} (scan COMPLETE, authoritative)${wider ? `, including the wider cluster root ${wider}` : ""}.`;
}

// Keep the accumulated agent history inside the LOCAL model's context window, reserving room for the final
// answer. A multi-symbol task piles up tool results until the prompt approaches num_ctx and the final answer
// is STARVED (cut off mid-token). Keep system + task + the most-recent CTX_KEEP_RECENT tool results in full and
// compact OLDER tool results to a short stub. Pairing-safe: only tool-role CONTENT is shortened, never removed.
function fitContext(messages, tools) {
  const toolsTok = estTok(JSON.stringify(tools || []));
  const budget = Math.max(2000, NUM_CTX - ANSWER_RESERVE - toolsTok);
  let total = messages.reduce((n, m) => n + estTok(m.content || "") + 8, 0);
  if (total <= budget) return messages;
  const out = messages.map((m) => ({ ...m }));
  const toolIdx = out.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const STUB = " …[older result elided to fit the local context window; rely on the results still shown and give your FINAL answer]";
  for (let k = 0; k < toolIdx.length - CTX_KEEP_RECENT && total > budget; k++) {
    const i = toolIdx[k];
    const cur = out[i].content || "";
    if (cur.length <= 200) continue;
    const before = estTok(cur);
    out[i] = { ...out[i], content: cur.slice(0, 200) + STUB };
    total -= before - estTok(out[i].content);
  }
  return out;
}

// Streamed /api/chat. Calls onDelta(text) per token chunk; resolves with the assembled message + timing.
async function ollamaChatStream(messages, tools, onDelta) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: fitContext(messages, tools),
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
  const NARROW_SOFT = /^soft$/i.test(process.env.QVTS_AUTO_NARROW || "");
  const INDEX_USABLE = clangdIndexUsable(project);
  // UPFRONT: C/C++ with no compile_commands.json ("none") OR a DB too big for clangd ("toobig") → symbol tools
  // can't serve it → drop from the start (mirror of vts-bridge). soft = legacy try-path; circuit = ambiguous.
  const IDX_STATE = clangdIndexState(project);
  const NO_INDEX = !NARROW_OFF && !NARROW_SOFT && (IDX_STATE === "none" || IDX_STATE === "toobig");
  const FAST_FAIL = !INDEX_USABLE && NARROW_SOFT;
  // Syntactic (tree-sitter) symbol index — answers search_symbol/document_symbols with no clangd. Mirrors
  // vts-bridge.mjs: keep those tools when one exists, and route symbol queries to the cluster index if only it
  // has one (engine symbols resolve from a game sub-project).
  const _wider = widenRoot(project);
  const SYN_AT_PROJECT = hasSyntacticIndex(project);
  const SYN_AT_CLUSTER = _wider ? hasSyntacticIndex(_wider) : false;
  const HAS_SYN = SYN_AT_PROJECT || SYN_AT_CLUSTER;
  SYMBOL_ROOT_OVERRIDE = (SYN_AT_CLUSTER && !SYN_AT_PROJECT) ? _wider : null;
  // LSP circuit breaker (learned per project across runs; see lsp-stats / vts-bridge.mjs). Mirror.
  const LSP_VERDICT = NARROW_OFF ? { circuitOpen: false, suggestedTimeoutMs: null } : lspVerdict(project);
  const CIRCUIT_OPEN = LSP_VERDICT.circuitOpen;
  const LSP_TIMEOUT = process.env.VTS_LSP_TIMEOUT_MS ?? (LSP_VERDICT.suggestedTimeoutMs ? String(LSP_VERDICT.suggestedTimeoutMs) : ((FAST_FAIL || NO_INDEX || CIRCUIT_OPEN) ? (process.env.QVTS_FASTFAIL_TIMEOUT_MS || "4000") : "30000"));
  const LSP_INDEX_WAIT = process.env.VTS_LSP_INDEX_WAIT_MS ?? ((FAST_FAIL || CIRCUIT_OPEN || NO_INDEX) ? "2000" : "15000");
  // Text-walk budget (search_text/find_files). Longer when the LSP tier is fast-failing (unindexed C/C++) so a
  // giant tree's text scan finishes instead of false-negative-aborting at vs-token-safer's 4s default. DYNAMIC:
  // size to the tree (cheap bounded count, 12s→24s→40s); size against the split-root cluster (widenRoot) since
  // def_search may scan the whole cluster. Explicit VTS_/QVTS_TEXT_TIMEBOX_MS pins it. Mirrors vts-bridge.mjs.
  let TEXT_TIMEBOX;
  if (process.env.VTS_TEXT_TIMEBOX_MS != null) TEXT_TIMEBOX = process.env.VTS_TEXT_TIMEBOX_MS;
  else if (process.env.QVTS_TEXT_TIMEBOX_MS) TEXT_TIMEBOX = process.env.QVTS_TEXT_TIMEBOX_MS;
  else if (FAST_FAIL || NO_INDEX || CIRCUIT_OPEN) TEXT_TIMEBOX = String(dynamicTextTimebox(widenRoot(project) || project).ms);
  else TEXT_TIMEBOX = "4000";
  const toolsSpec = process.env.QVTS_TOOLS || CFG.tools;
  let requested;
  if (toolsSpec) {
    requested = toolsSpec.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    requested = [...DEFAULT_TOOLS];
    // Only HARD mode drops the clangd-backed tools; SOFT/OFF keep them (soft relies on the short timeouts).
    // A syntactic index keeps search_symbol/document_symbols/read_symbol (tree-sitter tier). Mirrors vts-bridge.
    if ((NARROW_HARD && !INDEX_USABLE) || CIRCUIT_OPEN || NO_INDEX) {
      // KEEP only the tools the server pre-empts from the syntactic index with NO clangd: search_symbol
      // (committed-index decl) and find_references (time-boxed usage + committed decl). document_symbols and
      // read_symbol have no syntactic backend — they route to clangd's AST and fail `-32602: AST for
      // non-added document` on an unindexed tree — so they drop with the rest. Mirrors vts-bridge.mjs (this
      // previously also DROPPED find_references, dead-ending who-calls on syntactic trees — now fixed).
      const SYN_OK = new Set(["search_symbol", "find_references"]);
      const dropSet = HAS_SYN ? new Set([...INDEX_TOOLS].filter((t) => !SYN_OK.has(t))) : INDEX_TOOLS;
      requested = requested.filter((n) => !dropSet.has(n));
    }
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
    env: { ...process.env, VTS_PREWARM: process.env.VTS_PREWARM ?? "0", VTS_AUTO_LEARN: process.env.VTS_AUTO_LEARN ?? "0", VTS_CLANGD_BG_INDEX: process.env.VTS_CLANGD_BG_INDEX ?? "0", VTS_LSP_INDEX_WAIT_MS: LSP_INDEX_WAIT, VTS_LSP_TIMEOUT_MS: LSP_TIMEOUT, VTS_TEXT_TIMEBOX_MS: TEXT_TIMEBOX },
    stderr: "ignore",
  });
  const client = new Client({ name: "vts-local-dashboard", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  // Orphan guard: the vs-search server is a CHILD process. close() tears it down on the graceful path (the
  // dashboard's SIGINT/SIGTERM handler calls it); this 'exit' handler covers a crash / uncaught throw so the
  // server (and its clangd) doesn't linger after the dashboard dies. (An uncatchable SIGKILL is handled server-
  // side by exiting on stdin EOF.)
  try { const sp = transport.pid ?? transport._process?.pid; if (sp) process.on("exit", () => { try { process.kill(sp, "SIGKILL"); } catch { /* already gone */ } }); } catch { /* optional */ }

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

  async function runInner(task) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: task }];
    const trace = [];
    const executed = new Map();
    let dupCount = 0, unproductive = 0, malformedRetries = 0;
    const t0 = Date.now();
    // Final-answer treatment shared with the CLI path: control-token strip → note peel → normalise →
    // fabrication guard (drop path:line not present in any tool result) → prefix strip → group per file.
    const finalize = (raw) => finalizeAnswer(raw, [...executed.values()], project);
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
        // Content that LOOKS like a tool call (a valid tool name glued to a brace blob) but survived no parser
        // pass is a MALFORMED emission, not an answer — returning it verbatim ships a raw call string as the
        // "answer". Give bounded corrective retries instead (mirror of vts-bridge's malformedRetries).
        const looksCall = /^\s*([A-Za-z_]\w*)\s*:?\s*\{/.exec(msg.content || "");
        if (looksCall && validNames.has(looksCall[1]) && malformedRetries++ < 2) {
          messages.push({ role: "user", content: `Your last message looks like a ${looksCall[1]} tool call but it was MALFORMED and was NOT executed. Emit it again as a proper tool call with valid JSON arguments — or give your final answer as path:line lines.` });
          continue;
        }
        // Empty final content (model ran a tool then gave no answer — common when a query is too complex for
        // the small model): salvage the locations already sitting in the tool results instead of shipping a
        // silent "(no answer)". Only falls back when the model produced no real text of its own.
        const finalRaw = (msg.content && msg.content.trim()) ? msg.content : (salvageLocs(executed) || "(no answer)");
        const fin = finalize(finalRaw);
        const ans = fin.answer || "no match";
        const stats = { ms: Date.now() - t0, evalCount: totalEval, tokPerSec: totalEvalMs ? +(totalEval / (totalEvalMs / 1000)).toFixed(1) : 0, steps: step + 1, savings: savings(ans) };
        onEvent({ type: "final", answer: ans, note: fin.note, trace, stats });
        return { answer: ans, note: fin.note, trace, stats };
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
              const ans = finalize(salvageLocs(executed) || "(stopped: looped on def_search.)").answer;
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
                const ans = finalize(salvageLocs(executed) || "(stopped: no results after 4 tries.)").answer;
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
              const ans = finalize(salvageLocs(executed) || "(stopped: model looped on the same failing call.)").answer;
              const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: step + 1, savings: savings(ans) };
              onEvent({ type: "stopped", reason: "looped on identical call", trace, stats });
              return { answer: ans, trace, stats };
            }
          } else {
            dupCount = 0;
            onEvent({ type: "tool_call", tool: name, args, dup: false });
            const _t0 = Date.now();
            try {
              const out = await client.callTool({ name, arguments: args });
              resultText = (out.content || []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
              if (out.isError) { resultText = `TOOL ERROR:\n${resultText}`; ok = false; }
            } catch (e) { resultText = `TOOL EXCEPTION: ${e.message}`; ok = false; }
            // LSP circuit-breaker ledger (mirror of vts-bridge): record whether this index-backed tool worked.
            if (LSP_TRACK.has(name)) {
              recordLspOutcome(project, name, !/^TOOL E|timed out|workspace\/symbol|not ready|no .*index/i.test(resultText), Date.now() - _t0, /no compile_commands|needs compile_commands|no usable index/i.test(resultText));
            }
            executed.set(sig, resultText);
            const ot = estTok(resultText);
            outTokSum += ot;
            rawTokSum += ot * (ratios[name] || ratios._global || 1);
            if (isEmptyResult(resultText)) {
              unproductive++;
              if (unproductive >= 4) {
                onEvent({ type: "tool_result", tool: name, ok: false, text: resultText });
                const ans = finalize(salvageLocs(executed) || "(stopped: no results after 4 tries — likely misspelled or absent.)").answer;
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
    const ans = finalize(salvageLocs(executed) || `(stopped: ${MAX_STEPS}-step limit)`).answer;
    const stats = { ms: Date.now() - t0, evalCount: totalEval, steps: MAX_STEPS, savings: savings(ans) };
    onEvent({ type: "stopped", reason: `hit ${MAX_STEPS}-step limit`, trace, stats });
    return { answer: ans, trace, stats };
  }

  // Wrap runInner so EVERY dashboard run (final or stopped — all return {answer,trace,stats}) is recorded on
  // the shared activity bus, the same one the CLI/daemon/hook write to, for the dashboard's project>kind>run tree.
  async function run(task) {
    // Complex multi-part query → the small model would ramble a prose note or "(no answer)". Hand back a
    // decomposition hint WITHOUT burning a model run; surfaced as the final answer for the dashboard.
    const cx = detectComplexQuery(task);
    if (cx.complex) {
      const stats = { ms: 0, evalCount: 0, steps: 0 };
      onEvent({ type: "final", answer: cx.hint, trace: [], stats });
      logActivity({ project, kind: "locate", via: "dashboard", task, result: cx.hint, ms: 0, tools: [] });
      return { answer: cx.hint, trace: [], stats };
    }
    const r = await runInner(task);
    const tn = (r.trace || []).map((t) => t.tool);
    logActivity({
      project, kind: tn[0] === "def_search" ? "def_search" : "locate", via: "dashboard", task,
      result: r.answer, ms: r.stats && r.stats.ms, savings: r.stats && r.stats.savings, tools: tn,
    });
    return r;
  }

  return { run, project, model: MODEL, tools: tools.map((t) => t.name), close: () => client.close() };
}
