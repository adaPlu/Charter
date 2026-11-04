// Runs the conformance corpus through the real toolchain: parser, checker, Z3 and the test
// runner. Cases state their expected results in case.json under expect.check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "@charter/syntax";
import { check } from "@charter/types";
import { prove, proofDiagnostics } from "@charter/verify";
import { runTests } from "@charter/testing";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const casesDir = join(root, "conformance", "cases");

interface CheckExpect {
  errors: { code: string; line?: number; witness?: Record<string, string> }[];
  proven?: string[];
  runtime?: number;
  tests?: { pass: number; fail: number; skip: number };
}

const cases = readdirSync(casesDir).map((name) => ({
  name,
  src: readFileSync(join(casesDir, name, "input.charter"), "utf8"),
  check: (JSON.parse(readFileSync(join(casesDir, name, "case.json"), "utf8")) as { expect: { check?: CheckExpect } }).expect.check,
})).filter((c) => c.check);

test("the corpus has milestone 1 expectations to test", () => {
  assert.ok(cases.length >= 4, `only ${cases.length} cases have expect.check`);
});

for (const c of cases) {
  test(`conformance: ${c.name}`, async () => {
    const exp = c.check!;
    const parsed = parse(c.src);
    assert.ok(parsed.program, parsed.diagnostics[0]?.message);
    const checked = check(parsed.program);
    const proofs = await prove(checked.obligations);
    const errors = [...checked.diagnostics.filter((d) => d.severity === "error"), ...proofDiagnostics(proofs)];
    assert.deepEqual(errors.map((d) => d.code), exp.errors.map((e) => e.code), errors.map((d) => d.message).join("; "));
    exp.errors.forEach((e, i) => {
      if (e.line !== undefined) assert.equal(errors[i]!.span.line, e.line);
      if (e.witness) assert.deepEqual(errors[i]!.witness, e.witness);
    });
    if (exp.proven) {
      const proven = proofs.filter((r) => r.status === "proven").map((r) => r.obligation.claim);
      assert.deepEqual(proven, exp.proven);
    }
    if (exp.runtime !== undefined) {
      assert.equal(proofs.filter((r) => r.obligation.severity === "runtime" && r.status !== "proven").length, exp.runtime);
    }
    if (exp.tests) {
      const rs = runTests(parsed.program, checked);
      const count = (s: string) => rs.filter((r) => r.status === s).length;
      assert.deepEqual({ pass: count("pass"), fail: count("fail"), skip: count("skip") }, exp.tests);
    }
  });
}

test("the charter command reproduces the milestone 1 demo", () => {
  const calc = join(casesDir, "c001-calculator", "input.charter");
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, "packages", "cli", "src", "main.ts"), ...args], { encoding: "utf8", cwd: root });
  const checked = run("check", calc);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /proven {9}b is not zero/);
  const tested = run("test", calc);
  assert.equal(tested.status, 0, tested.stdout);
  assert.match(tested.stdout, /property: adding then subtracting gives back the first number \(1,000 cases\)/);
  assert.equal(run("run", calc, "Calculate", "1", "0", "Div").stdout.trim(), "Ok  Error(DivideByZero)");
  const broken = run("check", join(casesDir, "n005-division-unproven", "input.charter"));
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /error CH0401 {2}cannot prove that b is not zero\n {4}known: nothing\n {4}counterexample: b = 0/);
});
