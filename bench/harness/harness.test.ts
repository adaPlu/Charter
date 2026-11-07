// The harness scores what it is supposed to score. With the mock backends no model is called
// and nothing is spent: every reference solution must pass the static check and every hidden
// test in both languages, and a broken first answer must be repaired from the diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const run = (backend: string) => {
  const out = mkdtempSync(join(tmpdir(), "charter-bench-"));
  try {
    const r = spawnSync(process.execPath, [join(root, "bench", "harness", "run.ts"), "--backend", backend, "--arms", "B,C", "--tasks", "v1-notes,v2-wallet", "--out", out], { encoding: "utf8", cwd: root, timeout: 300000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(join(out, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally { rmSync(out, { recursive: true, force: true }); }
};

test("reference solutions pass everything, in both languages", () => {
  const runs = run("mock");
  assert.equal(runs.length, 4);
  for (const r of runs) {
    assert.equal(r.validAt1, true, `${r.task} arm ${r.arm}: ${JSON.stringify((r.attempts as { diagnostics: string }[])[0]?.diagnostics)}`);
    assert.equal(r.taskSuccess, true, `${r.task} arm ${r.arm}: ${JSON.stringify(r.tests)}`);
  }
});

test("a broken first answer is repaired from the checker's diagnostics", () => {
  const runs = run("mock-repair");
  for (const r of runs) {
    assert.deepEqual([r.validAt1, r.validAtRepair, r.repairsUsed, r.taskSuccess], [false, true, 1, true], `${r.task} arm ${r.arm}`);
    const diag = (r.attempts as { diagnostics: string }[])[0]!.diagnostics;
    assert.doesNotMatch(diag, /charter-bench-/, "diagnostics must not show this machine's folders");
  }
});

test("the constrained TypeScript arm is refused, not faked", () => {
  const r = spawnSync(process.execPath, [join(root, "bench", "harness", "run.ts"), "--backend", "mock", "--arms", "D", "--out", join(tmpdir(), "charter-bench-unused")], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /arm D \(constrained TypeScript\) is not available/);
});
