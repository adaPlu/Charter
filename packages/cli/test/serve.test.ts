// The milestone 2 demo (design doc, section 8.5): the to-do app from Phase 5, example 2,
// served over HTTP and tested from outside, as a client would, with replay checking the state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const main = join(root, "packages", "cli", "src", "main.ts");
const app = join(root, "examples", "todo", "todo.charter");

const charter = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: "utf8", cwd: root });

function startServer(db: string): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [main, "serve", app, "--db", db, "--port", "0"], { cwd: root });
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /serving .* on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      if (m) resolve({ proc, url: m[1]! });
    });
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}: ${buf}`)));
  });
}

test("the to-do app works over HTTP, and replay reproduces its state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "charter-serve-"));
  const db = join(dir, "todo.db");
  try {
    // An operator registers two users from the command line, on the same database.
    const reg = (name: string) => {
      const r = charter("run", app, "Register", `"${name}"`, "--system", "--db", db);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return /User#([0-9a-f]+)/.exec(r.stdout)![1]!;
    };
    const ana = reg("Ana"), ben = reg("Ben");

    const { proc, url } = await startServer(db);
    try {
      const call = async (path: string, args: unknown[], as?: string) => {
        const res = await fetch(url + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...(as ? { "x-charter-caller": as } : {}) },
          body: JSON.stringify({ args }),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };

      const added = await call("/rules/AddTask", ["Buy milk", null], ana);
      assert.equal(added.status, 200);
      const taskId = added.body.value as string;

      const later = await call("/rules/AddTask", ["File taxes", "2026-12-01T00:00:00Z"], ana);
      assert.equal(later.status, 200);

      const list = await call("/queries/MyTasks", [], ana);
      assert.equal(list.status, 200);
      assert.deepEqual((list.body.value as { title: string }[]).map((t) => t.title), ["File taxes", "Buy milk"], "dated first, undated last (R-8)");

      assert.deepEqual((await call("/queries/MyTasks", [], ben)).body.value, [], "Ben sees none of Ana's tasks (R-5)");
      assert.equal((await call("/rules/CompleteTask", [taskId], ben)).status, 403, "Ben cannot complete Ana's task");
      assert.equal((await call("/rules/CompleteTask", [taskId], ana)).status, 200);
      const again = await call("/rules/CompleteTask", [taskId], ana);
      assert.deepEqual([again.status, again.body.reason], [409, "AlreadyDone"], "done tasks cannot be reopened (R-7)");
      const blank = await call("/rules/AddTask", ["   ", null], ana);
      assert.deepEqual([blank.status, blank.body.reason, blank.body.detail], [400, "ValidationError", "title"], "blank titles are rejected (R-6)");
      assert.equal((await call("/rules/AddTask", ["No caller", null])).status, 403, "anyone means any signed-in caller");
      assert.equal((await call("/rules/DeleteTask", ["no-such-task"], ana)).status, 404);
      assert.equal((await call("/rules/Register", ["Mallory"], ana)).status, 403, "only the operator registers users");

      const schema = await (await fetch(url + "/schema")).json() as { name: string }[];
      assert.ok(schema.some((s) => s.name === "MyTasks"));
    } finally {
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
    }

    // Everything above, including the rejections, is in the step log. Replaying it on an
    // empty store must reproduce every outcome and the exact state, ids included.
    const rep = charter("replay", app, "--db", db);
    assert.equal(rep.status, 0, rep.stdout);
    // 2 registrations and 9 rule calls over HTTP, rejections included. Queries are not steps.
    assert.match(rep.stdout, /replayed 11 logged step\(s\)/);
    assert.match(rep.stdout, /state hash matches/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
