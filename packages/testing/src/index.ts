// @charter/testing: runs a program's tests and properties on the reference interpreter
// (design doc, sections 4.5 and 8.4).
//
// Properties draw inputs from the parameters' refined types with fast-check, using a seed
// derived from the property's name, so every run tries the same inputs. Bounds written as
// "it >= c" and "it <= c" shape the generators; any other refinement filters their output.
//
// Milestone 1 scope: tests and properties that call queries. Tests with given setups, or that
// call rules, are reported as skipped until the store exists (milestone 2).
import { createHash } from "node:crypto";
import fc from "fast-check";
import { printExpr, type Program, type Decl, type Expr, type Act } from "@charter/syntax";
import type { CheckResult, Ty, Pred } from "@charter/types";
import { interpreter, NotYet, Fault, show, showOutcome, SCALE, type Value, type Outcome, type Interpreter } from "@charter/interp";

export interface TestResult {
  name: string;
  kind: "test" | "property";
  status: "pass" | "fail" | "skip";
  message?: string;
  cases?: number;
}

export interface RunOptions { numRuns?: number; now?: number }

const seedOf = (name: string) => createHash("sha256").update(name).digest().readUInt32BE(0);

function outcomeMatches(act: Act, o: Outcome): string | null {
  const want = act.outcome;
  if (o.kind === "fault") return `the step faulted: ${o.message}`;
  if (want.kind === "any") return null;
  if (want.kind === "ok") return o.kind === "ok" ? null : `expected ok, got ${showOutcome(o)}`;
  if (o.kind === "reject" && o.name === want.name) return null;
  return `expected reject ${want.name}, got ${showOutcome(o)}`;
}

/** Runs one act. Returns an error message, or null if the act behaved as expected. */
function runAct(i: Interpreter, c: CheckResult, act: Act, env: Map<string, Value>): string | null {
  const args = act.args.map((a) => i.evalClosed(a, env));
  const o = i.callQuery(act.call, args);
  const bad = outcomeMatches(act, o);
  if (bad) return bad;
  for (const t of act.thens) {
    const v = i.evalClosed(t, env, o.kind === "ok" ? { result: o.value } : {});
    if (!(v.t === "bool" && v.v)) return `then ${printExpr(t)} was false (result = ${o.kind === "ok" ? show(o.value) : "none"})`;
  }
  return null;
}


/** Lower and upper bounds that refinements of the form "it >= c" or "it <= c" state directly. */
function bounds(preds: Pred[], i: Interpreter): { lo?: bigint; hi?: bigint } {
  const out: { lo?: bigint; hi?: bigint } = {};
  const visit = (e: Expr) => {
    if (e.kind === "Binary" && e.op === "and") { visit(e.left); visit(e.right); return; }
    if (e.kind !== "Binary" || !["<", "<=", ">", ">="].includes(e.op)) return;
    const itLeft = e.left.kind === "Keyword" && e.left.name === "it";
    const itRight = e.right.kind === "Keyword" && e.right.name === "it";
    if (!itLeft && !itRight) return;
    let v: Value;
    try { v = i.evalClosed(itLeft ? e.right : e.left); } catch { return; }
    const n = v.t === "int" ? BigInt(v.v) * SCALE : v.t === "dec" ? v.v : null;
    if (n === null) return;
    const op = itLeft ? e.op : ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[e.op]!;
    if (op === ">=" || op === ">") out.lo = out.lo === undefined || n > out.lo ? n : out.lo;
    if (op === "<=" || op === "<") out.hi = out.hi === undefined || n < out.hi ? n : out.hi;
  };
  preds.forEach((p) => visit(p.expr));
  return out;
}

function arbitraryFor(ty: Ty, preds: Pred[], c: CheckResult, i: Interpreter): fc.Arbitrary<Value> | null {
  const { lo, hi } = bounds(preds, i);
  let arb: fc.Arbitrary<Value> | null = null;
  switch (ty.k) {
    case "Int": {
      const min = lo !== undefined ? Number(lo / SCALE) : -1_000_000, max = hi !== undefined ? Number(hi / SCALE) : 1_000_000;
      arb = fc.integer({ min: Math.max(min, Number.MIN_SAFE_INTEGER), max: Math.min(max, Number.MAX_SAFE_INTEGER) }).map((v) => ({ t: "int", v }) as Value);
      break;
    }
    case "Decimal": case "Money": {
      const min = lo ?? -(10n ** 12n) * SCALE, max = hi ?? 10n ** 12n * SCALE;
      const step = ty.k === "Money" ? SCALE / 100n : 1n;
      const scaled = fc.oneof(
        // Whole numbers and short decimals are where most arithmetic bugs hide.
        fc.bigInt({ min: min / SCALE, max: max / SCALE }).map((n) => n * SCALE),
        fc.bigInt({ min: min / (SCALE / 100n), max: max / (SCALE / 100n) }).map((n) => n * (SCALE / 100n)),
        fc.bigInt({ min: min / step, max: max / step }).map((n) => n * step),
      );
      arb = scaled.filter((n) => n >= min && n <= max).map((v) => ({ t: "dec", v }) as Value);
      break;
    }
    case "Bool": arb = fc.boolean().map((v) => ({ t: "bool", v }) as Value); break;
    case "Text": arb = fc.string({ maxLength: 40 }).map((v) => ({ t: "text", v }) as Value); break;
    case "Enum": {
      const d = c.resolution.decls.get(ty.name) as Extract<Decl, { kind: "EnumDecl" }>;
      if (d.variants.some((v) => v.fields.length)) return null;
      arb = fc.constantFrom(...d.variants.map((v) => ({ t: "enum", type: ty.name, variant: v.name, fields: [] }) as Value));
      break;
    }
    default: return null;
  }
  return preds.length ? arb.filter((v) => { try { return i.satisfies(preds, v); } catch { return false; } }) : arb;
}

const needsStore = (d: Extract<Decl, { kind: "TestDecl" | "PropertyDecl" }>, c: CheckResult): string | null => {
  if (d.givens.length) return "given setups need the store (milestone 2)";
  const rule = d.acts.find((a) => c.resolution.decls.get(a.call)?.kind === "Rule");
  return rule ? `${rule.call} is a rule, and rules run from milestone 2` : null;
};

export function runTests(p: Program, c: CheckResult, opts: RunOptions = {}): TestResult[] {
  const i = interpreter(p, c, opts.now !== undefined ? { now: opts.now } : {});
  const results: TestResult[] = [];
  for (const d of p.decls) {
    if (d.kind !== "TestDecl" && d.kind !== "PropertyDecl") continue;
    const kind = d.kind === "TestDecl" ? "test" : "property";
    const skip = needsStore(d, c);
    if (skip) { results.push({ name: d.name, kind, status: "skip", message: skip }); continue; }

    try {
      if (d.kind === "TestDecl") {
        const env = new Map<string, Value>();
        const bad = d.acts.map((a) => runAct(i, c, a, env)).find((m) => m !== null) ?? null;
        results.push(bad ? { name: d.name, kind, status: "fail", message: bad } : { name: d.name, kind, status: "pass" });
        continue;
      }
      const params = d.params.map((prm) => ({ name: prm.name, ...c.resolveType(prm.type) }));
      const arbs = params.map((prm) => arbitraryFor(prm.ty, prm.preds, c, i));
      const missing = params.find((_, k) => arbs[k] === null);
      if (missing) { results.push({ name: d.name, kind, status: "skip", message: `no generator yet for ${missing.name}` }); continue; }
      const numRuns = opts.numRuns ?? 1000;
      let lastFailure = "";
      const outcome = fc.check(fc.property(fc.tuple(...(arbs as fc.Arbitrary<Value>[])), (vals) => {
        const env = new Map(params.map((prm, k) => [prm.name, vals[k]!] as [string, Value]));
        if (d.where) { const w = i.evalClosed(d.where, env); fc.pre(w.t === "bool" && w.v); }
        for (const a of d.acts) {
          const bad = runAct(i, c, a, env);
          if (bad) { lastFailure = bad; return false; }
        }
        return true;
      }), { seed: seedOf(d.name), numRuns });
      if (outcome.failed) {
        const ce = outcome.counterexample?.[0] as Value[] | undefined;
        const inputs = ce ? params.map((prm, k) => `${prm.name} = ${show(ce[k]!)}`).join(", ") : "";
        // lastFailure is set by the last failing run, which is the shrunk counterexample.
        const why = lastFailure || (outcome.errorInstance instanceof Error ? outcome.errorInstance.message : "the property failed");
        results.push({ name: d.name, kind, status: "fail", message: `${why}${inputs ? ` (smallest failing input: ${inputs})` : ""}`, cases: outcome.numRuns });
      } else {
        results.push({ name: d.name, kind, status: "pass", cases: outcome.numRuns });
      }
    } catch (err) {
      if (err instanceof NotYet) results.push({ name: d.name, kind, status: "skip", message: err.message });
      else if (err instanceof Fault) results.push({ name: d.name, kind, status: "fail", message: `fault: ${err.message}` });
      else throw err;
    }
  }
  return results;
}
