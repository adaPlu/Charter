import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseExpr } from "@charter/syntax";
import { check } from "@charter/types";
import { interpreter, divHalfEven, parseDec, formatDec, show, showOutcome, SCALE } from "../src/index.ts";

const run = (src: string) => {
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  const c = check(r.program);
  return interpreter(r.program, c);
};
const arg = (i: ReturnType<typeof run>, s: string) => i.evalClosed(parseExpr(s));

test("half-to-even rounding", () => {
  assert.equal(divHalfEven(5n, 2n), 2n);
  assert.equal(divHalfEven(7n, 2n), 4n);
  assert.equal(divHalfEven(-5n, 2n), -2n);
  assert.equal(divHalfEven(-7n, 2n), -4n);
  assert.equal(divHalfEven(10n, 3n), 3n);
  assert.equal(divHalfEven(-10n, 3n), -3n);
  assert.equal(divHalfEven(11n, 4n), 3n);
});

test("decimals parse and print exactly", () => {
  for (const s of ["0", "2.5", "-0.000000000000000001", "123456789.123456789123456789"]) assert.equal(formatDec(parseDec(s)), s);
  assert.equal(parseDec("1"), SCALE);
});

const calc = `module calc@0.1.0
type Input = Decimal where it >= -1000000000000000 and it <= 1000000000000000
enum Op { Add, Sub, Mul, Div }
enum CalcError { DivideByZero }
enum CalcResult { Value(v: Decimal), Error(e: CalcError) }
fn calculate(a: Decimal, b: Decimal, op: Op): CalcResult =
  match op { Add => Value(a + b), Sub => Value(a - b), Mul => Value(a * b),
             Div => if b == 0 then Error(DivideByZero) else Value(a / b) }
query Calculate(a: Input, b: Input, op: Op): CalcResult permit anyone = calculate(a, b, op)`;

test("the calculator answers like Phase 5 says it should", () => {
  const i = run(calc);
  const q = (a: string, b: string, op: string) => showOutcome(i.callQuery("Calculate", [arg(i, a), arg(i, b), arg(i, op)]));
  assert.equal(q("1", "0", "Div"), "Ok  Error(DivideByZero)");
  assert.equal(q("2.5", "4", "Mul"), "Ok  Value(10)");
  assert.equal(q("1", "3", "Div"), "Ok  Value(0.333333333333333333)");
  assert.equal(q("2", "3", "Div"), "Ok  Value(0.666666666666666667)");
  assert.equal(q("-1", "-2", "Sub"), "Ok  Value(1)");
  assert.equal(q("10000000000000000", "1", "Add"), "Rejected  ValidationError(a)");
});

test("integer overflow and decimal range are faults, not wrong answers", () => {
  const i = run("module m@0.1.0 fn big(x: Int): Int = x * x query Q(x: Int): Int permit anyone = big(x)");
  assert.equal(i.callQuery("Q", [arg(i, "100000000")]).kind, "fault");
  const ok = i.callQuery("Q", [arg(i, "3")]);
  assert.ok(ok.kind === "ok");
  assert.equal(show(ok.value), "9");
});

test("lists, aggregates and ordering", () => {
  const i = run(`module m@0.1.0
fn f(xs: List<Int>): List<Int> = select x * 10 for x in xs where x > 1 order by 0 - x
fn g(xs: List<Int>): Int = sum x for x in xs where x % 2 == 0
fn h(xs: List<Int>): Bool = forall x in xs: x > 0`);
  assert.equal(show(i.callFn("f", [arg(i, "[3, 1, 2]")])), "[30, 20]");
  assert.equal(show(i.callFn("g", [arg(i, "[1, 2, 3, 4]")])), "6");
  assert.equal(show(i.callFn("h", [arg(i, "[1, 2]")])), "true");
});
