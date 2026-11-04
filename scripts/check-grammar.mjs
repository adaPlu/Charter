// Checks that spec/charter.ebnf is well-formed and still matches spec/grammar.lock.json.
// The lock is what "frozen" means: any edit to the grammar changes its hash and fails CI
// until someone renews the lock and records the change as a new amendment.
//
// Usage:
//   node scripts/check-grammar.mjs                    check (used by CI)
//   node scripts/check-grammar.mjs --write-lock A21   renew the lock after adding amendment A21
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGrammar, grammarProblems, grammarStats, grammarHash } from "./grammar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const grammarPath = join(root, "spec", "charter.ebnf");
const lockPath = join(root, "spec", "grammar.lock.json");
const amendmentsPath = join(root, "spec", "amendments.json");

const text = readFileSync(grammarPath, "utf8");
const g = loadGrammar(text);
const problems = grammarProblems(g);
const stats = grammarStats(g);
const known = new Set(JSON.parse(readFileSync(amendmentsPath, "utf8")).amendments.map((a) => a.id));
const args = process.argv.slice(2);

if (problems.length) {
  for (const p of problems) console.error(`grammar: ${p}`);
  process.exit(1);
}

if (args[0] === "--write-lock") {
  const old = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { amendments: [] };
  const added = args.slice(1);
  for (const id of added) if (!known.has(id)) { console.error(`grammar: ${id} is not in spec/amendments.json`); process.exit(1); }
  if (existsSync(lockPath) && added.length === 0) {
    console.error("grammar: renewing the lock needs the id of the amendment that explains the change");
    process.exit(1);
  }
  const lock = {
    version: "0.1",
    sha256: grammarHash(text),
    ...stats,
    amendments: [...new Set([...(old.amendments ?? []), ...added])],
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(`grammar: lock written (${stats.productions} productions, sha256 ${lock.sha256.slice(0, 12)}…)`);
  process.exit(0);
}

if (!existsSync(lockPath)) { console.error("grammar: spec/grammar.lock.json is missing"); process.exit(1); }
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const errors = [];
if (lock.sha256 !== grammarHash(text)) {
  errors.push("spec/charter.ebnf changed but the lock did not. The grammar is frozen: add an amendment to spec/amendments.json and .md, then run node scripts/check-grammar.mjs --write-lock <id>");
}
for (const key of ["productions", "syntacticRules", "tokenClasses"]) {
  if (lock[key] !== stats[key]) errors.push(`lock says ${key} = ${lock[key]}, grammar has ${stats[key]}`);
}
if (JSON.stringify(lock.reservedWords) !== JSON.stringify(stats.reservedWords)) errors.push("reserved words differ from the lock");
for (const id of lock.amendments ?? []) if (!known.has(id)) errors.push(`lock cites ${id}, which is not in spec/amendments.json`);

if (errors.length) {
  for (const e of errors) console.error(`grammar: ${e}`);
  process.exit(1);
}
console.log(`check-grammar: ok (v${lock.version}, ${stats.productions} productions, ${stats.syntacticRules} syntactic, ${stats.reservedWords.length} reserved words, frozen at ${lock.sha256.slice(0, 12)}…)`);
