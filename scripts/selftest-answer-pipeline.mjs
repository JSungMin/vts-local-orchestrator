#!/usr/bin/env node
/*
 * selftest-answer-pipeline.mjs — deterministic guards for answer-pipeline.mjs (pure functions, no model, no
 * network). The pipeline is what keeps a local model's answer compact; a model that formats differently must
 * not silently defeat it. Run: npm test
 */
import {
  normalizeLocLines,
  groupLocLines,
  relAnswer,
  finalizeAnswer,
  verifyAnswerPaths,
  detectComplexQuery,
} from "../answer-pipeline.mjs";

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) return console.log(`  ok   ${name}`);
  fails++;
  console.log(`  FAIL ${name}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`);
};

console.log("answer-pipeline selftest\n");

// --- MULTI-LOCATION LINE (the regression this file was created for) -------------------------------------
// Live: qwen2.5-coder answered with every hit on ONE space-separated line of ABSOLUTE paths. Every helper is
// line-oriented, so groupLocLines read the whole line as a single "path" ending at the last number and passed
// it through: no grouping, no prefix strip — the raw absolute paths shipped to the caller. gemma4 emits
// one-per-line and was unaffected, which is exactly why this hid: the pipeline was shaped around one model.
{
  const P = "G:/proj/App";
  const oneLine =
    "G:/proj/App/Source/Util/CheatManager.h:84 G:/proj/App/Source/Util/CheatManager.h:280 G:/proj/App/Source/Util/CheatManager.h:284";
  const { answer } = finalizeAnswer(oneLine, ["under G:/proj/App/Source/Util/\n  CheatManager.h:84,280,284: hit"], P);
  ok("one-line run → grouped + relative", answer === "Source/Util/CheatManager.h:84,280,284", answer);
}
{
  // …and the same shape already relative (no project prefix to strip).
  const s = "a/F.h:1 a/F.h:2 b/G.cpp:9";
  const out = groupLocLines(normalizeLocLines(s));
  ok("one-line run → grouped per file", out === "a/F.h:1,2\nb/G.cpp:9", out);
}
{
  // A Windows-absolute token keeps its drive colon (the naive `[^\s:]+` split loses it).
  const out = normalizeLocLines("G:/a/F.h:10 G:/a/F.h:20");
  ok("drive-letter tokens survive the split", out === "G:/a/F.h:10\nG:/a/F.h:20", out);
}

// --- ECHOED `file:line` CONTRACT HEADER ----------------------------------------------------------------
// Live (qwen2.5-coder, after the one-line fix): the model prefixed its answer with the literal contract label
// `file:line`. It's not a location, and groupLocLines only groups when EVERY line is one — so that single
// header row stopped 19 real hits from collapsing and `server/core.js` repeated on all 19 lines.
{
  const s = "file:line\nsrc/a.js:1\nsrc/a.js:2\nsrc/b.js:9";
  const out = groupLocLines(normalizeLocLines(s));
  ok("echoed `file:line` header dropped → answer groups", out === "src/a.js:1,2\nsrc/b.js:9", out);
}
{
  ok("bold/plural header variants dropped", normalizeLocLines("**File: Lines**\nsrc/a.js:1") === "src/a.js:1", normalizeLocLines("**File: Lines**\nsrc/a.js:1"));
}
{
  // Narrow on purpose: a real path whose basename is `file` must survive.
  const out = normalizeLocLines("src/file.js:12");
  ok("a real path named file.js is not mistaken for the header", out === "src/file.js:12", out);
}

// --- the split must NOT eat legitimate non-location content --------------------------------------------
{
  // A location trailed by SOURCE TEXT contains spaces but is not a run of locations.
  const out = normalizeLocLines("src/a.js:214: for (let i = 0; i < 10; i++) {");
  ok("path:line: <source text> → single location, text dropped", out === "src/a.js:214", out);
}
{
  const prose = "no match";
  ok("prose passes through", normalizeLocLines(prose) === prose);
}
{
  const mixed = "found these: src/a.js:1 and also src/b.js:2";
  ok("mixed prose+locations left alone", normalizeLocLines(mixed) === mixed, normalizeLocLines(mixed));
}
{
  // A bare number token is not a location → the line is not a pure run.
  const s = "src/a.js:1 12";
  ok("run with a stray token left alone", normalizeLocLines(s) === s, normalizeLocLines(s));
}

// --- existing contracts must not regress ----------------------------------------------------------------
{
  const out = normalizeLocLines("* **DoThing**\n* src/a.js:5: void DoThing() {");
  ok("markdown list + bold header normalised", out === "src/a.js:5", out);
}
{
  ok("relAnswer strips the project prefix (case-insensitive)", relAnswer("g:/Proj/App/src/a.js:5", "G:/Proj/App") === "src/a.js:5");
}
{
  const s = "src/a.js:5\nprose line\nsrc/a.js:9";
  ok("groupLocLines leaves a mixed answer alone", groupLocLines(s) === s);
}
{
  // fabrication guard: a real path with an invented line number loses the number.
  const v = verifyAnswerPaths("src/a.js:5,999", ["under /r/src/\n  a.js:5: hit"]);
  ok("fabricated line number dropped", v.raw === "src/a.js:5" && v.droppedLines === 1, v);
}
{
  // NB: the symbol probe requires real CamelCase (>= 2 capitalised groups) — `Alpha` alone is not a symbol.
  ok("complex multi-part query detected", detectComplexQuery("list AlphaThing BetaThing GammaThing and the full body range of DeltaThing").complex === true);
  ok("single-file locate not flagged complex", detectComplexQuery("find DoThing in Source/MyGame/MyController.cpp").complex === false);
}

console.log(fails ? `\nFAILED (${fails})` : "\nPASSED");
process.exit(fails ? 1 : 0);
