// @charter/verify: discharges proof obligations with Z3 (design doc, sections 2.8 and 4.5).
//
// Each obligation asks: given the facts, can the goal be false? Z3 answers
//   unsat    the goal always holds:            Proven
//   sat      a counterexample exists:          for "must" obligations an error with the
//                                              counterexample; for "runtime" ones a kept check
//   unknown  the resource limit ran out:       Unproven
// Amendment A5: the limit is Z3's deterministic resource counter (rlimit), never wall-clock
// time, so the same obligation gets the same answer on every machine. Answers are cached by a
// hash of the exact query.
//
// Opaque terms (subexpressions the logic cannot describe) become free variables. That keeps
// "Proven" sound, but a counterexample may involve them and not be a real one, so messages
// call it a "possible counterexample" whenever opaque terms appear.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { INT_LIMIT, DECIMAL_LIMIT, type Obligation, type Term, type Sort } from "@charter/types";
import { CODES, type Diagnostic } from "@charter/syntax";

export const RLIMIT = 5_000_000;

export type ProofStatus = "proven" | "unproven" | "refuted";
export interface ProofResult {
  obligation: Obligation;
  status: ProofStatus;
  /** Variable values from Z3's model, when the solver found one. */
  witness?: Record<string, string>;
  /** True when the witness involves opaque terms, so it may not be a real counterexample. */
  approximate?: boolean;
  cached: boolean;
}

/** SMT-LIB text of one obligation. It is both the cache key and a human-checkable record. */
export function toSmtLib(o: Obligation): string {
  const vars = new Map<string, Sort>();
  const opaque = new Map<string, { name: string; sort: Sort }>();
  const smt = (t: Term): string => {
    switch (t.t) {
      case "var": vars.set(t.name, t.sort); return `|${t.name}|`;
      case "num": return t.sort === "Real" && !t.value.includes(".") ? `${t.value}.0` : t.value;
      case "bool": return String(t.value);
      case "opaque": {
        if (!opaque.has(t.key)) opaque.set(t.key, { name: `opaque${opaque.size}`, sort: t.sort });
        return opaque.get(t.key)!.name;
      }
      case "app": {
        const args = t.args.map(smt);
        switch (t.op) {
          case "neg": return `(- ${args[0]})`;
          case "==": return `(= ${args.join(" ")})`;
          case "!=": return `(not (= ${args.join(" ")}))`;
          case "/": return t.sort === "Int" ? `(div ${args.join(" ")})` : `(/ ${args.join(" ")})`;
          default: return `(${t.op} ${args.join(" ")})`;
        }
      }
    }
  };
  const facts = o.facts.map((f) => `(assert ${smt(f)})`);
  const negated = `(assert (not ${smt(o.goal)}))`;
  const decls = [
    ...[...vars].map(([n, s]) => `(declare-const |${n}| ${s})`),
    ...[...opaque.entries()].map(([key, v]) => `(declare-const ${v.name} ${v.sort}) ; ${key.replace(/\n/g, " ")}`),
  ];
  // Every Int value is within ±(2^53 - 1) and every Decimal within ±10^38, because producing
  // anything else faults the step (A4, A13). So these bounds are facts about every value.
  const bounds = [
    ...[...vars].map(([n, s]) => [`|${n}|`, s] as const),
    ...[...opaque.values()].map((v) => [v.name, v.sort] as const),
  ].flatMap(([name, s]) =>
    s === "Int" ? [`(assert (<= (- ${INT_LIMIT}) ${name} ${INT_LIMIT}))`]
    : s === "Real" ? [`(assert (< (- ${DECIMAL_LIMIT}.0) ${name} ${DECIMAL_LIMIT}.0))`] : []);
  return [...decls, ...bounds, ...facts, negated, "(check-sat)"].join("\n");
}

type Z3Api = Awaited<ReturnType<typeof import("z3-solver")["init"]>>;
let z3Promise: Promise<Z3Api> | null = null;
const loadZ3 = () => (z3Promise ??= import("z3-solver").then((m) => m.init()));

export interface ProveOptions { cacheFile?: string }

interface CacheEntry { status: ProofStatus; witness?: Record<string, string>; approximate?: boolean }

export async function prove(obligations: Obligation[], opts: ProveOptions = {}): Promise<ProofResult[]> {
  const cache: Record<string, CacheEntry> =
    opts.cacheFile && existsSync(opts.cacheFile) ? JSON.parse(readFileSync(opts.cacheFile, "utf8")) : {};
  const results: ProofResult[] = [];
  let dirty = false;

  for (const o of obligations) {
    const text = toSmtLib(o);
    const key = createHash("sha256").update(`rlimit=${RLIMIT}\n${text}`).digest("hex");
    const hit = cache[key];
    if (hit) { results.push({ obligation: o, ...hit, cached: true }); continue; }

    const { Context } = await loadZ3();
    const ctx = Context("charter");
    const solver = new ctx.Solver();
    solver.set("rlimit", RLIMIT);
    solver.fromString(text.replace("(check-sat)", ""));
    const answer = await solver.check();
    let entry: CacheEntry;
    if (answer === "unsat") entry = { status: "proven" };
    else if (answer === "sat") {
      const model = solver.model();
      const witness: Record<string, string> = {};
      for (const d of model.decls()) {
        const name = d.name().toString();
        if (name.startsWith("opaque")) continue;
        witness[name.replace(/^\|(.*)\|$/, "$1")] = formatValue(model.get(d).toString());
      }
      const approximate = /opaque\d/.test(text);
      entry = { status: o.severity === "must" && !approximate ? "refuted" : "unproven", witness, approximate };
    } else entry = { status: "unproven" };
    cache[key] = entry;
    dirty = true;
    results.push({ obligation: o, ...entry, cached: false });
  }

  if (opts.cacheFile && dirty) {
    mkdirSync(dirname(opts.cacheFile), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(opts.cacheFile, JSON.stringify(sorted, null, 2) + "\n");
  }
  return results;
}

/**
 * Turns proof results into diagnostics. An unproven "must" obligation is a compile error
 * (design doc, 2.8: T-Div and T-Sub). Runtime obligations never produce errors.
 */
export function proofDiagnostics(results: ProofResult[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of results) {
    const o = r.obligation;
    if (o.severity !== "must" || r.status === "proven") continue;
    const d: Diagnostic = {
      code: o.kind === "nonzero" ? CODES.DIVISION_UNPROVEN : CODES.REFINEMENT_UNPROVEN,
      severity: "error",
      span: o.span,
      message: `cannot prove that ${o.claim}${r.status !== "refuted" && r.approximate ? " (the solver found a possible counterexample)" : ""}`,
      known: o.factText.length ? o.factText : ["nothing"],
      fixes: [{
        kind: "add_guard",
        text: o.kind === "nonzero" ? "check the divisor first, for example: if b == 0 then … else …" : "add a guard or an if that establishes it",
      }],
    };
    if (r.witness) d.witness = r.witness;
    out.push(d);
  }
  return out;
}

/** Z3 prints rationals as "(/ 1.0 2.0)" and negatives as "(- 3.0)"; show them as people write them. */
function formatValue(v: string): string {
  const neg = /^\(- (.+)\)$/.exec(v);
  if (neg) return "-" + formatValue(neg[1]!);
  const frac = /^\(\/ ([\d.]+) ([\d.]+)\)$/.exec(v);
  if (frac) return `${trimZero(frac[1]!)}/${trimZero(frac[2]!)}`;
  return trimZero(v);
}
const trimZero = (s: string) => s.replace(/\.0$/, "");
