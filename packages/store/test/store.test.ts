import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, canonicalJson } from "../src/index.ts";

test("records round-trip, scan in id order, and delete", () => {
  const s = new Store();
  s.transaction(() => { s.put("Task", "b", { title: "B" }); s.put("Task", "a", { title: "A" }); return {}; });
  assert.deepEqual(s.scan("Task").map((r) => r.id), ["a", "b"]);
  s.transaction(() => { s.delete("Task", "a"); return {}; });
  assert.equal(s.get("Task", "a"), undefined);
  assert.deepEqual(s.get("Task", "b"), { title: "B" });
});

test("a throwing or rolled-back transaction leaves no trace", () => {
  const s = new Store();
  assert.throws(() => s.transaction(() => { s.put("T", "x", { v: 1 }); throw new Error("boom"); }));
  s.transaction(() => { s.put("T", "y", { v: 1 }); return { rollback: true }; });
  assert.deepEqual(s.scan("T"), []);
});

test("the state hash ignores insertion order and key order", () => {
  const a = new Store(), b = new Store();
  a.transaction(() => { a.put("T", "1", { x: 1, y: 2 }); a.put("T", "2", { x: 3 }); return {}; });
  b.transaction(() => { b.put("T", "2", { x: 3 }); b.put("T", "1", { y: 2, x: 1 }); return {}; });
  assert.equal(a.stateHash(), b.stateHash());
});

test("data survives closing and reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "charter-store-"));
  try {
    const file = join(dir, "app.db");
    const s = new Store(file);
    s.transaction(() => { s.put("Task", "a", { title: "Buy milk" }); s.logStep({ n: 1, rule: "AddTask", caller: "u", system: false, args: ["Buy milk"], now: 0, seed: "s", outcome: "ok" }); return {}; });
    const hash = s.stateHash();
    s.close();
    const again = new Store(file);
    assert.deepEqual(again.get("Task", "a"), { title: "Buy milk" });
    assert.equal(again.stateHash(), hash);
    assert.equal(again.nextStep(), 2);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canonical JSON sorts keys at every level", () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
});
