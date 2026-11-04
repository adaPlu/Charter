import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, print, stripSpans, RESERVED, lex } from "../src/index.ts";
import { loadGrammar, recognize, generate, seededRng, TOKEN_CLASSES, LEXICAL_HELPERS } from "../../../scripts/grammar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const grammar = loadGrammar(readFileSync(join(root, "spec", "charter.ebnf"), "utf8"));
const casesDir = join(root, "conformance", "cases");
const cases = readdirSync(casesDir).map((name) => ({
  name,
  src: readFileSync(join(casesDir, name, "input.charter"), "utf8"),
  spec: JSON.parse(readFileSync(join(casesDir, name, "case.json"), "utf8")) as { expect: { parse: unknown } },
}));

function roundTrip(src: string, label: string): void {
  const first = parse(src);
  assert.ok(first.program, `${label}: ${first.diagnostics[0]?.message}`);
  const printed = print(first.program);
  const second = parse(printed);
  assert.ok(second.program, `${label}: canonical form does not parse: ${second.diagnostics[0]?.message}\n${printed}`);
  assert.deepEqual(stripSpans(second.program), stripSpans(first.program), `${label}: round trip changed the tree\n${printed}`);
  assert.equal(print(second.program), printed, `${label}: printing is not idempotent`);
}

test("reserved words match the frozen grammar's lock", () => {
  const lock = JSON.parse(readFileSync(join(root, "spec", "grammar.lock.json"), "utf8")) as { reservedWords: string[] };
  assert.deepEqual([...RESERVED].sort(), lock.reservedWords);
});

test("the parser agrees with the grammar recognizer on every conformance case", () => {
  for (const c of cases) {
    const ours = parse(c.src);
    const theirs = recognize(grammar, c.src);
    assert.equal(!!ours.program, theirs.ok, `${c.name}: parser says ${!!ours.program}, recognizer says ${theirs.ok}`);
    if (!theirs.ok) assert.equal(ours.diagnostics[0]?.span.line, theirs.line, `${c.name}: error line differs`);
  }
});

test("every parsing conformance case survives a round trip through the canonical printer", () => {
  for (const c of cases) if (c.spec.expect.parse === "ok") roundTrip(c.src, c.name);
});

test("every syntactic production of the grammar is exercised by the corpus", () => {
  const covered = new Set<string>();
  for (const c of cases) for (const r of parse(c.src).coverage) if (parse(c.src).program) covered.add(r);
  const syntactic = grammar.order.filter((r) => !TOKEN_CLASSES.includes(r) && !LEXICAL_HELPERS.includes(r));
  const missing = syntactic.filter((r) => !covered.has(r));
  assert.deepEqual(missing, [], `productions never exercised: ${missing.join(", ")}`);
});

test("fuzz: random programs generated from the EBNF parse and round-trip", () => {
  const rng = seededRng(20261104);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const src = generate(grammar, rng);
    assert.ok(recognize(grammar, src).ok, `generator produced a non-sentence:\n${src}`);
    roundTrip(src, `fuzz #${i}`);
    n++;
  }
  assert.equal(n, 400);
});

test("fuzz: random expressions round-trip, including deeply nested ones", () => {
  const rng = seededRng(7);
  for (let i = 0; i < 1500; i++) {
    const e = generate(grammar, rng, "expr", 9);
    roundTrip(`module m@0.1.0 invariant I: ${e}`, `expr #${i}: ${e}`);
  }
});

test("chained comparisons get a helpful message", () => {
  const r = parse("module m@0.1.0 invariant I: a == b == c");
  assert.match(r.diagnostics[0]!.message, /Comparisons do not chain/);
});

test("reserved words used as names are explained", () => {
  const r = parse("module m@0.1.0 entity match { x: Int }");
  assert.match(r.diagnostics[0]!.message, /reserved word/);
});

test("lexer positions are 1-based lines and columns", () => {
  const t = lex("module m\n  @0.1.0");
  assert.deepEqual(t.map((x) => [x.text, x.span.line, x.span.col]).slice(0, 3), [["module", 1, 1], ["m", 1, 8], ["@", 2, 3]]);
});
