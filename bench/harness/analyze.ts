// Summarizes a pilot run and applies the decision rule (design doc, 7.3).
//   node bench/harness/analyze.ts <run folder> [--include-validation]
//
// Metrics per arm: valid@1, valid@repair, semantic pass rate (hidden tests passed; an invalid
// program scores 0), task success, and tokens. The comparison is Charter against TypeScript
// under the same decoding: C against B (free), or A against D (constrained, when D exists).
// Confidence intervals come from a bootstrap over tasks, because samples of one task are not
// independent. The pilot's kill criterion: a valid@1 gain under 5 points and a lower semantic
// pass rate means stopping for a design review.
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Run {
  task: string; validationOnly: boolean; arm: string; backend: string;
  validAt1: boolean; validAtRepair: boolean; semanticPass: number; taskSuccess: boolean; tokensIn: number; tokensOut: number; refused: boolean; error?: string;
}

const dir = process.argv[2];
if (!dir) { console.error("usage: node bench/harness/analyze.ts <run folder> [--include-validation]"); process.exit(2); }
const all = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run);
const runs = process.argv.includes("--include-validation") ? all : all.filter((r) => !r.validationOnly);
if (!runs.length) {
  console.log("No pilot runs to analyze: every run is on a validation-only task. Pass --include-validation to summarize them anyway (not evidence).");
  process.exit(0);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? "  n/a" : `${(100 * x).toFixed(1).padStart(5)}%`);

/** Per-task means of a metric for one arm. */
function perTask(arm: string, f: (r: Run) => number): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of runs.filter((x) => x.arm === arm)) by.set(r.task, [...(by.get(r.task) ?? []), f(r)]);
  return new Map([...by].map(([t, xs]) => [t, mean(xs)]));
}

/** Bootstrap 95% interval of mean(a - b) over tasks both arms ran. */
function bootstrap(a: Map<string, number>, b: Map<string, number>): { diff: number; lo: number; hi: number; n: number } {
  const tasks = [...a.keys()].filter((t) => b.has(t));
  const d = tasks.map((t) => a.get(t)! - b.get(t)!);
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const reps: number[] = [];
  for (let k = 0; k < 10000; k++) reps.push(mean(d.map(() => d[Math.floor(rand() * d.length)]!)));
  reps.sort((x, y) => x - y);
  return { diff: mean(d), lo: reps[249]!, hi: reps[9749]!, n: tasks.length };
}

const arms = [...new Set(runs.map((r) => r.arm))].sort();
console.log(`Runs: ${runs.length} on ${new Set(runs.map((r) => r.task)).size} task(s), backend ${[...new Set(runs.map((r) => r.backend))].join(", ")}`);
if (runs.some((r) => r.validationOnly)) console.log("Includes validation-only tasks written by the design process: NOT evidence for H1.");
console.log("\narm  runs  valid@1  valid@repair  semantic  success  tokens in/out (mean)  refused  errors");
for (const a of arms) {
  const rs = runs.filter((r) => r.arm === a);
  console.log(`${a.padEnd(4)} ${String(rs.length).padStart(4)}   ${pct(mean(rs.map((r) => +r.validAt1)))}       ${pct(mean(rs.map((r) => +r.validAtRepair)))}    ${pct(mean(rs.map((r) => r.semanticPass)))}   ${pct(mean(rs.map((r) => +r.taskSuccess)))}   ${Math.round(mean(rs.map((r) => r.tokensIn)))}/${Math.round(mean(rs.map((r) => r.tokensOut)))}`.padEnd(84) + `${rs.filter((r) => r.refused).length}        ${rs.filter((r) => r.error).length}`);
}

const pairs: [string, string, string][] = [["C", "B", "free decoding"], ["A", "D", "constrained decoding"]];
for (const [ch, ts, label] of pairs) {
  if (!arms.includes(ch) || !arms.includes(ts)) continue;
  const v = bootstrap(perTask(ch, (r) => +r.validAt1), perTask(ts, (r) => +r.validAt1));
  const s = bootstrap(perTask(ch, (r) => r.semanticPass), perTask(ts, (r) => r.semanticPass));
  console.log(`\nCharter (${ch}) minus TypeScript (${ts}), ${label}, over ${v.n} task(s):`);
  console.log(`  valid@1        ${(100 * v.diff).toFixed(1)} points   95% CI [${(100 * v.lo).toFixed(1)}, ${(100 * v.hi).toFixed(1)}]`);
  console.log(`  semantic pass  ${(100 * s.diff).toFixed(1)} points   95% CI [${(100 * s.lo).toFixed(1)}, ${(100 * s.hi).toFixed(1)}]`);
  const kill = v.diff < 0.05 && s.diff < 0;
  console.log(`  pilot kill criterion (gain under 5 points and lower semantic pass): ${kill ? "MET: stop for a design review" : "not met"}`);
  if (v.n < 10) console.log(`  caution: ${v.n} task(s) is far below the pilot's 20; intervals this wide decide nothing.`);
}
