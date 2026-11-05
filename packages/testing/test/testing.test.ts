import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@charter/syntax";
import { check } from "@charter/types";
import { runTests } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const load = (src: string) => {
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  return { p: r.program, c: check(r.program) };
};

test("the calculator's tests and property pass (Phase 5, example 1)", () => {
  const { p, c } = load(readFileSync(join(root, "conformance", "cases", "c001-calculator", "input.charter"), "utf8"));
  const results = runTests(p, c);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [
    ["divide by zero gives an error", "pass"],
    ["2.5 times 4 is 10", "pass"],
    ["too-large input is rejected", "pass"],
    ["adding then subtracting gives back the first number", "pass"],
  ]);
  assert.equal(results[3]!.cases, 1000);
});

test("a false property is caught, with a shrunk counterexample", () => {
  const { p, c } = load(`module m@0.1.0
query Half(x: Int where it >= 0 and it <= 1000): Int permit anyone = x / 2
property "halving then doubling gives back x"
  forall x: Int where it >= 0 and it <= 1000 {
    when Half(x) expect ok
    then result * 2 == x
  }`);
  const [r] = runTests(p, c);
  assert.equal(r!.status, "fail");
  assert.match(r!.message!, /^then result \* 2 == x was false/);
  const x = Number(/smallest failing input: x = (\d+)\)/.exec(r!.message!)?.[1]);
  assert.ok(x % 2 === 1 && x < 10, `expected a small odd counterexample, got ${x}`);
});

test("wrong outcomes and false then clauses are reported", () => {
  const { p, c } = load(`module m@0.1.0
query Q(x: Int where it > 0): Int permit anyone = x
test "rejects zero" { when Q(0) expect ok }
test "doubles" { when Q(2) expect ok then result == 4 }`);
  const rs = runTests(p, c);
  assert.match(rs[0]!.message!, /expected ok, got Rejected {2}ValidationError\(x\)/);
  assert.match(rs[1]!.message!, /then result == 4 was false \(outcome: Ok {2}2\)/);
});

test("tests with setups and rules run on a fresh store each time (Phase 5, example 4)", () => {
  const { p, c } = load(readFileSync(join(root, "conformance", "cases", "c004-shop-orders", "input.charter"), "utf8"));
  const rs = runTests(p, c, { numRuns: 100 });
  assert.deepEqual(rs.map((r) => [r.name, r.status]), [
    ["two orders for the last unit: one wins, one is rejected and not charged", "pass"],
    ["stock never goes negative across order sequences", "pass"],
  ]);
});

const shopSrc = () => readFileSync(join(root, "conformance", "cases", "c004-shop-orders", "input.charter"), "utf8");
const propertyStatus = (src: string) => {
  const { p, c } = load(src);
  return runTests(p, c, { numRuns: 200 }).find((x) => x.kind === "property")!;
};

test("a broken guard is contained by the invariant checked at commit", () => {
  // Without the stock guard, a large order would drive stock below zero. StockNonNegative
  // rejects that step at commit, nothing changes, and the property still holds.
  const r = propertyStatus(shopSrc().replace("guard p.stock >= qty else reject OutOfStock", "guard p.stock >= 0 else reject OutOfStock"));
  assert.equal(r.status, "pass");
});

test("a property about rules finds a counterexample when the rule is wrong", () => {
  // Without the decrement, orders are created but stock never moves. No invariant notices,
  // but the property's stock equation does.
  const r = propertyStatus(shopSrc().replace("  set p.stock = p.stock - qty                                                      req R-1\n", ""));
  assert.equal(r.status, "fail");
  assert.match(r.message!, /then p\.stock >= 0 and p\.stock == 12 - sum o\.qty for o in Order where o\.product == p\.id was false/);
});

test("runs are deterministic", () => {
  const src = readFileSync(join(root, "conformance", "cases", "c001-calculator", "input.charter"), "utf8");
  const a = load(src), b = load(src);
  assert.deepEqual(runTests(a.p, a.c, { numRuns: 200 }), runTests(b.p, b.c, { numRuns: 200 }));
});
