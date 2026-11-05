// The exported GBNF grammar must accept every program the grammar accepts, written with a
// space between tokens, and reject what it rejects. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toGbnf } from "./export-gbnf.mjs";
import { parseGbnf, gbnfAccepts } from "./gbnf.mjs";
import { loadGrammar, tokenize, generate, seededRng, recognize } from "./grammar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ebnf = readFileSync(join(root, "spec", "charter.ebnf"), "utf8");
const rules = parseGbnf(toGbnf(ebnf));
const grammar = loadGrammar(ebnf);
/** A program as a constrained decoder would write it: one space between all tokens. */
const spaced = (src) => tokenize(src).map((t) => t.text).join(" ") + "\n";

test("the committed spec/charter.gbnf is the current export", () => {
  assert.equal(readFileSync(join(root, "spec", "charter.gbnf"), "utf8").replace(/\r\n/g, "\n"), toGbnf(ebnf));
});

test("every rule the GBNF grammar uses is defined", () => {
  const refs = new Set();
  const walk = (n) => { if (n.k === "ref") refs.add(n.v); (n.items ?? []).forEach(walk); if (n.item) walk(n.item); };
  for (const r of rules.values()) walk(r);
  assert.deepEqual([...refs].filter((r) => !rules.has(r)), []);
});

test("it accepts every conformance program that parses, and rejects the ones that do not", () => {
  const dir = join(root, "conformance", "cases");
  for (const name of readdirSync(dir)) {
    const src = readFileSync(join(dir, name, "input.charter"), "utf8");
    const ok = recognize(grammar, src).ok;
    const text = spaced(src);
    // Reserved words used as names are the one thing GBNF cannot rule out (see export-gbnf.mjs).
    if (name === "n002-reserved-word-name") { assert.equal(gbnfAccepts(rules, text), true); continue; }
    assert.equal(gbnfAccepts(rules, text), ok, `${name}: GBNF says ${!ok}, grammar says ${ok}`);
  }
});

test("it accepts random programs generated from the EBNF", () => {
  const rng = seededRng(99);
  for (let k = 0; k < 150; k++) {
    const src = generate(grammar, rng, "program", 6);
    assert.ok(gbnfAccepts(rules, spaced(src)), `rejected:\n${src}`);
  }
});

test("links after any clause are allowed (the precedence the exporter must keep)", () => {
  const src = "module m@0.1.0 requirement R-1 confirmed \"x\" rule R(a: Int) permit anyone let b = a req R-1 guard a > 0 else reject E req R-1";
  assert.ok(gbnfAccepts(rules, spaced(src)));
});
