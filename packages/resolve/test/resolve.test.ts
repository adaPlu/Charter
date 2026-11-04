import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@charter/syntax";
import { resolve, transitiveHashes } from "../src/index.ts";

const prog = (src: string) => {
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  return r.program;
};
const codes = (src: string) => resolve(prog(src)).diagnostics.map((d) => d.code);

test("every worked example resolves cleanly", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance", "cases");
  for (const name of readdirSync(dir).filter((n) => n.startsWith("c"))) {
    const src = readFileSync(join(dir, name, "input.charter"), "utf8");
    const diags = resolve(prog(src)).diagnostics;
    assert.deepEqual(diags.map((d) => `${d.span.line}: ${d.message}`), [], name);
  }
});

test("unknown names, duplicates and shadowing are reported", () => {
  assert.deepEqual(codes("module m@0.1.0 fn f(x: Int): Int = y"), ["CH0101"]);
  assert.deepEqual(codes("module m@0.1.0 fn f(x: Int): Int = x fn f(y: Int): Int = y"), ["CH0102"]);
  assert.deepEqual(codes("module m@0.1.0 enum A { X } enum B { X }"), ["CH0102"]);
  assert.deepEqual(codes("module m@0.1.0 fn f(x: Int): Int = count x in [1] where x > 0"), ["CH0103"]);
  assert.deepEqual(codes("module m@0.1.0 fn g(a: Int): Int = a fn f(g: Int): Int = g"), ["CH0103"]);
  assert.deepEqual(codes("module m@0.1.0 fn f(x: Int): Int = x  req R-9"), ["CH0101"]);
});

test("a change ripples into the transitive hash of every dependent, and nowhere else", () => {
  const base = "module m@0.1.0 fn a(x: Int): Int = x + 1\nfn b(x: Int): Int = a(x)\nfn c(x: Int): Int = x";
  const before = prog(base), after = prog(base.replace("x + 1", "x + 2"));
  const h0 = transitiveHashes(before, resolve(before)), h1 = transitiveHashes(after, resolve(after));
  assert.notEqual(h0.get("fndecl:a")!.transitive, h1.get("fndecl:a")!.transitive);
  assert.notEqual(h0.get("fndecl:b")!.transitive, h1.get("fndecl:b")!.transitive, "b calls a");
  assert.equal(h0.get("fndecl:b")!.own, h1.get("fndecl:b")!.own, "b's own text did not change");
  assert.equal(h0.get("fndecl:c")!.transitive, h1.get("fndecl:c")!.transitive, "c is unrelated");
});
