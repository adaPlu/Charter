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
  assert.equal(toSmtLib(o!), "(declare-const |b| Real)\n(assert (not (= |b| 0.0)))\n(assert (not (not (= |b| 0.0))))\n(check-sat)");
});
