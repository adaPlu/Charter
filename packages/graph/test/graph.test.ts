import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@charter/syntax";
import { encodeCbor, toGraph, ownHash } from "../src/index.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("CBOR encoding matches RFC 8949 examples", () => {
  assert.equal(hex(encodeCbor(0)), "00");
  assert.equal(hex(encodeCbor(23)), "17");
  assert.equal(hex(encodeCbor(24)), "1818");
  assert.equal(hex(encodeCbor(1000)), "1903e8");
  assert.equal(hex(encodeCbor(1000000)), "1a000f4240");
  assert.equal(hex(encodeCbor(-1)), "20");
  assert.equal(hex(encodeCbor(-1000)), "3903e7");
  assert.equal(hex(encodeCbor("IETF")), "6449455446");
  assert.equal(hex(encodeCbor("ü")), "62c3bc");
  assert.equal(hex(encodeCbor([1, [2, 3], [4, 5]])), "8301820203820405");
  assert.equal(hex(encodeCbor({ a: 1, b: [2, 3] })), "a26161016162820203");
});

test("map keys are sorted by encoded bytes, not insertion order", () => {
  assert.equal(hex(encodeCbor({ b: 1, a: 2, aa: 3 })), hex(encodeCbor({ aa: 3, a: 2, b: 1 })));
  // Shorter keys sort first because their length byte is smaller.
  assert.equal(hex(encodeCbor({ aa: 1, b: 2 })), "a261620262616101");
});

const prog = (src: string) => {
  const r = parse(src);
  assert.ok(r.program, r.diagnostics[0]?.message);
  return r.program;
};

test("hashes ignore layout, comments and requirement links", () => {
  const a = prog("module m@0.1.0\nfn f(x: Int): Int = x + 1  req R-1");
  const b = prog("module m@0.1.0   // a comment\n\n\nfn f(x: Int): Int =\n   x+1");
  assert.equal(ownHash(a.decls[0]!), ownHash(b.decls[0]!));
  assert.equal(toGraph(a).nodes["fndecl:f"]!.hash, toGraph(b).nodes["fndecl:f"]!.hash);
  assert.deepEqual(toGraph(a).links, [["fndecl:f", "R-1"]]);
});

test("hashes change when meaning changes", () => {
  const a = prog("module m@0.1.0 fn f(x: Int): Int = x + 1");
  const b = prog("module m@0.1.0 fn f(x: Int): Int = x + 2");
  assert.notEqual(ownHash(a.decls[0]!), ownHash(b.decls[0]!));
});

test("graph nodes have path anchors and child lists", () => {
  const g = toGraph(prog("module m@0.1.0 enum Op { Add, Sub } fn f(o: Op): Int = match o { Add => 1, Sub => 2 }"));
  assert.equal(g.root, "module");
  assert.deepEqual(g.nodes["module"]!.children, ["enumdecl:Op", "fndecl:f"]);
  assert.ok(g.nodes["fndecl:f/body/arms.1"], "match arms are nodes");
  assert.equal(g.nodes["enumdecl:Op/variants.0"]!.attrs.name, "Add");
});
