/*
 * defn-patterns.mjs — language-aware DECLARATION search patterns + ranking.
 *
 * The index-free locator (search_text) is a regex over text, so locate accuracy hinges on searching the
 * DEFINITION pattern, not the bare name (which floods with usages/#includes/comments and buries the one
 * declaration under the time-box). Small local models craft that regex inconsistently. This module makes it
 * DETERMINISTIC: given a symbol name (+ optional language), it returns the ordered definition-search regexes
 * to try, and a ranker that floats the most declaration-like hit to the top.
 *
 * Patterns follow universal-ctags' per-language "kind" regexes (the 30-year reference for regex-based symbol
 * extraction; https://docs.ctags.io/en/latest/optlib.html) and the structural intent of ast-grep/semgrep
 * (match the definition construct, not surface text). Ranking mirrors issue-localization research that
 * narrows file→type→member and reranks candidates (OrcaLoca, CoRNStack, RepoNavigator).
 *
 * Pure Node, no deps. Regexes are written for vs-search's default engine (ERE-ish: no lookaround/backrefs).
 */
import fs from "node:fs";
import path from "node:path";

const EXT_LANG = {
  c: "c", h: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", inl: "cpp",
  cpp: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp",
  cs: "csharp",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "python", pyi: "python",
  go: "go", java: "java", rs: "rust", kt: "kotlin", kts: "kotlin",
};

export function langFromExt(file) {
  const m = /\.([A-Za-z0-9+]+)$/.exec(String(file || ""));
  return m ? EXT_LANG[m[1].toLowerCase()] || null : null;
}

// Best-effort primary language of a project, from root markers (cheap, one readdir). Used when the caller
// doesn't pass an explicit lang to def_search.
export function detectLang(project) {
  if (!project) return null;
  let ents = [];
  try { ents = fs.readdirSync(project); } catch { return null; }
  const has = (re) => ents.some((e) => re.test(e));
  if (has(/\.uproject$/i)) return "cpp";
  // A UE / C++ cluster root carries a generated `.sln` AND C# BUILD scripts (*.Build.cs / *.Target.cs) — neither
  // means the codebase is C#. Detect the C++/UE signal (an Engine/ or Source/ dir, or a `.uproject` one level
  // down) BEFORE the C#-project rule, and treat `.sln` as language-NEUTRAL (dropped as a csharp signal). Without
  // this, a "where is <C++ symbol>" locate on a UE cluster ran with C# patterns → a false authoritative
  // "no match" (live: MAX_STATIC_MESH_LODS, a `#define` in the engine — 3 C# patterns, none matched).
  const subHasUproject = () => ents.some((e) => {
    try { const p = path.join(project, e); return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => /\.uproject$/i.test(f)); } catch { return false; }
  });
  if (ents.includes("Engine") || ents.includes("Source") || subHasUproject()) return "cpp";
  if (has(/\.csproj$/i)) return "csharp"; // a genuine C# project; `.sln` alone is language-neutral
  if (has(/^tsconfig.*\.json$/i)) return "ts";
  if (has(/^Cargo\.toml$/i)) return "rust";
  if (has(/^go\.mod$/i)) return "go";
  if (has(/^(pyproject\.toml|setup\.py|requirements\.txt|Pipfile)$/i)) return "python";
  if (has(/^pom\.xml$/i) || has(/^build\.gradle/i)) return "java";
  if (has(/^package\.json$/i)) return "js";
  if (ents.includes("Source")) return "cpp"; // UE-style tree without a sibling .uproject
  return null;
}

// Escape a symbol for use as a regex literal.
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * Ordered definition-search candidates for `name` in `lang`. Each is { q, kind, headerish }:
 *   q         — the regex to hand to search_text (omit `path`; let it scan the whole tree).
 *   kind      — what it locates (type / enum / function / alias / value).
 *   headerish — true if a match is more authoritative in a header/interface file (used by rank()).
 * `N` is the exact name; `P` is prefix-tolerant (matches UMyType for "MyType" — UE U/A/F/S/E, I-interfaces,
 * etc.) so a loosely-named request ("the game-instance class") still hits `class UMyGameInstance`.
 */
export function definitionSearches(name, lang) {
  const N = esc(name);
  const P = `\\w*${N}`;
  const out = [];
  const add = (q, kind, headerish = false) => out.push({ q, kind, headerish });

  switch (lang) {
    case "c":
    case "cpp":
      add(`(class|struct)\\s+([A-Za-z_][A-Za-z0-9_]*\\s+)?${P}\\b`, "type", true); // incl. MODULE_API macro
      add(`enum\\s+(class\\s+)?${P}\\b`, "enum", true);
      add(`(typedef|using)\\b.*\\b${N}\\b`, "alias", true);
      // MEMBER VARIABLE / field: `[UPROPERTY(...)] <Type> Name [= init];` at class scope. The type must look
      // like a type — a known primitive, a PascalCase/UE type (FVector, UClass, TArray<…>), or a pointer/ref —
      // so a usage statement (`return Significance;`) isn't matched. Name must be FOLLOWED by [=;[] (not `(`,
      // which would be a function). Covers the common "where is the uint8 Foo member declared" hunt that the
      // type/enum/function patterns all miss. headerish: members are declared in the header.
      // Template args are `<[^;{}]*>` (greedy, statement-char-bounded), NOT `<[^>]*>` — the latter stops at
      // the first `>`, so a NESTED template member (`TMultiMap<TObjectPtr<UObj>, FName> Name;`) failed to
      // match and def_search returned a confident "no declaration" for a symbol sitting right in the scanned
      // header (live dogfood miss). `;{}` can't appear inside template args, so greedy-to-last-`>` is safe.
      add(`(UPROPERTY\\s*\\([^)]*\\)\\s*)?\\b(uint8|uint16|uint32|uint64|int8|int16|int32|int64|int|float|double|bool|FString|FName|FText|[A-Z]\\w+(<[^;{}]*>)?|[A-Za-z_]\\w*\\s*[*&])\\s+\\*?&?${N}\\s*(\\[[^\\]]*\\])?\\s*(=[^;]*)?;`, "field", true);
      add(`\\b${N}\\s*\\([^;{]*\\)\\s*(const)?\\s*\\{`, "function-def", false); // body, not a prototype
      // MACRO / CONSTANT: an ALL_CAPS engine constant is usually a `#define NAME …` or a `constexpr/const NAME =`,
      // which NONE of the type/enum/function/field patterns above match — def_search returned a false
      // authoritative "no match" for a real `#define` (live: MAX_STATIC_MESH_LODS). NO `^` line anchor: search_text
      // matches the whole file WITHOUT a per-line multiline flag, so a `^`-anchored pattern only hits a decl on
      // the file's FIRST line (verified — `^\s*#\s*define` returned 0 on a line-3 `#define`). `#define` and the
      // const/constexpr/static keyword are distinctive enough to anchor without `^`.
      add(`#\\s*define\\s+${N}\\b`, "macro", true);
      add(`\\b(constexpr|const|static)\\b[\\w:<>*&\\s]*\\b${N}\\s*[=;]`, "value", true);
      add(`\\b${N}\\s*\\(`, "function-decl", false);
      break;
    case "csharp":
      add(`(class|struct|interface|enum|record)\\s+${P}\\b`, "type", false);
      add(`\\b(public|private|protected|internal|static|virtual|override|async|\\s)+[A-Za-z0-9_<>\\[\\],. ]+\\s${N}\\s*\\(`, "member", false);
      add(`\\b${N}\\s*\\(`, "method", false);
      break;
    case "ts":
      add(`(export\\s+)?(abstract\\s+)?(class|interface|type|enum)\\s+${N}\\b`, "type", false);
      add(`(export\\s+)?(function\\s+${N}\\b|(const|let|var)\\s+${N}\\s*[:=])`, "value", false);
      add(`\\b${N}\\s*[:=]\\s*(async\\s*)?(function|\\()`, "func-expr", false);
      break;
    case "js":
      add(`(export\\s+)?(class\\s+${N}\\b|function\\*?\\s+${N}\\b)`, "type/func", false);
      add(`(export\\s+)?(const|let|var)\\s+${N}\\s*=`, "value", false);
      add(`\\b${N}\\s*[:=]\\s*(async\\s*)?(function|\\()`, "func-expr", false);
      break;
    case "python":
      // `\b` not `^` — search_text matches the whole file without a per-line multiline flag, so a `^`-anchored
      // pattern only hits a def on the file's first line. `\b(class|def)` still blocks `subclass`/`undefine`.
      add(`\\b(class|def|async\\s+def)\\s+${N}\\b`, "class/def", false);
      break;
    case "go":
      add(`type\\s+${N}\\b`, "type", false);
      add(`func\\s+(\\([^)]*\\)\\s*)?${N}\\b`, "func", false);
      break;
    case "java":
    case "kotlin":
      add(`(class|interface|enum|record|object)\\s+${P}\\b`, "type", false);
      add(`\\b${N}\\s*\\(`, "method", false);
      break;
    case "rust":
      add(`(struct|enum|trait|union)\\s+${N}\\b`, "type", false);
      add(`(fn\\s+${N}\\b|type\\s+${N}\\b|(const|static)\\s+${N}\\b)`, "item", false);
      break;
    default:
      // language-agnostic best effort — also covers an UNMARKED C/C++ tree (a bare `Source/` dir handed in as a
      // scoped root detects no language, so it lands here): include the `#define`/const macro pattern so an
      // ALL_CAPS engine constant is still found (live: MAX_STATIC_MESH_LODS under a scoped Engine/Source that
      // detected `auto` → the 2 generic patterns had no macro rule → false "no match").
      add(`(class|struct|interface|enum|type|trait|record)\\s+${P}\\b`, "type", true);
      add(`(def|func|fn|function)\\s+${N}\\b`, "func", false);
      add(`#\\s*define\\s+${N}\\b`, "macro", true);
      add(`\\b(constexpr|const|static|final|val|let)\\b[\\w:<>*&\\s]*\\b${N}\\s*[=;]`, "value", true);
      add(`\\b${N}\\s*\\(`, "callable", false);
  }
  return out;
}

const HEADERISH_EXT = /\.(h|hpp|hh|hxx|inl|d\.ts|pyi|hpp)$/i;
const IS_HEADER = (f) => HEADERISH_EXT.test(f) || /\.d\.ts$/i.test(f);

/*
 * Rank merged hits so the most declaration-like floats up. Inputs: hits [{file,line,text,candIdx,kind,headerish}].
 * Score: earlier candidate (more specific construct) wins; a body/with-`{` def beats a prototype; a header is
 * preferred when the construct is header-authoritative; a forward-declaration (`class X;`) is demoted.
 */
export function rankHits(hits) {
  const score = (h) => {
    let s = 100 - h.candIdx * 10; // candidate priority (definitionSearches order)
    const t = (h.text || "").trim();
    if (/[{]\s*$/.test(t) || /[{]/.test(t)) s += 6; // has an opening brace → real definition body
    if (/;\s*$/.test(t) && /\b(class|struct)\b/.test(t)) s -= 12; // `class X;` forward decl → demote
    if (h.headerish && IS_HEADER(h.file)) s += 4;
    if (/^\s*\/\//.test(t) || /^\s*\*/.test(t) || /^\s*#/.test(t)) s -= 20; // comment / preprocessor line
    return s;
  };
  return hits
    .map((h) => ({ ...h, _s: score(h) }))
    .sort((a, b) => b._s - a._s || a.file.localeCompare(b.file) || a.line - b.line);
}
