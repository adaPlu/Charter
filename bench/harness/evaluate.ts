// Scoring a generated program: the static check (valid@1, valid@repair), then the hidden
// black-box tests (semantic pass rate), run over HTTP against a fresh server per test.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Lang } from "./backends.ts";
import { substitute, type Task, type JsonValue } from "./tasks.ts";

export interface CheckResult { valid: boolean; diagnostics: string }

/** Extracts the program from a reply: the first fenced block, or the whole reply if there is none. */
export function extractProgram(reply: string, lang: Lang): string {
  const tags = lang === "charter" ? ["charter", ""] : ["typescript", "ts", ""];
  for (const tag of tags) {
    const m = new RegExp("```" + tag + "[^\\n]*\\n([\\s\\S]*?)```").exec(reply);
    if (m) return m[1]!;
  }
  return reply;
}

/** Writes the program into its work folder, with the scaffold for TypeScript. Returns the program's path. */
export function materialize(root: string, work: string, lang: Lang, program: string): string {
  mkdirSync(work, { recursive: true });
  if (lang === "charter") {
    const file = join(work, "program.charter");
    writeFileSync(file, program);
    return file;
  }
  const scaffold = join(root, "bench", "scaffold-ts");
  for (const f of ["runtime.ts", "server.ts"]) copyFileSync(join(scaffold, f), join(work, f));
  writeFileSync(join(work, "app.ts"), program);
  // Without this, tsc treats the files as CommonJS and rejects top-level await in the scaffold.
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  writeFileSync(join(work, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
      allowImportingTsExtensions: true, erasableSyntaxOnly: true, skipLibCheck: true,
      types: ["node"], typeRoots: [resolve(root, "node_modules", "@types")],
    },
    include: ["app.ts", "runtime.ts", "server.ts"],
  }, null, 2));
  return join(work, "app.ts");
}

const truncate = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);

/** Diagnostics as the model should see them: file names, not this machine's folders. */
function tidy(text: string, file: string): string {
  const dir = dirname(file);
  let out = text;
  for (const d of [dir, dir.replace(/\\/g, "/"), dir.replace(/\//g, "\\")]) out = out.split(d + "\\").join("").split(d + "/").join("");
  return out;
}

/** The full static check: charter check for Charter, tsc --strict for TypeScript. */
export function staticCheck(root: string, lang: Lang, file: string): CheckResult {
  if (lang === "charter") {
    const r = spawnSync(process.execPath, [join(root, "packages", "cli", "src", "main.ts"), "check", file], { encoding: "utf8", cwd: root, timeout: 180000 });
    const errors = r.stdout.split("\n").filter((l) => /error CH\d+|does not parse|✗/.test(l) || /^ {4}(known|counterexample|fix)/.test(l));
    return { valid: r.status === 0, diagnostics: truncate(tidy(errors.join("\n") || r.stdout + r.stderr, file)) };
  }
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", join(file, "..", "tsconfig.json")], { encoding: "utf8", cwd: root, timeout: 180000 });
  return { valid: r.status === 0, diagnostics: truncate(tidy((r.stdout + r.stderr).trim(), file)) };
}

function startServer(root: string, lang: Lang, file: string, db: string): Promise<{ proc: ChildProcess; url: string }> {
  const args = lang === "charter"
    ? [join(root, "packages", "cli", "src", "main.ts"), "serve", file, "--db", db, "--port", "0", "--dev-system-header"]
    : [join(file, "..", "server.ts"), file, db, "0"];
  return new Promise((ok, fail) => {
    const proc = spawn(process.execPath, args, { cwd: root });
    let out = "";
    const timer = setTimeout(() => { proc.kill(); fail(new Error(`server did not start within 20s: ${out.slice(-500)}`)); }, 20000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) { clearTimeout(timer); ok({ proc, url: m[1]! }); }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("exit", (code) => { clearTimeout(timer); fail(new Error(`server exited with ${code}: ${out.slice(-500)}`)); });
  });
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface TestOutcome { name: string; passed: boolean; failure?: string }

/** Runs every hidden test of a task against the program, each on a fresh server and database. */
export async function runHiddenTests(root: string, lang: Lang, file: string, task: Task, work: string): Promise<TestOutcome[]> {
  const out: TestOutcome[] = [];
  for (const [k, test] of task.tests.entries()) {
    let server: { proc: ChildProcess; url: string } | null = null;
    try {
      server = await startServer(root, lang, file, join(work, `test-${k}.db`));
      const saved = new Map<string, JsonValue>();
      let failure: string | undefined;
      for (const [n, step] of test.steps.entries()) {
        const args = substitute(step.args, saved, task);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (step.as) headers["x-charter-caller"] = String(substitute(step.as, saved, task));
        if (step.system) headers["x-charter-system"] = "true";
        const res = await fetch(`${server.url}/${step.call}`, { method: "POST", headers, body: JSON.stringify({ args }), signal: AbortSignal.timeout(15000) });
        const body = await res.json().catch(() => ({})) as { value?: JsonValue; reason?: string };
        const want = step.expect;
        const problems: string[] = [];
        if (res.status !== want.status) problems.push(`status ${res.status}, expected ${want.status}${body.reason ? ` (${body.reason})` : ""}`);
        if (want.reason && body.reason !== want.reason) problems.push(`reason ${body.reason}, expected ${want.reason}`);
        if (want.value !== undefined && !deepEqual(body.value, substitute(want.value, saved, task))) problems.push(`value ${JSON.stringify(body.value)}, expected ${JSON.stringify(substitute(want.value, saved, task))}`);
        if (want.length !== undefined && !(Array.isArray(body.value) && body.value.length === want.length)) problems.push(`expected a list of ${want.length}, got ${JSON.stringify(body.value)}`);
        if (problems.length) { failure = `step ${n + 1} (POST /${step.call}): ${problems.join("; ")}`; break; }
        if (step.save) saved.set(step.save, body.value ?? null);
      }
      out.push(failure ? { name: test.name, passed: false, failure } : { name: test.name, passed: true });
    } catch (e) {
      out.push({ name: test.name, passed: false, failure: (e as Error).message });
    } finally {
      if (server) { server.proc.kill(); await new Promise((r) => server!.proc.once("exit", r)); }
    }
  }
  return out;
}
