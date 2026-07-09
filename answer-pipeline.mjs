/*
 * answer-pipeline.mjs — SHARED single-source-of-truth for the local-LLM answer/tool-call helpers used by
 * BOTH the CLI path (vts-bridge.mjs) and the web-dashboard path (agent-core.mjs). These were duplicated
 * inline in each file "on purpose" and DRIFTED: agent-core shipped the pre-gemma tool-call parser and NONE
 * of the final-answer verification/normalization pipeline, so the dashboard rendered unverified (potentially
 * fabricated) locations and leaked gemma control tokens. Extracting them here kills the drift class: fix a
 * helper once, both paths get it.
 *
 * Pure functions only (no module-level state) — `relAnswer` takes the project root as an argument instead of
 * reading a file-global, so either caller can pass its own PROJECT/project.
 */

// Extract balanced {...} / [...] JSON blobs embedded in free text (one level of nesting tracking).
export function extractJsonBlobs(text) {
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
export function parseToolCallsFromText(content, validNames) {
  if (!content) return [];
  const tagged = [];
  for (const m of String(content).matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) tagged.push(m[1]);
  for (const m of String(content).matchAll(/```(?:json|tool_call)?\s*([\s\S]*?)```/g)) tagged.push(m[1]);
  const sources = tagged.length ? tagged : [content];
  const calls = [];
  const seen = new Set();
  // Prefer the STRUCTURED forms first — a {name,arguments} blob inside a <tool_call> tag, a ```json fence, or
  // bare in the content. Only if none parse do we fall back to the gemma bare-call form below; otherwise a
  // final-answer line that merely reads `tool_name {json}` would preempt a real tagged/fenced call.
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
  if (calls.length) return calls;
  // gemma-style BARE calls (FALLBACK): `tool_name {json-args}` as plain text — no {name,arguments} wrapper,
  // no tags, no fence. Seen live twice in one day: the model printed the call as its final content, the
  // structured pass missed it (the JSON blob has no `name` field), and the raw call text shipped as the
  // "answer". Per-line so several stacked calls all parse; only exact valid tool names match, so prose is
  // immune. Runs only when no structured call was found, so it can't hijack a legitimate tagged/fenced call.
  for (const line of String(content).split("\n")) {
    // Accept an optional colon after the tool name: gemma sometimes emits `search_text: {json}` (label form)
    // in addition to the bare `search_text {json}`. Without the `:?` the colon form parsed as neither a call
    // nor an answer and leaked the raw call string as the "answer" (live dogfood: `search_text: {"q":"…"}`).
    const m = /^\s*([A-Za-z_]\w*)\s*:?\s*(\{.*\})\s*$/.exec(line);
    if (!m || !validNames.has(m[1])) continue;
    // gemma emission repair: literal quote tokens (`<|"|>`) leak into the text form, and keys can arrive
    // unquoted (`{symbol:"X"}`). Try strict JSON first, then the artifact-repaired/relaxed form.
    const jsonish = m[2].replace(/<\|"\|>/g, '"');
    for (const cand of [jsonish, jsonish.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')]) {
      let args;
      try { args = JSON.parse(cand); } catch { continue; }
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const key = m[1] + JSON.stringify(args);
        if (!seen.has(key)) { seen.add(key); calls.push({ function: { name: m[1], arguments: args } }); }
        break;
      }
    }
  }
  return calls;
}

// Shrink the final answer's token cost: strip the (long, absolute) project-root prefix so cited paths
// are repo-relative (search_symbol/goto return absolute paths; find_files/find_references return relative).
// `project` is the -p / VTS_PROJECT target. No-op when project is unset.
export function relAnswer(s, project) {
  if (!project) return s;
  // Normalise separators on BOTH sides before stripping: `-p` arrives with OS separators (Windows `\`) but the
  // answer's paths are forward-slash (vs-search normalises them), so a raw split never matched and the long
  // absolute project prefix was left on every line — bloating the answer and echoing the full on-disk path.
  const p = project.replace(/\\/g, "/").replace(/\/+$/, "");
  // Case-INSENSITIVE strip: on Windows, tsserver hands back a lowercase drive (`g:/…`) while `-p` is `G:\…`,
  // so an exact split missed the prefix and left the whole absolute path on every line (bloat + on-disk path
  // echoed). A case-insensitive regex strips it regardless of drive/segment case; the remainder keeps its case.
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(s).replace(/\\/g, "/").replace(new RegExp(esc + "/?", "gi"), "");
}

// ANTI-FABRICATION GUARD v2. v1 only checked that the PATH string appeared somewhere in the run's tool
// results — case-SENSITIVELY and ignoring line numbers entirely — so (a) a REAL path with an INVENTED
// `:line` sailed straight through (the most plausible fabrication mode), and (b) tsserver's lowercase
// drive letters (`g:/…`) risked false drops of legitimate answers on case-insensitive Windows paths.
// v2 rules, all case-insensitive:
//   - a location line's PATH must appear in some tool-result line (full match, or by its trailing two
//     path segments to bridge rel-vs-abs differences);
//   - each claimed LINE NUMBER must appear as a number token on one of THOSE path-bearing result lines
//     (results arrive as `path:53: func x` and grouped `path:l1,l2`, so token matching covers both);
//   - verified numbers are kept, unverified numbers dropped; a line with no verified number is dropped.
// Prose lines pass through untouched. Returns the filtered answer + what was discarded, so the caller can
// surface an honest note instead of silently shipping invented locations.
export function verifyAnswerPaths(raw, results) {
  const blobLines = String((results || []).join("\n")).replace(/\\/g, "/").toLowerCase().split("\n").filter(Boolean);
  if (!blobLines.length || !String(raw || "").trim()) return { raw, droppedPaths: 0, droppedLines: 0 };
  let droppedPaths = 0, droppedLines = 0;
  // Reconstruct the compacted `under <dir>/` header + BARE `file:line` data rows into full `dir/file:line`
  // tokens BEFORE matching. A bare basename data line carries no directory, so a full-path answer could only
  // reconcile by basename — which let a same-named file in a DIFFERENT dir donate its line numbers to a
  // fabricated path (dogfood: result `Source/Game/PlayerController.cpp:53`, answer `Other/Deep/…:53` passed).
  // Folding the header dir onto each bare row restores the directory so a wrong-dir answer no longer matches.
  // The original bare rows are kept too, so a basename-ONLY answer (no dir to contradict) still reconciles.
  const recon = [];
  let curDir = "";
  for (const bl of blobLines) {
    const hm = bl.match(/^under (.+?)\/?$/);
    if (hm) { curDir = hm[1].replace(/\/+$/, ""); recon.push(bl); continue; }
    const dm = bl.match(/^\s*([^\s/:][^\s:]*):(\d+(?:,\d+)*)\b/);
    if (dm && curDir && !dm[1].includes("/")) recon.push(curDir + "/" + dm[1] + ":" + dm[2]);
    recon.push(bl);
  }
  const kept = String(raw).split("\n").map((ln) => {
    const m = /^\s*(.+?):(\d+(?:,\d+)*)\s*$/.exec(ln);
    if (!m || !/[/\\.]/.test(m[1])) return ln;             // prose / non-location line → untouched
    const p = m[1].trim().replace(/\\/g, "/").toLowerCase();
    const segs = p.split("/");
    const tail = segs.slice(-2).join("/");
    // Tool output compacts to an `under <dir>` header + BARE `filename:line` data lines. A full-path answer
    // (the model reconstructs the path from the result header) then matched ONLY the header — which carries NO
    // line numbers — so every real location was wrongly discarded as fabricated (live: search_text found 7
    // hits, the guard nuked all 7 → "no match" → the caller abandoned qvts). Also accept a `basename:` data
    // line as a carrier so the answer's line numbers reconcile against the lines that actually carry them.
    const base = segs[segs.length - 1];
    // Harvest claimed line numbers ONLY from the `<path>:NN` token that actually bears this location — try the
    // full path, then the trailing two segments, then the compacted `basename:NN` data line. Never scan every
    // digit on the line: doing so let source text (loop bounds, years in a result's code snippet) spuriously
    // "verify" an invented number, and a loose basename-anywhere match let a same-named file in a DIFFERENT
    // directory donate its line numbers to a fabricated path.
    const numsAt = (bl, needle) => {
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("(?:^|[\\s/\\\\])" + esc + ":(\\d+(?:,\\d+)*)", "g");
      const found = [];
      for (let mm; (mm = re.exec(bl)); ) found.push(...mm[1].split(","));
      return found;
    };
    const nums = new Set();
    let carried = false;
    for (const bl of recon) {
      const byPath = numsAt(bl, p);
      const chosen = byPath.length ? byPath : (tail ? numsAt(bl, tail) : []);
      // The bare-basename fallback is DIRECTORY-BLIND, so gate it to a basename-only answer (segs.length === 1):
      // when the answer names no directory there is nothing to contradict. A full/partial-path answer must match
      // a reconstructed `dir/file` token — a wrong-dir path with a right basename no longer borrows line numbers.
      const use = chosen.length ? chosen : (segs.length === 1 ? numsAt(bl, base) : []);
      if (use.length) { carried = true; for (const n of use) nums.add(n); }
    }
    if (!carried) { droppedPaths++; return null; } // path never appeared as a numbered location in any result
    const claimed = m[2].split(",");
    const verified = claimed.filter((n) => nums.has(n));
    droppedLines += claimed.length - verified.length;
    if (!verified.length) { droppedPaths++; return null; } // real path, every line number invented
    return `${m[1].trim()}:${verified.join(",")}`;
  }).filter((x) => x !== null);
  return { raw: kept.join("\n").trim(), droppedPaths, droppedLines };
}

// SALVAGE — the small model sometimes loops or hits the step limit AFTER a search already returned real
// locations (observed: a big "60 match(es) … capped" result it misread as "incomplete", then re-queried into a
// dead end with an emptied projectPath). Rather than ship a FALSE "no match", recover the largest set of
// path:line locations already sitting in the tool results and fold it as the answer. Parses the tool output
// shape `under <dir>/` header + `  <relfile>:<line>: text` rows (search_text/find_files), grouping per file.
export function salvageLocs(executed) {
  // Accept either the CLI/dashboard `executed` Map or a plain array of result strings (finalizeAnswer holds the
  // latter), so the fabrication-guard fallback can salvage without reconstructing a Map.
  const sources = executed && executed.values ? [...executed.values()] : (Array.isArray(executed) ? executed : []);
  let best = null, bestN = -1;
  for (const rt of sources) {
    const byFile = new Map();
    let pre = "";
    for (const ln of String(rt).split("\n")) {
      const pm = ln.match(/^under (.+?)\/?\s*$/);
      if (pm) { pre = pm[1].replace(/\\/g, "/"); continue; }
      // Optional `DRIVE:` prefix so a Windows ABSOLUTE path (`G:/…/File.h:11` — the shape clangd/def_search
      // return) parses: the drive colon otherwise terminated the `[^:]*` path class and salvage returned null on
      // every absolute-path result (live UE dogfood — a real decl candidate was discarded as unsalvageable, so a
      // hallucinated answer that the fabrication guard nuked fell through to a false "no match").
      const m = ln.match(/^\s*((?:[A-Za-z]:)?[^\s:]*\.[A-Za-z0-9_]+):(\d+)\b/);
      if (!m) continue;
      const file = pre && !m[1].includes("/") ? pre + "/" + m[1] : m[1];
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(m[2]);
    }
    const n = [...byFile.values()].reduce((a, s) => a + s.size, 0);
    if (n > bestN) { bestN = n; best = byFile; }
  }
  if (!best || bestN <= 0) return null;
  return [...best].map(([f, s]) => `${f}:${[...s].sort((a, b) => Number(a) - Number(b)).join(",")}`).join("\n");
}

// Strip chat-template CONTROL tokens that occasionally leak into the model's final answer. gemma4-vts uses a
// channel-style template and a stray `<channel|>` / `<|message|>` slipped through into the answer text (live:
// "no match<channel|>Source/…"). Match ONLY the known pipe-delimited markers so a legitimate C++ header token
// like `<vector>` (no pipe) is never touched.
export function stripCtrlTokens(s) {
  return String(s)
    .replace(/<\|?(?:channel|message|start|end|im_start|im_end|assistant|user|system|think|tool_call|tool_response|tool)\|?>/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Small local models often ignore the compact `path:line` contract and instead echo the tool-result line
// VERBATIM as markdown — `* path:214: <the whole source line>` under a `**Symbol**` header. That form is
// heavy and, because it does NOT end at the line number, it slips past BOTH verifyAnswerPaths and
// groupLocLines (each only recognises a line that IS exactly `path:line`). Normalise each location line back
// to bare `path:line(s)`: strip a leading list marker, strip the trailing `: <source text>`, and drop a pure
// markdown header / bold symbol label. Bare locations, `note:`, `no match`, and prose pass through. Run
// BEFORE the fabrication guard so those lines become verifiable, and before groupLocLines so they compact.
export function normalizeLocLines(s) {
  const out = [];
  for (const ln of String(s).split("\n")) {
    const t = ln.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");            // drop a leading markdown list marker
    if (/^\s*#{1,6}\s/.test(t) || /^\s*\*\*.+\*\*\s*$/.test(t)) continue; // drop a header / bold symbol label
    const m = /^\s*(.+?):(\d+(?:\s*,\s*\d+)*)\s*(?::.*)?$/.exec(t); // path:nums optionally trailed by ": <text>"
    if (m && /[/\\.]/.test(m[1])) { out.push(`${m[1].trim()}:${m[2].replace(/\s+/g, "")}`); continue; }
    out.push(ln);                                                  // not a location line → untouched
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Compact a final answer's location lines: hits in the same file collapse to `path:l1,l2,l3`. The prompt
// ASKS the model to group, but a small model often doesn't (live: 25 one-per-line hits repeating the same
// long path prefix 25×, straight into Claude's context). Conservative: only rewrites when EVERY non-empty
// line is a `path:line(s)` location — a prose or mixed answer passes through untouched.
export function groupLocLines(s) {
  const lines = String(s).split("\n").filter((l) => l.trim());
  if (lines.length < 2) return s;
  const order = [];
  const byFile = new Map();
  for (const ln of lines) {
    const m = /^\s*(.+?):(\d+(?:,\d+)*)\s*$/.exec(ln);
    if (!m || !/[/\\.]/.test(m[1])) return s; // any non-location line → leave the whole answer alone
    if (!byFile.has(m[1])) { byFile.set(m[1], []); order.push(m[1]); }
    byFile.get(m[1]).push(m[2]);
  }
  if (byFile.size === lines.length) return s; // nothing to merge
  return order.map((f) => `${f}:${byFile.get(f).join(",")}`).join("\n");
}

// FINAL-ANSWER PIPELINE — the exact sequence vts-bridge.mjs's locate() ran inline, captured as one function
// so the dashboard path applies the identical treatment. Order matters: strip control tokens → peel the
// trailing `note:` escape line → normalise verbose/markdown location lines to bare `path:line` → drop
// fabricated paths/line numbers → strip the project prefix → group per file. Returns { answer, note }.
export function finalizeAnswer(rawAnswer, results, project) {
  let raw = stripCtrlTokens(String(rawAnswer || ""));
  let note = null;
  // `note:` escape line (lite prompt): the model's own judgment rides as ONE trailing line. Peel it into its
  // own field so the path:line contract stays parseable and the judgment still reaches the caller.
  const nm = /(?:^|\n)note:\s*(.+)\s*$/i.exec(raw);
  if (nm) {
    const n = nm[1].trim();
    // gemma pads a `note:` with rambling rationalizations ("…suggesting…, though a direct line-by-line
    // confirmation was not possible due to tool limitations") that are pure noise to the caller. Drop a note
    // that is long AND carries a hedge marker; keep a genuinely short judgment (stale index / next step).
    const hedge = /\b(tool limitation|was not possible|could not|though a direct|suggesting|but did not|not restrict|no direct|unable to)\b/i.test(n);
    note = (hedge && n.length > 80) ? null : n.slice(0, 160);
    raw = raw.slice(0, nm.index).trim();
  }
  raw = normalizeLocLines(raw);
  const v = verifyAnswerPaths(raw, results);
  if (v.droppedPaths || v.droppedLines) {
    // When the guard empties the answer, the model fabricated its path/line — but the tool results may still
    // hold the REAL locations for this query. Salvage them instead of reporting a false "no match" (live UE:
    // the model hallucinated an `Engine/…` path while the correct decl sat in the def_search result).
    raw = v.raw || salvageLocs(results) || "no match";
    note = ((note ? note + "; " : "") +
      `fabrication guard: discarded ${v.droppedPaths} path(s) / ${v.droppedLines} line number(s) not present in any tool result`).slice(0, 300);
  }
  const answer = groupLocLines(relAnswer(raw, project));
  return { answer, note };
}

// COMPLEX-QUERY GUARD — qvts's local model is a SINGLE-locate driver, not an analyst. A multi-part query
// ("list line numbers of A, B, C, D + the full body range of E + whether F is applied + where relative to G")
// makes it run one tool then emit a rambling prose `note:` (or "(no answer)") — noise the caller can't use and
// wasted tokens. Detect the shape UP FRONT and hand back a decomposition hint instead of running the model.
// Trips on: >= 3 distinct CamelCase symbol candidates (a 3+-symbol ask is worth decomposing regardless), OR
// >= 2 symbols together with >= 2 multi-request markers (list / whether / relative to / range / report / does
// it use). A single- or two-symbol locate never trips (that's exactly what qvts is for).
export function detectComplexQuery(query) {
  const q = String(query || "");
  // Scrub path/namespace tokens BEFORE counting symbols. A single "find DoThing in Source/MyGameCore/
  // MyPlayerController.cpp" locate must NOT read as a 3-symbol multi-part ask — PascalCase path segments and a
  // `Ns::Class::Method` chain are ONE target concept, not several. Without this, file-scoped locates against a
  // PascalCase-heavy tree (Unreal Source/…) tripped the guard and got refused with a decomposition hint (live
  // false positive). Genuine multi-part queries keep their real symbols after the scrub, so detection survives.
  const scrub = q
    .replace(/[A-Za-z0-9_.\\-]*[/\\][A-Za-z0-9_./\\-]*/g, " ") // a path-ish token (contains a slash)
    .replace(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+\b/g, " ")       // a C++ namespace/member chain A::B::C
    .replace(/\b[\w-]+\.[A-Za-z0-9_]+\b/g, " ");                // a bare filename.ext (no slash)
  const syms = [...new Set(scrub.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g) || [])];
  const markers = (q.match(/\b(list|whether|relative to|the full|body|range|report|does it use)\b/gi) || []).length;
  const complex = syms.length >= 3 || (syms.length >= 2 && markers >= 2);
  if (!complex) return { complex: false, symbols: syms };
  const hint =
    "(complex multi-part query — qvts's local model does ONE locate, not multi-symbol analysis. Split into a " +
    "separate call per concept and combine the results yourself: `where is X defined` / `find X in <file>` / " +
    "`what calls X`. Detected symbols: " + syms.slice(0, 12).join(", ") + (syms.length > 12 ? ", …" : "") + ".)";
  return { complex: true, symbols: syms, hint };
}
