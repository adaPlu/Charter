// Exports spec/charter.ebnf as GBNF (the grammar format of llama.cpp and similar constrained
// decoders), for the H1 pilot's constrained arm (design doc, sections 7.2 and 8.5).
//
// GBNF works on characters, not tokens, so two things are approximations:
//  1. Identifiers: GBNF cannot say "a word that is not reserved". The export accepts any word
//     where an identifier goes, and the real parser rejects reserved words. A program
//     generated under this grammar always lexes, but may still be rejected for using a
//     reserved word as a name.
//  2. Spacing: two word-like tokens must be separated ("rule Foo", not "ruleFoo"), and GBNF
//     cannot look ahead to see whether a symbol follows. So whitespace is required after every
//     word-like token (keywords, names, numbers) and optional after symbols. That is always
//     lexically safe, but it forces spellings like "caller .id", which are less natural for a
//     model. This is a fairness question for H1 (the TypeScript arm faces a similar one) and
//     is recorded in the design doc errata. One side effect: a program whose last token is a
//     word must end with whitespace, such as the usual final newline.
//
// Usage: node scripts/export-gbnf.mjs            writes spec/charter.gbnf
//        node scripts/export-gbnf.mjs --check    fails if spec/charter.gbnf is out of date
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGrammar, TOKEN_CLASSES, LEXICAL_HELPERS, grammarHash } from "./grammar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const name = (r) => r.replace(/_/g, "-");
const lit = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Token classes, written at the character level. "wordy" ones need whitespace after them. */
const TOKENS = {
  ident: { wordy: true, def: `[a-zA-Z_\\u00C0-\\uFFFF] [a-zA-Z0-9_\\u00C0-\\uFFFF]*` },
  int: { wordy: true, def: `[0-9]+` },
  decimal: { wordy: true, def: `[0-9]+ "." [0-9]+` },
  string: { wordy: false, def: `"\\"" ( [^"\\\\\\n] | "\\\\" [^\\n] )* "\\""` },
  duration: { wordy: true, def: `[0-9]+ ( "ms" | "s" | "m" | "h" | "d" )` },
  req_id: { wordy: true, def: `"R-" [0-9]+` },
  version: { wordy: true, def: `[0-9]+ "." [0-9]+ "." [0-9]+` },
};

function emit(n) {
  switch (n.k) {
    case "term": return WORD.test(n.v) ? `${lit(n.v)} wsreq` : `${lit(n.v)} ws`;
    case "ref":
      if (n.v in TOKENS) return `${name(n.v)}-tok ${TOKENS[n.v].wordy ? "wsreq" : "ws"}`;
      return name(n.v);
    // A choice inside a sequence needs its parentheses back: the EBNF reader drops them.
    case "seq": return n.items.map((m) => (m.k === "alt" ? `( ${emit(m)} )` : emit(m))).join(" ");
    case "alt": return n.items.map(emit).join(" | ");
    case "opt": return `( ${emit(n.item)} )?`;
    case "rep": return `( ${emit(n.item)} )*`;
    case "special": throw new Error("special sequences only appear in token rules");
  }
}

export function toGbnf(text) {
  const g = loadGrammar(text);
  const lines = [
    `# Generated from spec/charter.ebnf (sha256 ${grammarHash(text).slice(0, 16)}…) by scripts/export-gbnf.mjs.`,
    "# Do not edit. Approximations: identifiers may be reserved words, and whitespace is required",
    "# after word-like tokens. See the comment at the top of scripts/export-gbnf.mjs.",
    "",
    "root ::= ws program",
    "",
  ];
  for (const r of g.order) {
    if (TOKEN_CLASSES.includes(r) || LEXICAL_HELPERS.includes(r)) continue;
    lines.push(`${name(r)} ::= ${emit(g.rules.get(r))}`);
  }
  lines.push("", "# tokens");
  for (const [k, t] of Object.entries(TOKENS)) lines.push(`${name(k)}-tok ::= ${t.def}`);
  lines.push(
    "",
    "# whitespace and // comments",
    `ws ::= ( [ \\t\\r\\n] | "//" [^\\n]* "\\n" )*`,
    `wsreq ::= ( [ \\t\\r\\n] | "//" [^\\n]* "\\n" )+`,
    "",
  );
  return lines.join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (isMain) {
  const text = readFileSync(join(root, "spec", "charter.ebnf"), "utf8");
  const out = toGbnf(text);
  const file = join(root, "spec", "charter.gbnf");
  if (process.argv.includes("--check")) {
    const ok = existsSync(file) && readFileSync(file, "utf8").replace(/\r\n/g, "\n") === out;
    console.log(ok ? "export-gbnf: ok (spec/charter.gbnf is up to date)" : "export-gbnf: spec/charter.gbnf is out of date; run node scripts/export-gbnf.mjs");
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(file, out);
  console.log(`export-gbnf: wrote spec/charter.gbnf (${out.split("\n").filter((l) => l.includes("::=")).length} rules)`);
}
