import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@charter/syntax";
import { check } from "@charter/types";
import { prove, toSmtLib } from "../src/index.ts";

const obligationsOf = (src: string) => {
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  const c = check(r.program);
  assert.deepEqual(c.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), []);
  return c.obligations;
};

test("narrowing by an if proves the divisor is not zero", async () => {
  const [o] = obligationsOf("module m@0.1.0 fn f(a: Decimal, b: Decimal): Decimal = if b == 0 then 0 else a / b")
    .filter((x) => x.kind === "nonzero");
  const [r] = await prove([o!]);
  assert.equal(r!.status, "proven");
});

test("dividing without a check is refuted with a counterexample", async () => {
  const [o] = obligationsOf("module m@0.1.0 fn f(a: Decimal, b: Decimal): Decimal = a / b").filter((x) => x.kind === "nonzero");
  const [r] = await prove([o!]);
  assert.equal(r!.status, "refuted");
  assert.equal(r!.witness!.b, "0");
});

test("a refinement on a parameter is a usable fact", async () => {
  const [o] = obligationsOf("module m@0.1.0 fn f(a: Int, b: Int where it > 0): Int = a / b").filter((x) => x.kind === "nonzero");
  assert.equal((await prove([o!]))[0]!.status, "proven");
});

test("the right side of 'and' knows the left side holds", async () => {
  const [o] = obligationsOf("module m@0.1.0 fn f(a: Int, b: Int): Bool = b != 0 and a / b > 1").filter((x) => x.kind === "nonzero");
  assert.equal((await prove([o!]))[0]!.status, "proven");
});

test("return refinements are proven or refuted", async () => {
  const ok = obligationsOf("module m@0.1.0 fn f(x: Int where it >= 0): Int where it >= 1 = if x >= 5 then 2 else 1");
  assert.equal((await prove(ok))[0]!.status, "proven");
  const bad = obligationsOf("module m@0.1.0 fn f(x: Int where it >= 0): Int where it >= 1 = x");
  const [r] = await prove(bad.filter((o) => o.kind === "refinement"));
  assert.equal(r!.status, "refuted");
  assert.equal(r!.witness!.x, "0");
});

test("range checks are proven for bounded inputs and kept for unbounded ones", async () => {
  const bounded = obligationsOf("module m@0.1.0 fn f(a: Decimal where it <= 10 and it >= -10, b: Decimal where it <= 10 and it >= -10): Decimal = a + b");
  assert.equal((await prove(bounded))[0]!.status, "proven");
  const open = obligationsOf("module m@0.1.0 fn f(a: Decimal, b: Decimal): Decimal = a + b");
  assert.equal((await prove(open))[0]!.status, "unproven");
});

test("opaque terms never produce a false proof, and their counterexamples are marked approximate", async () => {
  const obs = obligationsOf('module m@0.1.0 fn f(t: Text): Int = 10 / len(t)').filter((o) => o.kind === "nonzero");
  const [r] = await prove(obs);
  assert.equal(r!.status, "unproven");
  assert.equal(r!.approximate, true);
});

test("results are cached by the exact query, and the cache is stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "charter-proofs-"));
  try {
    const file = join(dir, "proofs.json");
    const obs = obligationsOf("module m@0.1.0 fn f(a: Int, b: Int where it > 0): Int = a / b");
    const first = await prove(obs, { cacheFile: file });
    const saved = readFileSync(file, "utf8");
    const second = await prove(obs, { cacheFile: file });
    assert.ok(first.every((r) => !r.cached));
    assert.ok(second.every((r) => r.cached));
    assert.deepEqual(second.map((r) => r.status), first.map((r) => r.status));
    assert.equal(readFileSync(file, "utf8"), saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the SMT-LIB form is readable", () => {
  const [o] = obligationsOf("module m@0.1.0 fn f(a: Decimal, b: Decimal): Decimal = if b == 0 then 0 else a / b").filter((x) => x.kind === "nonzero");
  assert.equal(toSmtLib(o!), [
    "(declare-const |b| Real)",
    "(assert (< (- 100000000000000000000000000000000000000.0) |b| 100000000000000000000000000000000000000.0))",
    "(assert (not (= |b| 0.0)))",
    "(assert (not (not (= |b| 0.0))))",
    "(check-sat)",
  ].join("\n"));
});

test("a compensation is checked against the state when it runs, not the step's own writes", async () => {
  const src = `module m@0.1.0
uses Pay.charge
entity P { stock: Int where >= 0 }
rule Take(p: P, q: Int where it >= 1 and it <= 10) permit anyone
  guard p.stock >= q else reject Out
  set p.stock = p.stock - q
  emit Pay.charge(q)
    compensate { set p.stock = p.stock + q }
enum E { Out }`.replace("permit anyone", "rejects E permit anyone");
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  const c = check(r.program);
  assert.deepEqual(c.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), []);
  const results = await prove(c.obligations);
  const byClaim = Object.fromEntries(results.map((x) => [`${x.obligation.claim}@${x.obligation.span.line}`, x.status]));
  // In the step: stock >= q >= 1, so stock - q cannot overflow.
  assert.equal(byClaim["p.stock - q stays within the Int range@6"], "proven");
  // Later, stock may have grown to the maximum, so adding q may overflow: a runtime check.
  assert.equal(byClaim["p.stock + q stays within the Int range@8"], "unproven");
});

test("facts about a field describe its old value after a write, and aliases become unknown", async () => {
  const base = `module m@0.1.0
entity P { stock: Int where >= 0, hold: Int }
fn half(x: Int where >= 0): Int = x / 2
rule Shift(a: P, b: P) permit anyone
  BODY`;
  const status = async (body: string) => {
    const c = check(parse(base.replace("BODY", body)).program!);
    assert.deepEqual(c.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), []);
    return (await prove(c.obligations.filter((o) => o.kind === "refinement")))[0]!.status;
  };
  // After the write, a.stock means old + 1, and old >= 0 is still a fact about the old value.
  assert.equal(await status(`set a.stock = a.stock + 1
  set b.hold = half(a.stock)`), "proven");
  // Writing b.stock may write a.stock too (a and b could be the same P), so a.stock is unknown.
  assert.equal(await status(`set b.stock = 0
  set a.hold = half(a.stock)`), "unproven");
  // Writing a different field of b leaves a.stock alone.
  assert.equal(await status(`set b.hold = 0 - 5
  set a.hold = half(a.stock)`), "proven");
});
