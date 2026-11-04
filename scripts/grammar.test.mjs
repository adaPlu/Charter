// Tests for the grammar tooling. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGrammar, grammarProblems, recognize, tokenize, grammarHash } from "./grammar.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "spec", "charter.ebnf"), "utf8");
const g = loadGrammar(text);
const expr = (src) => recognize(g, src, "expr").ok;

test("the frozen grammar is well-formed", () => {
  assert.deepEqual(grammarProblems(g), []);
});

test("the lock matches the grammar file", () => {
  const lock = JSON.parse(readFileSync(join(root, "spec", "grammar.lock.json"), "utf8"));
  assert.equal(lock.sha256, grammarHash(text));
});

test("hashing ignores Windows line endings", () => {
  assert.equal(grammarHash("a = b ;\r\n"), grammarHash("a = b ;\n"));
});

test("well-formedness checks catch broken grammars", () => {
  const problems = (src) => grammarProblems(loadGrammar(src));
  assert.match(problems(`program = thing ;`).join(), /undefined rule "thing"/);
  assert.match(problems(`program = "a" ; orphan = "b" ;`).join(), /"orphan" is unreachable/);
  assert.match(problems(`program = program "a" | "b" ;`).join(), /"program" is left-recursive/);
  assert.match(problems(`program = [ "x" ] program | "b" ;`).join(), /left-recursive/);
  assert.match(problems(`program = "a" ; program = "b" ;`).join(), /more than once/);
});

test("tokenizer separates numbers, durations, versions and requirement ids", () => {
  const kinds = (s) => tokenize(s).map((t) => t.kind + ":" + t.text);
  assert.deepEqual(kinds("30s 12 2.5 0.1.0 R-12 ms"), ["duration:30s", "int:12", "decimal:2.5", "version:0.1.0", "req_id:R-12", "word:ms"]);
  assert.deepEqual(kinds("a.b?? c => d"), ["word:a", "symbol:.", "word:b", "symbol:??", "word:c", "symbol:=>", "word:d"]);
  assert.deepEqual(kinds('"say \\"hi\\"" // comment'), ['string:"say \\"hi\\""']);
  assert.throws(() => tokenize('"unterminated'), (e) => /unterminated/.test(e.message));
});

test("expressions follow the precedence and associativity rules", () => {
  assert.ok(expr("a + b * c == d and not e or f"));
  assert.ok(expr("x ?? 0"));
  assert.ok(expr("forall v in result: exists x in Task: x.id == v.id"));
  assert.ok(expr("count x in C where x.p == p.id == 0"));
  assert.ok(expr("12 - sum o.qty for o in Order where o.product == p.id"));
  assert.ok(expr("select { id = t.id } for t in Task where t.done order by t.due, t.created"));
  assert.ok(expr("if a then b else if c then d else e"));
  assert.ok(expr("Player[a.player] ?? none"));
  assert.equal(expr("a == b == c"), false, "comparisons must not chain");
  assert.equal(expr("a +"), false);
  assert.equal(expr("result == ok"), false, "open question in section 8.6");
});

test("reserved words cannot be used as names, but capitalized forms can", () => {
  assert.equal(recognize(g, "module m@0.1.0 entity match { ext: Text }").ok, false);
  assert.ok(recognize(g, "module m@0.1.0 entity Match { ext: Text }").ok);
  assert.ok(expr("ms + s + m"), "duration units are not reserved words");
});

test("A18 is needed: without it, 'guard not exists ...' does not parse", () => {
  const before = loadGrammar(text.replace(`not_expr     = "not" not_expr | quant_expr | cmp_expr ;`, `not_expr     = [ "not" ] cmp_expr ;`));
  const src = "not exists c in Collaborator: c.user == u.id";
  assert.ok(recognize(g, src, "expr").ok);
  assert.equal(recognize(before, src, "expr").ok, false);
});

test("A19 is needed: without it, 'Error(_)' does not parse", () => {
  const before = loadGrammar(text.replace(`binder { "," binder }`, `ident { "," ident }`));
  const src = "match r { Value(s) => s, Error(_) => 0 }";
  assert.ok(recognize(g, src, "expr").ok);
  assert.equal(recognize(before, src, "expr").ok, false);
});
