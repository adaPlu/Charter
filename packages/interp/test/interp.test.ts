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

// ---------------------------------------------------------------- rules and the store

const shop = `module shop@0.2.0
uses Payment.charge
principal Customer
entity Customer { name: Text, active: Bool = true }
entity Product  { name: Text, price: Money where >= 0, stock: Int where >= 0 }
entity Order { customer: Id<Customer>, product: Id<Product>, qty: Int, amount: Money }
enum OrderError { OutOfStock }
rule PlaceOrder(p: Product, qty: Int where > 0): Id<Order> rejects OrderError
  permit caller.active
  guard p.stock >= qty else reject OutOfStock
  let amount = p.price * qty
  set p.stock = p.stock - qty
  create Order { customer = caller.id, product = p.id, qty = qty, amount = amount } as o
  emit Payment.charge(caller.id, amount, o.id)
  return o.id
rule Break(p: Product) permit system  set p.stock = 0 - 1
rule DeleteProduct(p: Product) permit system  delete p
invariant StockNonNegative: Product.stock >= 0`;

test("a rule commits its writes, its effects and its step record together", () => {
  const i = run(shop);
  const ana = i.createRecord("Customer", [["name", { t: "text", v: "Ana" }]]);
  const lamp = i.createRecord("Product", [["name", { t: "text", v: "Lamp" }], ["price", arg(i, "40.00")], ["stock", arg(i, "1")]]);
  const r = i.callRule("PlaceOrder", [lamp, arg(i, "1")], { caller: ana });
  assert.equal(r.outcome.kind, "ok");
  assert.equal(r.effects.length, 1);
  assert.equal(show(i.evalClosed(parseExpr("count o in Order"))), "1");
  assert.equal(show(i.evalClosed(parseExpr("sum o.amount for o in Order"))), "40.00");
  assert.equal(i.store.outbox().length, 1);
  assert.equal(i.store.steps().length, 1);
});

test("two orders for the last unit: one wins, the other is rejected and changes nothing", () => {
  const i = run(shop);
  const a = i.createRecord("Customer", [["name", { t: "text", v: "Ana" }]]);
  const b = i.createRecord("Customer", [["name", { t: "text", v: "Ben" }]]);
  const lamp = i.createRecord("Product", [["name", { t: "text", v: "Lamp" }], ["price", arg(i, "40.00")], ["stock", arg(i, "1")]]);
  assert.equal(i.callRule("PlaceOrder", [lamp, arg(i, "1")], { caller: a }).outcome.kind, "ok");
  const second = i.callRule("PlaceOrder", [lamp, arg(i, "1")], { caller: b });
  assert.deepEqual(second.outcome, { kind: "reject", name: "OutOfStock" });
  assert.equal(second.effects.length, 0);
  assert.equal(i.store.outbox().length, 1, "the rejected order queued no charge");
  assert.equal(i.store.steps().length, 2, "the rejection is still logged");
});

test("permits, missing entities, refinements and invariants each reject correctly", () => {
  const i = run(shop);
  const off = i.createRecord("Customer", [["name", { t: "text", v: "Off" }], ["active", { t: "bool", v: false }]]);
  const on = i.createRecord("Customer", [["name", { t: "text", v: "On" }]]);
  const lamp = i.createRecord("Product", [["name", { t: "text", v: "Lamp" }], ["price", arg(i, "40.00")], ["stock", arg(i, "5")]]);
  assert.deepEqual(i.callRule("PlaceOrder", [lamp, arg(i, "1")], { caller: off }).outcome, { kind: "reject", name: "Denied" });
  assert.deepEqual(i.callRule("PlaceOrder", [lamp, arg(i, "1")], {}).outcome, { kind: "reject", name: "Denied" }, "no caller");
  assert.deepEqual(i.callRule("PlaceOrder", [{ t: "text", v: "nope" }, arg(i, "1")], { caller: on }).outcome, { kind: "reject", name: "NotFound", detail: "p" });
  assert.deepEqual(i.callRule("PlaceOrder", [lamp, arg(i, "0")], { caller: on }).outcome, { kind: "reject", name: "ValidationError", detail: "qty" });
  assert.deepEqual(i.callRule("Break", [lamp], { system: true }).outcome, { kind: "reject", name: "InvariantViolated", detail: "StockNonNegative" });
  assert.deepEqual(i.callRule("Break", [lamp], { caller: on }).outcome, { kind: "reject", name: "Denied" }, "permit system");
  assert.equal(show(i.evalClosed(parseExpr("sum p.stock for p in Product"))), "5", "nothing changed");
});

test("deleting a referenced entity breaks referential integrity and is rolled back", () => {
  const i = run(shop);
  const a = i.createRecord("Customer", [["name", { t: "text", v: "Ana" }]]);
  const lamp = i.createRecord("Product", [["name", { t: "text", v: "Lamp" }], ["price", arg(i, "40.00")], ["stock", arg(i, "5")]]);
  assert.equal(i.callRule("PlaceOrder", [lamp, arg(i, "1")], { caller: a }).outcome.kind, "ok");
  const r = i.callRule("DeleteProduct", [lamp], { system: true });
  assert.deepEqual(r.outcome, { kind: "reject", name: "InvariantViolated", detail: "Order.product must refer to an existing Product" });
});

test("Money rounds to cents, half to even", () => {
  const i = run("module m@0.1.0 fn f(p: Money, q: Decimal): Money = p * q");
  assert.equal(show(i.callFn("f", [arg(i, "10.00"), arg(i, "0.125")])), "1.25");
  assert.equal(show(i.callFn("f", [arg(i, "10.00"), arg(i, "0.135")])), "1.35");
  assert.equal(show(i.callFn("f", [arg(i, "1.00"), arg(i, "0.005")])), "0.00");
  assert.equal(show(i.callFn("f", [arg(i, "1.00"), arg(i, "0.015")])), "0.02");
});

test("replay reproduces every outcome and the exact state, ids included", () => {
  const i = run(shop.replace("rule Break", "rule Seed(n: Text) permit system  create Customer { name = n }\nrule Stock(n: Text, s: Int) permit system  create Product { name = n, price = 40.00, stock = s }\nrule Break"));
  i.callRule("Seed", [{ t: "text", v: "Ana" }], { system: true });
  i.callRule("Stock", [{ t: "text", v: "Lamp" }, arg(i, "2")], { system: true });
  const ana = i.evalClosed(parseExpr("select c for c in Customer")) as { t: "list"; items: never[] };
  const lamp = i.evalClosed(parseExpr("select p for p in Product")) as { t: "list"; items: never[] };
  for (let k = 0; k < 3; k++) i.callRule("PlaceOrder", [lamp.items[0]!, arg(i, "1")], { caller: ana.items[0]! });
  const r = i.replay();
  assert.equal(r.steps, 5);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.replayedHash, r.stateHash);
});

test("events run their triggers as later steps", () => {
  const i = run(`module m@0.1.0
entity Note { text: Text }
entity Log { line: Text }
event Noted(n: Id<Note>)
on Noted(n) do Record(n) as system
rule AddNote(t: Text) permit anyone
  create Note { text = t } as n
  raise Noted(n.id)
rule Record(n: Note) permit system
  create Log { line = "noted " + n.text }`);
  const r = i.callRule("AddNote", [{ t: "text", v: "hi" }]);
  assert.equal(r.outcome.kind, "ok");
  assert.deepEqual(r.triggered.map((t) => [t.rule, t.outcome.kind]), [["Record", "ok"]]);
  assert.equal(show(i.evalClosed(parseExpr("select l.line for l in Log"))), '["noted hi"]');
  assert.deepEqual(i.replay().mismatches, []);
});

test("nested refinements are enforced on inputs: list elements, record fields, optional named types", () => {
  // Found by writing a reference for pilot task p03: a score of 101 inside List<Score> was accepted.
  const i = run(`module nested@0.1.0
type Score = Int where it >= 0 and it <= 100
query A(xs: List<Int where it >= 0 and it <= 100>): Int permit anyone = len(xs)
query B(xs: List<Score>): Int permit anyone = len(xs)
query C(x: Score?): Int permit anyone = 1
query D(r: {n: Score}): Int permit anyone = 1
`);
  const q = (name: string, a: string) => showOutcome(i.callQuery(name, [arg(i, a)]));
  assert.equal(q("A", "[101]"), "Rejected  ValidationError(xs)");
  assert.equal(q("A", "[5]"), "Ok  1");
  assert.equal(q("B", "[3, -1]"), "Rejected  ValidationError(xs)");
  assert.equal(q("B", "[3, 4]"), "Ok  2");
  assert.equal(q("C", "101"), "Rejected  ValidationError(x)");
  assert.equal(q("C", "none"), "Ok  1");
  assert.equal(q("D", "{n = 101}"), "Rejected  ValidationError(r)");
  assert.equal(q("D", "{n = 1}"), "Ok  1");
});
