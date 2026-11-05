// Checks the conformance corpus (design doc, section 8.3).
//  - every case folder has input.charter and a well-formed case.json
//  - each input parses, or fails at the expected line, according to the frozen grammar
//  - every grammar amendment is covered by at least one passing case, and every other
//    amendment is covered by the milestone it is due (a later milestone may tighten this)
//  - spec/amendments.json and spec/amendments.md list the same ids
// Usage: node scripts/check-conformance.mjs [--verbose]
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGrammar, recognize } from "./grammar.mjs";

// Raised as milestones complete. Amendments due by this milestone must be covered.
const CURRENT_MILESTONE = 2;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = join(root, "conformance", "cases");
const verbose = process.argv.includes("--verbose");

const g = loadGrammar(readFileSync(join(root, "spec", "charter.ebnf"), "utf8"));
const register = JSON.parse(readFileSync(join(root, "spec", "amendments.json"), "utf8")).amendments;
const registerIds = new Set(register.map((a) => a.id));
const mdIds = new Set([...readFileSync(join(root, "spec", "amendments.md"), "utf8").matchAll(/^\| (A\d+) \|/gm)].map((m) => m[1]));

const errors = [];
const covered = new Set();
let passed = 0;

for (const id of registerIds) if (!mdIds.has(id)) errors.push(`spec/amendments.md has no row for ${id}`);
for (const id of mdIds) if (!registerIds.has(id)) errors.push(`spec/amendments.md lists ${id}, which spec/amendments.json does not`);

for (const name of readdirSync(casesDir).sort()) {
  const dir = join(casesDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const where = `conformance/cases/${name}`;
  const inputPath = join(dir, "input.charter"), casePath = join(dir, "case.json");
  if (!existsSync(inputPath) || !existsSync(casePath)) { errors.push(`${where}: needs input.charter and case.json`); continue; }

  let spec;
  try { spec = JSON.parse(readFileSync(casePath, "utf8")); }
  catch (e) { errors.push(`${where}/case.json: ${e.message}`); continue; }
  if (typeof spec.title !== "string" || typeof spec.source !== "string") errors.push(`${where}: case.json needs "title" and "source"`);
  if (!Array.isArray(spec.covers)) errors.push(`${where}: case.json needs a "covers" list (it may be empty)`);
  for (const id of spec.covers ?? []) if (!registerIds.has(id)) errors.push(`${where}: covers unknown amendment ${id}`);
  const expectParse = spec.expect?.parse;
  if (expectParse === undefined) { errors.push(`${where}: case.json needs expect.parse`); continue; }

  const result = recognize(g, readFileSync(inputPath, "utf8"));
  let ok;
  if (expectParse === "ok") {
    ok = result.ok;
    if (!ok) errors.push(`${where}: expected to parse, but line ${result.line}:${result.col}: ${result.message}`);
  } else {
    const line = expectParse.error?.line;
    ok = !result.ok && (line === undefined || result.line === line);
    if (result.ok) errors.push(`${where}: expected a parse error, but it parsed`);
    else if (!ok) errors.push(`${where}: expected the parse error on line ${line}, got line ${result.line}: ${result.message}`);
  }
  if (ok) {
    passed++;
    for (const id of spec.covers ?? []) covered.add(id);
    if (verbose) console.log(`  pass  ${name}${result.ok ? "" : `  (rejected at ${result.line}:${result.col}: ${result.message})`}`);
  }
}

for (const a of register) {
  if (a.dueMilestone <= CURRENT_MILESTONE && !covered.has(a.id)) {
    errors.push(`${a.id} (${a.title}) is due by milestone ${a.dueMilestone} but no passing case covers it`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`conformance: ${e}`);
  process.exit(1);
}
const due = register.filter((a) => a.dueMilestone <= CURRENT_MILESTONE).length;
console.log(`check-conformance: ok (${passed} cases; ${due} amendments due by milestone ${CURRENT_MILESTONE}, all covered; ${register.length - due} due later)`);
