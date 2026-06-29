#!/usr/bin/env node
/*
 * secret-scan.mjs — block company / secret material from entering this PUBLIC repo.
 *
 * Runs from the git pre-commit and commit-msg hooks (and CI). Scans the STAGED diff (added lines only) and
 * the commit message for high-confidence secret patterns plus an ORG-SPECIFIC denylist that is deliberately
 * kept OUT of this public repo (a denylist of secrets committed in plaintext would itself be the leak).
 *
 * Pattern sources, all combined:
 *   1. built-in generic patterns below (safe to be public — private keys, cloud keys, tokens, user home paths)
 *   2. a gitignored `.secret-patterns` file at the repo root — ONE regex (or plain substring) per line,
 *      `#` comments allowed. Put company codenames / internal class names / project paths / corp emails here.
 *   3. env VTS_SECRET_PATTERNS — newline- or comma-separated regexes (used by CI via a repo secret).
 *
 * Usage:
 *   node scripts/secret-scan.mjs            # scan the staged diff (pre-commit)
 *   node scripts/secret-scan.mjs --msg F    # scan commit-message file F (commit-msg hook)
 *   node scripts/secret-scan.mjs --tree     # scan all tracked files (CI)
 * Exit 0 = clean, 1 = a pattern matched (commit blocked), 2 = usage error.
 * Bypass for a verified false positive: SECRET_SCAN_OFF=1 git commit ...
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

if (/^(1|true|on|yes)$/i.test(process.env.SECRET_SCAN_OFF || "")) process.exit(0);

// 1. Built-in generic high-confidence patterns (safe to live in a public file).
const BUILTIN = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, why: "private key block" },
  { re: /AKIA[0-9A-Z]{16}/, why: "AWS access key id" },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/, why: "Slack token" },
  { re: /gh[pousr]_[0-9A-Za-z]{30,}/, why: "GitHub token" },
  { re: /-----BEGIN CERTIFICATE-----/, why: "certificate" },
  // absolute Windows / WSL user-home path → leaks a username + local machine layout
  { re: /[A-Za-z]:\\Users\\[^\\\/\s"'`)]+/, why: "absolute Windows user-home path" },
  { re: /\/(?:c|mnt\/c)\/Users\/[^\/\s"'`)]+/, why: "absolute user-home path" },
];

// 2. + 3. org-specific patterns from the gitignored file and env (never committed).
function loadExtra() {
  const out = [];
  const root = repoRoot();
  const f = path.join(root, ".secret-patterns");
  let raw = "";
  try { raw = fs.readFileSync(f, "utf8"); } catch { /* none — generic-only */ }
  if (process.env.VTS_SECRET_PATTERNS) raw += "\n" + process.env.VTS_SECRET_PATTERNS.replace(/,/g, "\n");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    let re;
    try { re = new RegExp(s, "i"); } catch { re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    out.push({ re, why: "org denylist pattern" });
  }
  return out;
}

function repoRoot() {
  try { return execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return process.cwd(); }
}

function scan(text, label, patterns) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const p of patterns) {
      const m = p.re.exec(ln);
      if (m) hits.push({ label, line: i + 1, why: p.why, snippet: ln.trim().slice(0, 120), match: m[0].slice(0, 40) });
    }
  });
  return hits;
}

function stagedAddedLines() {
  // Only ADDED lines (leading '+', not the +++ header) across the staged diff, tagged with their file.
  let diff = "";
  try { diff = execSync("git diff --cached --unified=0", { maxBuffer: 64 * 1024 * 1024 }).toString(); } catch { return []; }
  const blocks = [];
  let file = "?";
  for (const ln of diff.split(/\r?\n/)) {
    if (ln.startsWith("+++ b/")) { file = ln.slice(6); continue; }
    if (ln.startsWith("+") && !ln.startsWith("+++")) blocks.push({ file, text: ln.slice(1) });
  }
  return blocks;
}

function trackedFiles() {
  try { return execSync("git ls-files", { maxBuffer: 64 * 1024 * 1024 }).toString().split(/\r?\n/).filter(Boolean); }
  catch { return []; }
}

const patterns = [...BUILTIN, ...loadExtra()];
// This scanner's own source legitimately contains the pattern literals — never scan it (false positives).
const SELF = /(^|[\\/])secret-scan\.mjs$/;
const args = process.argv.slice(2);
let hits = [];

if (args[0] === "--msg") {
  const f = args[1];
  if (!f) { process.stderr.write("secret-scan --msg needs a file\n"); process.exit(2); }
  let msg = ""; try { msg = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
  // ignore comment lines git puts in the message template
  const body = msg.split(/\r?\n/).filter((l) => !l.startsWith("#")).join("\n");
  hits = scan(body, "commit-message", patterns);
} else if (args[0] === "--tree") {
  for (const f of trackedFiles()) {
    if (f === ".secret-patterns" || SELF.test(f)) continue;
    let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (txt.includes("\0")) continue; // binary
    hits.push(...scan(txt, f, patterns));
  }
} else {
  for (const b of stagedAddedLines()) {
    if (SELF.test(b.file)) continue;
    hits.push(...scan(b.text, b.file, patterns));
  }
}

if (!hits.length) process.exit(0);

process.stderr.write("\n\x1b[31m✖ secret-scan BLOCKED: possible company/secret material\x1b[0m\n");
for (const h of hits.slice(0, 30)) {
  process.stderr.write(`  ${h.label}:${h.line}  [${h.why}]  match="${h.match}"\n    ${h.snippet}\n`);
}
if (hits.length > 30) process.stderr.write(`  …and ${hits.length - 30} more\n`);
process.stderr.write(
  "\nThis is a PUBLIC repo. Remove the flagged content (use a generic placeholder).\n" +
  "False positive? Refine .secret-patterns, or bypass once: SECRET_SCAN_OFF=1 git commit ...\n\n",
);
process.exit(1);
