#!/usr/bin/env node
// The charter command (design doc, section 8.4). Every command here runs with no AI model.
import { readFileSync, writeFileSync } from "node:fs";
import { parse, parseExpr, print, formatDiagnostic, type Program } from "@charter/syntax";
import { check, type CheckResult } from "@charter/types";
import { prove, proofDiagnostics, type ProofResult } from "@charter/verify";
import { interpreter, showOutcome, NotYet } from "@charter/interp";
import { runTests } from "@charter/testing";

const CACHE = ".charter-cache/proofs.json";
const OK = "✓", BAD = "✗", WARN = "⚠", INFO = "ℹ", SKIP = "○";

const USAGE = `charter <command> <file.charter> [options]

  check <file>                 parse, type-check and prove refinement obligations
  test <file> [--runs N]       run tests and properties on the reference interpreter
  run <file> <Query> [args]    call a query; each argument is a Charter expression
  fmt <file> [--check|--write] print the canonical form (--write refuses to delete comments
                               unless --force is given)
  ask "<request>"              natural-language interface (milestone 7; needs a model)

Every command except ask runs with no AI model.`;

interface Loaded { file: string; src: string; program: Program; checked: CheckResult; proofs: ProofResult[] }

function load(file: string, out: string[]): Loaded | null {
  let src: string;
  try { src = readFileSync(file, "utf8"); } catch { out.push(`${BAD} cannot read ${file}`); return null; }
  const parsed = parse(src);
  if (!parsed.program) {
    out.push(`${BAD} ${file} does not parse`);
    for (const d of parsed.diagnostics) out.push(formatDiagnostic(file, d));
    return null;
  }
  return { file, src, program: parsed.program, checked: check(parsed.program), proofs: [] };
}

async function cmdCheck(file: string, out: string[]): Promise<{ code: number; loaded?: Loaded }> {
  const l = load(file, out);
  if (!l) return { code: 1 };
  const decls = l.program.decls.length;
  out.push(`${OK} parsed (1 module, ${decls} declaration${decls === 1 ? "" : "s"})`);

  const typeErrors = l.checked.diagnostics.filter((d) => d.severity === "error");
  if (typeErrors.length) {
    out.push(`${BAD} types: ${typeErrors.length} error(s)`);
    for (const d of typeErrors) out.push(formatDiagnostic(file, d));
  } else out.push(`${OK} names and types`);

  l.proofs = await prove(l.checked.obligations, { cacheFile: CACHE });
  const errors = proofDiagnostics(l.proofs);
  const proven = l.proofs.filter((r) => r.status === "proven");
  const runtime = l.proofs.filter((r) => r.obligation.severity === "runtime" && r.status !== "proven");
  const parts = [`${proven.length} proven`];
  if (runtime.length) parts.push(`${runtime.length} kept as runtime checks`);
  if (errors.length) parts.push(`${errors.length} unproven`);
  out.push(`${errors.length ? BAD : OK} proof obligations: ${parts.join(", ")}`);
  for (const r of proven) out.push(`    proven         ${r.obligation.claim}  (line ${r.obligation.span.line})`);
  for (const r of runtime) out.push(`    runtime check  ${r.obligation.claim}  (line ${r.obligation.span.line})`);
  for (const d of errors) out.push(formatDiagnostic(file, d));

  for (const d of l.checked.diagnostics.filter((x) => x.severity === "info")) out.push(`${INFO} line ${d.span.line}: ${d.message}`);

  const reqs = l.program.decls.filter((d) => d.kind === "Requirement");
  const pending = reqs.filter((r) => r.status !== "confirmed");
  if (pending.length) {
    const ids = pending.map((r) => `${r.id} (${r.status})`).join(", ");
    out.push(`${WARN} ${pending.length} requirement(s) not confirmed: ${ids}. A release build is blocked until a person confirms them.`);
  }
  return { code: typeErrors.length || errors.length ? 1 : 0, loaded: l };
}

async function cmdTest(file: string, runs: number | undefined, out: string[]): Promise<number> {
  const quiet: string[] = [];
  const { code, loaded } = await cmdCheck(file, quiet);
  if (code !== 0 || !loaded) { out.push(...quiet, `${BAD} tests not run, because the program does not check`); return 1; }
  const results = runTests(loaded.program, loaded.checked, runs !== undefined ? { numRuns: runs } : {});
  if (!results.length) { out.push(`${INFO} ${file} has no tests or properties`); return 0; }
  for (const r of results) {
    const label = r.kind === "property" ? `property: ${r.name}` : r.name;
    if (r.status === "pass") out.push(`${OK} ${label}${r.cases ? ` (${r.cases.toLocaleString("en-US")} cases)` : ""}`);
    else if (r.status === "skip") out.push(`${SKIP} ${label}  (skipped: ${r.message})`);
    else out.push(`${BAD} ${label}\n    ${r.message}`);
  }
  const failed = results.filter((r) => r.status === "fail").length, skipped = results.filter((r) => r.status === "skip").length;
  out.push(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  return failed ? 1 : 0;
}

async function cmdRun(file: string, name: string | undefined, argTexts: string[], out: string[]): Promise<number> {
  if (!name) { out.push(`${BAD} run needs a query name`); return 2; }
  const l = load(file, out);
  if (!l) return 1;
  const errs = l.checked.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) { for (const d of errs) out.push(formatDiagnostic(file, d)); return 1; }
  const i = interpreter(l.program, l.checked, { now: Date.now() });
  try {
    const args = argTexts.map((t) => i.evalClosed(parseExpr(t)));
    const o = i.callQuery(name, args);
    out.push(showOutcome(o));
    return o.kind === "fault" ? 1 : 0;
  } catch (err) {
    if (err instanceof NotYet) { out.push(`${SKIP} ${err.message}`); return 1; }
    out.push(`${BAD} ${(err as Error).message}`);
    return 1;
  }
}

function cmdFmt(file: string, flags: Set<string>, out: string[]): number {
  const l = load(file, out);
  if (!l) return 1;
  const canonical = print(l.program);
  if (flags.has("--check")) {
    if (l.src.replace(/\r\n/g, "\n") === canonical) { out.push(`${OK} ${file} is in canonical form`); return 0; }
    out.push(`${BAD} ${file} is not in canonical form; run charter fmt ${file} --write`);
    return 1;
  }
  if (flags.has("--write")) {
    const comments = l.src.split("\n").filter((line) => /(^|\s)\/\//.test(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))).length;
    if (comments && !flags.has("--force")) {
      out.push(`${BAD} ${file} has ${comments} line(s) with comments. The canonical form has no comments, so --write would delete them. Use --force to write anyway.`);
      return 1;
    }
    writeFileSync(file, canonical);
    out.push(`${OK} wrote ${file}`);
    return 0;
  }
  out.push(canonical.trimEnd());
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, file, ...rest] = argv;
  const out: string[] = [];
  let code: number;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a, k) => !a.startsWith("--") && rest[k - 1] !== "--runs");
  switch (cmd) {
    case "check": code = file ? (await cmdCheck(file, out)).code : 2; break;
    case "test": {
      const k = rest.indexOf("--runs");
      code = file ? await cmdTest(file, k >= 0 ? Number(rest[k + 1]) : undefined, out) : 2;
      break;
    }
    case "run": code = file ? await cmdRun(file, positional[0], positional.slice(1), out) : 2; break;
    case "fmt": code = file ? cmdFmt(file, flags, out) : 2; break;
    case "ask": {
      const { ask } = await import("./commands/ask.ts");
      try { await ask([file, ...rest].join(" ")); code = 0; } catch (e) { out.push(`${SKIP} ${(e as Error).message}`); code = 1; }
      break;
    }
    default: out.push(USAGE); code = cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
  }
  if (code === 2 && !out.length) out.push(USAGE);
  process.stdout.write(out.join("\n") + "\n");
  return code;
}

// Z3 runs worker threads, so leave explicitly once the output is written.
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(70); });
