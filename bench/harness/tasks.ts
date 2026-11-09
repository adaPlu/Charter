// Loading tasks and rendering their contracts. A task is the same for both languages: a plain
// request, an HTTP contract, and black-box tests that run unchanged against either program.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface Endpoint {
  name: string;
  params: [string, string][];
  returns: string;
  who: string;
  rejects?: Record<string, string>;
}

export interface Step {
  call: string;                          // "rules/Name" or "queries/Name"
  args: JsonValue[];                     // "$name" strings refer to saved values or constants
  as?: string;                           // caller id, usually "$name"
  system?: boolean;                      // an operator's system call
  expect: { status: number; reason?: string; value?: JsonValue; length?: number };
  save?: string;                         // remember the response value under this name
}

export interface Task {
  id: string;
  family: string;
  validationOnly: boolean;
  authoredBy: string;
  request: string;
  contract: { rules: Endpoint[]; queries: Endpoint[] };
  visibleTests: string[];
  tests: { name: string; steps: Step[] }[];
  constants: Record<string, { repeat: string; times: number }>;
  dir: string;
}

export function loadTasks(root: string, ids?: string[]): Task[] {
  const dir = join(root, "bench", "tasks");
  const all = readdirSync(dir).filter((d) => existsSync(join(dir, d, "task.json")));
  const pick = ids?.length ? ids : all;
  return pick.map((id) => {
    if (!all.includes(id)) throw new Error(`no task named ${id} in bench/tasks`);
    return { ...(JSON.parse(readFileSync(join(dir, id, "task.json"), "utf8")) as Omit<Task, "dir">), dir: join(dir, id) };
  });
}

function endpointText(kind: "rules" | "queries", e: Endpoint): string {
  const params = e.params.map(([n, t]) => `${n}: ${t}`).join(", ");
  const lines = [`- POST /${kind}/${e.name}  args: [${params}]  returns: ${e.returns}  allowed: ${e.who}`];
  for (const [reason, when] of Object.entries(e.rejects ?? {})) lines.push(`    rejects with ${reason} when ${when}`);
  return lines.join("\n");
}

/** The contract, in words both languages share. */
export function contractText(t: Task): string {
  return [
    "Every call is an HTTP POST with a JSON body {\"args\": [...]}, arguments in the order listed.",
    "The signed-in caller is the id in the X-Charter-Caller header; an operator's system call has X-Charter-System: true.",
    "Ids are strings. Responses: {\"outcome\": \"ok\", \"value\": ...} with status 200, or {\"outcome\": \"rejected\", \"reason\": ...}.",
    "Statuses: ValidationError 400, Denied 403 (404 for queries), NotFound 404, any other rejection 409.",
    "Types, in JSON terms: Text is a string, Int a whole number, Bool true or false, Id a string id, Record { ... } an object with those fields, List of ... an array; \"or null\" means the value may be null.",
    "",
    "Rules (they may change state):",
    ...t.contract.rules.map((e) => endpointText("rules", e)),
    "",
    "Queries (read only):",
    ...t.contract.queries.map((e) => endpointText("queries", e)),
  ].join("\n");
}

/** The visible tests, written out as example calls. Hidden tests are never shown to the model. */
export function examplesText(t: Task): string {
  return t.tests.filter((x) => t.visibleTests.includes(x.name)).map((x) => testText(x, "Example: ")).join("\n");
}

/** One test written out as calls, one line per step. Also used for the reviewers' packet. */
export function testText(test: Task["tests"][number], heading = ""): string {
  const out: string[] = [`${heading}${test.name}`];
  for (const s of test.steps) {
    const who = s.system ? "as the operator" : s.as ? `as ${s.as}` : "with no caller";
    const want = [`status ${s.expect.status}`];
    if (s.expect.reason) want.push(`reason ${s.expect.reason}`);
    if (s.expect.value !== undefined) want.push(`value ${JSON.stringify(s.expect.value)}`);
    if (s.expect.length !== undefined) want.push(`a list of ${s.expect.length}`);
    out.push(`  POST /${s.call} ${JSON.stringify(s.args)} ${who} -> ${want.join(", ")}${s.save ? ` (value saved as $${s.save})` : ""}`);
  }
  return out.join("\n");
}

/** Replaces "$name" with a saved value or a task constant, at any depth. */
export function substitute(v: JsonValue, saved: Map<string, JsonValue>, t: Task): JsonValue {
  if (typeof v === "string" && v.startsWith("$")) {
    const name = v.slice(1);
    if (saved.has(name)) return saved.get(name)!;
    const c = t.constants[name];
    if (c) return c.repeat.repeat(c.times);
    throw new Error(`test refers to $${name}, which is neither saved nor a constant`);
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, saved, t));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, saved, t)]));
  return v;
}
