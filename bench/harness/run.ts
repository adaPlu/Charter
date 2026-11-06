// The H1 pilot runner (design doc, 7.3). For every task, arm and sample: prompt the model,
// check the program, repair up to 3 times with the checker's diagnostics, then run the hidden
// tests. Writes one JSON line per run to <out>/runs.jsonl and the prompts to <out>/prompts/.
//
// Arms (design doc, 7.2):
//   A  Charter, constrained to spec/charter.gbnf    needs a backend that takes a grammar (llamacpp)
//   B  TypeScript, free decoding
//   C  Charter, free decoding
//   D  TypeScript, constrained                       not available: no TypeScript GBNF grammar exists
//
// Usage:
//   node bench/harness/run.ts --backend mock --arms B,C --samples 1 --out bench/results/dry-run
//   node bench/harness/run.ts --backend anthropic:claude-opus-5-5 --effort high --arms B,C --samples 3 --out …
// Options: --tasks id,id   --pilot (excludes validation-only tasks)   --repairs N (default 3)
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBackend, type Lang, type Turn } from "./backends.ts";
import { loadTasks, contractText, examplesText, type Task } from "./tasks.ts";
import { extractProgram, materialize, staticCheck, runHiddenTests } from "./evaluate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARMS: Record<string, { lang: Lang; constrained: boolean }> = {
  A: { lang: "charter", constrained: true },
  B: { lang: "typescript", constrained: false },
  C: { lang: "charter", constrained: false },
  D: { lang: "typescript", constrained: true },
};

const SYSTEM = "You write complete, correct programs from a specification. Follow the language manual exactly. Reply with the whole program.";

function prompt(task: Task, lang: Lang, constrained: boolean): string {
  const manual = readFileSync(join(root, "bench", "manual", lang === "charter" ? "charter.md" : "typescript.md"), "utf8");
  const reply = constrained
    ? "Reply with the program only: no code fence and no other text."
    : `Reply with one \`\`\`${lang} code block containing the whole program, and nothing else.`;
  return [manual, "## The task", task.request, "## The contract", contractText(task), "## Examples", examplesText(task) || "(none)", "## Your reply", reply].join("\n\n");
}

const arg = (name: string) => { const k = process.argv.indexOf(name); return k >= 0 ? process.argv[k + 1] : undefined; };

async function main() {
  const backendSpec = arg("--backend") ?? "mock";
  const out = resolve(arg("--out") ?? join(root, "bench", "results", `run-${Date.now()}`));
  const arms = (arg("--arms") ?? "B,C").split(",");
  const samples = Number(arg("--samples") ?? 1);
  const repairs = Number(arg("--repairs") ?? 3);
  let tasks = loadTasks(root, arg("--tasks")?.split(","));
  if (process.argv.includes("--pilot")) tasks = tasks.filter((t) => !t.validationOnly);
  if (!tasks.length) throw new Error("no tasks to run (with --pilot, validation-only tasks are excluded)");
  const backend = makeBackend(backendSpec, { effort: arg("--effort"), fallbacks: process.argv.includes("--fallbacks") });
  for (const a of arms) {
    const arm = ARMS[a];
    if (!arm) throw new Error(`unknown arm ${a}`);
    if (a === "D") throw new Error("arm D (constrained TypeScript) is not available: there is no TypeScript GBNF grammar. See bench/README.md.");
    if (arm.constrained && !backend.constrains) throw new Error(`arm ${a} needs a backend that constrains output to a grammar; ${backend.name} cannot`);
  }
  const grammar = readFileSync(join(root, "spec", "charter.gbnf"), "utf8");
  mkdirSync(join(out, "prompts"), { recursive: true });
  const meta = { started: new Date().toISOString(), backend: backend.name, arms, samples, repairs, tasks: tasks.map((t) => t.id) };
  if (!existsSync(join(out, "meta.json"))) writeFileSync(join(out, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

  for (const task of tasks) {
    for (const a of arms) {
      const { lang, constrained } = ARMS[a]!;
      const userPrompt = prompt(task, lang, constrained);
      writeFileSync(join(out, "prompts", `${task.id}-${a}.md`), userPrompt);
      for (let s = 0; s < samples; s++) {
        const work = join(out, "work", `${task.id}-${a}-${s}`);
        const started = Date.now();
        const turns: Turn[] = [{ role: "user", content: userPrompt }];
        const attempts: { valid: boolean; diagnostics: string; tokensIn: number; tokensOut: number }[] = [];
        let file = "", valid = false, refused = false, error: string | undefined, servedBy: string | undefined;
        try {
          for (let k = 0; k <= repairs && !valid; k++) {
            const reply = await backend.generate(SYSTEM, turns, { lang, task, attempt: k, seed: 1000 * s + k, ...(constrained ? { grammar } : {}) });
            servedBy = reply.servedBy ?? servedBy;
            if (reply.refused) { refused = true; attempts.push({ valid: false, diagnostics: "refused", tokensIn: reply.tokensIn, tokensOut: reply.tokensOut }); break; }
            const program = constrained ? reply.text : extractProgram(reply.text, lang);
            file = materialize(root, work, lang, program);
            writeFileSync(join(work, `attempt-${k}.${lang === "charter" ? "charter" : "ts"}`), program);
            const check = staticCheck(root, lang, file);
            valid = check.valid;
            attempts.push({ valid, diagnostics: check.diagnostics, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut });
            turns.push({ role: "assistant", content: reply.text });
            if (!valid) turns.push({ role: "user", content: `The program does not pass the checker. It reported:\n\n${check.diagnostics}\n\nReply with the corrected whole program, in the same form as before.` });
          }
        } catch (e) { error = (e as Error).message; }
        const tests = valid ? await runHiddenTests(root, lang, file, task, work) : [];
        const passed = tests.filter((t) => t.passed).length;
        const record = {
          task: task.id, validationOnly: task.validationOnly, family: task.family, arm: a, lang, constrained, backend: backend.name, servedBy, sample: s,
          validAt1: attempts[0]?.valid ?? false, validAtRepair: valid, repairsUsed: Math.max(0, attempts.length - 1), refused,
          testsPassed: passed, testsTotal: task.tests.length, semanticPass: valid ? passed / task.tests.length : 0, taskSuccess: valid && passed === task.tests.length,
          tokensIn: attempts.reduce((n, x) => n + x.tokensIn, 0), tokensOut: attempts.reduce((n, x) => n + x.tokensOut, 0),
          ms: Date.now() - started, attempts, tests, ...(error ? { error } : {}),
        };
        appendFileSync(join(out, "runs.jsonl"), JSON.stringify(record) + "\n");
        const mark = record.taskSuccess ? "pass" : valid ? `${passed}/${task.tests.length} tests` : refused ? "refused" : error ? `error: ${error.slice(0, 80)}` : "invalid";
        console.log(`${task.id}  arm ${a}  sample ${s}  valid@1=${record.validAt1}  valid@repair=${valid} (${record.repairsUsed} repairs)  ${mark}`);
      }
    }
  }
  console.log(`\nresults: ${join(out, "runs.jsonl")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
