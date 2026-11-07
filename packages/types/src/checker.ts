// Type checker for Charter 0.1 (design doc, sections 2.3 and 2.8).
//
// Milestone 1 scope: the pure part of the language is fully checked. That covers types,
// enums, functions, queries, and tests and properties that call queries. Entities, rules,
// permissions, invariants, asserts, events, triggers and migrations are reported with an info
// diagnostic (CH0901) and checked from milestone 2. Nothing in them is silently accepted.
//
// Alongside types, the checker emits proof obligations (types.ts) for the verifier:
//   nonzero     divisors (T-Div), a compile error unless proven
//   refinement  arguments and return values against refined types (T-Sub), an error unless proven
//   range       Int and Decimal results stay in range (A4, A13), a runtime check unless proven
import { CODES, printExpr, type Decl, type Diagnostic, type Expr, type Program, type Span, type TypeExpr, type Act, type Clause } from "@charter/syntax";
import { resolve, BUILTIN_OUTCOMES, type Resolution } from "@charter/resolve";
import { declKey } from "@charter/graph";
import { T, show, same, isNumeric, type Ty, type Pred, type Refined, type Term, type Sort, type Obligation } from "./types.ts";

export const INT_LIMIT = "9007199254740991";               // 2^53 - 1 (A4)
export const DECIMAL_LIMIT = "100000000000000000000000000000000000000"; // 10^38 (A13)

export interface FnSig { name: string; params: { name: string; type: Refined }[]; ret: Refined; decl: Decl }

export interface CheckResult {
  diagnostics: Diagnostic[];
  obligations: Obligation[];
  types: WeakMap<Expr, Ty>;
  resolution: Resolution;
  /** Signatures of fns, extern fns and queries. */
  sigs: Map<string, FnSig>;
  resolveType: (t: TypeExpr) => Refined;
}

interface Var { ty: Ty; term?: Term }
interface Env {
  decl: string;
  vars: Map<string, Var>;
  facts: { term: Term; text: string }[];
  itTy?: Ty;
  itTerm?: Term;
  resultTy?: Ty;
  /** The principal entity, if the module declares one. */
  callerTy?: Ty;
  /** True in a declaration with "permit public" (A26), where there may be no caller. */
  publicDecl?: boolean;
  /** True inside a test's then clauses, where result, accepted, effects and old(...) mean something. */
  inThen?: boolean;
  /**
   * What a field read like "p.stock" means after the step wrote it. Before any write, a read
   * is an opaque term for the stored value, about which the field's refinement is a fact.
   */
  fieldTerms?: Map<string, Term>;
  /** False inside tests and properties, where checks happen at runtime instead. */
  obligations: boolean;
}

let freshCounter = 0;
/** A term nothing is known about, for a value that may have changed in ways we did not track. */
const fresh = (key: string, sort: Sort): Term => ({ t: "opaque", key: `${key}@${++freshCounter}`, sort });

const sortOf = (t: Ty | undefined): Sort | null =>
  !t ? null : t.k === "Int" || (t.k === "NumLit" && !t.decimal) ? "Int"
  : t.k === "Decimal" || t.k === "Money" || (t.k === "NumLit" && t.decimal) ? "Real"
  : t.k === "Bool" ? "Bool" : null;

const app = (op: Extract<Term, { t: "app" }>["op"], args: Term[], sort: Sort): Term => ({ t: "app", op, args, sort });
const num = (value: string, sort: "Int" | "Real"): Term => ({ t: "num", value, sort });

export function check(p: Program): CheckResult {
  const resolution = resolve(p);
  const diagnostics: Diagnostic[] = [...resolution.diagnostics];
  const obligations: Obligation[] = [];
  const types = new WeakMap<Expr, Ty>();
  const sigs = new Map<string, FnSig>();
  const { decls, variants } = resolution;

  const err = (code: string, message: string, span: Span) => diagnostics.push({ code, severity: "error", message, span });
  const info = (code: string, message: string, span: Span) => diagnostics.push({ code, severity: "info", message, span });

  // ---------------------------------------------------------------- types

  const resolving = new Set<string>();
  /** Refinements of record fields, kept beside the record type (types compare by structure). */
  const recordPreds = new WeakMap<Ty, Map<string, Refined>>();
  const resolveType = (te: TypeExpr): Refined => {
    let r: Refined;
    const b = te.base;
    switch (b.kind) {
      case "Prim": r = { ty: T[b.name], preds: [] }; break;
      case "Id": r = { ty: { k: "Id", target: b.target.parts.join(".") }, preds: [] }; break;
      case "List": r = { ty: { k: "List", elem: resolveType(b.elem).ty }, preds: [] }; break;
      case "SetT": r = { ty: { k: "Set", elem: resolveType(b.elem).ty }, preds: [] }; break;
      case "MapT": r = { ty: { k: "Map", key: resolveType(b.key).ty, value: resolveType(b.value).ty }, preds: [] }; break;
      case "RecordT": {
        const fields = b.fields.map((f) => ({ name: f.name, r: resolveType(f.type) }));
        const ty: Ty = { k: "Record", fields: fields.map((f) => [f.name, f.r.ty] as [string, Ty]) };
        const withPreds = fields.filter((f) => f.r.preds.length);
        if (withPreds.length) recordPreds.set(ty, new Map(withPreds.map((f) => [f.name, f.r])));
        r = { ty, preds: [] };
        break;
      }
      case "Named": {
        const name = b.name.parts.join(".");
        const d = b.name.parts.length === 1 ? decls.get(name) : undefined;
        if (!d) { r = { ty: T.Unknown, preds: [] }; break; }
        if (d.kind === "EnumDecl" && d.name === name) r = { ty: { k: "Enum", name }, preds: [] };
        else if (d.kind === "Entity") r = { ty: { k: "Entity", name }, preds: [] };
        else if (d.kind === "TypeDecl") {
          if (resolving.has(name)) { err(CODES.TYPE_MISMATCH, `type ${name} is defined in terms of itself`, te.span); r = { ty: T.Unknown, preds: [] }; break; }
          resolving.add(name);
          const inner = resolveType(d.type);
          resolving.delete(name);
          r = { ty: inner.ty, preds: [...inner.preds] };
        } else { err(CODES.TYPE_MISMATCH, `"${name}" is not a type`, te.span); r = { ty: T.Unknown, preds: [] }; }
        break;
      }
    }
    if (te.optional) r = { ty: { k: "Optional", inner: r.ty }, preds: [] }; // a refinement applies to present values only
    if (te.refinement) {
      const ref = te.refinement;
      const expr: Expr = ref.kind === "ShortRefinement"
        ? { kind: "Binary", op: ref.op, left: { kind: "Keyword", name: "it", span: te.span }, right: ref.rhs, span: te.span }
        : ref.expr;
      r = { ty: r.ty, preds: [...r.preds, { expr, source: printExpr(expr) }] };
    }
    return r;
  };

  // ---------------------------------------------------------------- unification

  /** The type a value of type `from` takes when used where `to` is expected, or null. */
  const assignable = (from: Ty, to: Ty): boolean => {
    if (from.k === "Unknown" || to.k === "Unknown") return true;
    if (from.k === "NumLit") return to.k === "Decimal" || to.k === "Money" || (to.k === "Int" && !from.decimal) || (to.k === "Optional" && assignable(from, to.inner));
    if (from.k === "None") return to.k === "Optional";
    if (to.k === "Optional") return from.k === "Optional" ? assignable(from.inner, to.inner) : assignable(from, to.inner);
    if (from.k === "List" && to.k === "List") return assignable(from.elem, to.elem);
    if (from.k === "Set" && to.k === "Set") return assignable(from.elem, to.elem);
    // An id from an imported module (Id<idn.Account>) cannot be built until modules are linked,
    // so for now its values are written as Text. Milestone 2 decision; see the errata.
    if (to.k === "Id" && to.target.includes(".") && from.k === "Text") return true;
    // {} is an empty Set, Map or record, depending on where it is used (A22).
    if (from.k === "Record" && from.fields.length === 0 && (to.k === "Set" || to.k === "Map" || to.k === "List")) return true;
    if (from.k === "Record" && to.k === "Record") {
      return from.fields.length === to.fields.length && to.fields.every(([n, t]) => {
        const f = from.fields.find(([m]) => m === n);
        return f !== undefined && assignable(f[1], t);
      });
    }
    return same(from, to);
  };

  const unify = (a: Ty, b: Ty): Ty | null => {
    if (a.k === "Unknown") return b;
    if (b.k === "Unknown") return a;
    if (a.k === "NumLit" && b.k === "NumLit") return { k: "NumLit", decimal: a.decimal || b.decimal };
    if (a.k === "NumLit") return assignable(a, b) ? b : null;
    if (b.k === "NumLit") return assignable(b, a) ? a : null;
    if (a.k === "None") return b.k === "Optional" ? b : b.k === "None" ? a : { k: "Optional", inner: b };
    if (b.k === "None") return unify(b, a);
    if (a.k === "Optional" || b.k === "Optional") {
      const ia = a.k === "Optional" ? a.inner : a, ib = b.k === "Optional" ? b.inner : b;
      const u = unify(ia, ib);
      return u ? { k: "Optional", inner: u } : null;
    }
    if (a.k === "List" && b.k === "List") { const u = unify(a.elem, b.elem); return u ? { k: "List", elem: u } : null; }
    return same(a, b) ? a : null;
  };

  // ---------------------------------------------------------------- logic translation

  const termOf = (e: Expr, env: Env): Term | null => {
    const ty = types.get(e);
    const sort = sortOf(ty);
    const opaque = (): Term | null => (sort ? { t: "opaque", key: printExpr(e), sort } : null);
    switch (e.kind) {
      case "Literal":
        if (e.type === "int" || e.type === "decimal") return num(e.value, sort === "Int" ? "Int" : "Real");
        if (e.type === "bool") return { t: "bool", value: e.value === "true" };
        return null;
      case "Name": {
        const v = env.vars.get(e.name);
        if (v?.term) return v.term;
        if (v && sort) return { t: "var", name: e.name, sort };
        return opaque();
      }
      case "Keyword": return e.name === "it" && env.itTerm ? env.itTerm : opaque();
      case "Neg": { const a = termOf(e.operand, env); return a && sort ? app("neg", [a], sort) : opaque(); }
      case "Not": { const a = termOf(e.operand, env); return a ? app("not", [a], "Bool") : opaque(); }
      case "IfExpr": {
        const c = termOf(e.cond, env), a = termOf(e.then, env), b = termOf(e.else, env);
        return c && a && b && sort ? app("ite", [c, a, b], sort) : opaque();
      }
      case "Binary": {
        const lt = types.get(e.left), rt = types.get(e.right);
        const numericPair = lt && rt && isNumeric(lt) && isNumeric(rt);
        const boolPair = lt?.k === "Bool" && rt?.k === "Bool";
        if (["+", "-", "*", "/"].includes(e.op) && numericPair && sort) {
          const a = coerce(termOf(e.left, env), sort), b = coerce(termOf(e.right, env), sort);
          return a && b ? app(e.op as "+", [a, b], sort) : opaque();
        }
        if (["==", "!=", "<", "<=", ">", ">="].includes(e.op) && (numericPair || (boolPair && (e.op === "==" || e.op === "!=")))) {
          const s: Sort = boolPair ? "Bool" : sortOf(lt) === "Real" || sortOf(rt) === "Real" ? "Real" : "Int";
          const a = coerce(termOf(e.left, env), s), b = coerce(termOf(e.right, env), s);
          return a && b ? app(e.op as "==", [a, b], "Bool") : opaque();
        }
        if ((e.op === "and" || e.op === "or") && boolPair) {
          const a = termOf(e.left, env), b = termOf(e.right, env);
          return a && b ? app(e.op, [a, b], "Bool") : opaque();
        }
        return opaque();
      }
      case "FieldAccess": {
        // After the step wrote this field, a read means the written value.
        const known = env.fieldTerms?.get(printExpr(e));
        return known ?? opaque();
      }
      default: return opaque();
    }
  };

  /** Integer-sorted literals may stand where a Real is expected; nothing else changes sort. */
  const coerce = (t: Term | null, s: Sort): Term | null => {
    if (!t) return null;
    if (t.t === "num" && s === "Real") return { ...t, sort: "Real" };
    return t;
  };

  /** Adds what a condition tells us: a fact for the solver, and none-narrowing (amendment A24). */
  const withFact = (env: Env, e: Expr, negate: boolean): Env => {
    let out = env;
    const narrowed = narrowing(e, negate, env);
    if (narrowed) {
      out = { ...out, vars: new Map(out.vars).set(narrowed.name, narrowed.v), facts: [...out.facts] };
      bindFacts(out, narrowed.name, narrowed.v.ty);
    }
    const t = termOf(e, env);
    if (!t) return out;
    return {
      ...out,
      facts: [...out.facts, { term: negate ? app("not", [t], "Bool") : t, text: negate ? `not (${printExpr(e)})` : printExpr(e) }],
    };
  };

  /** "x != none" (or "not (x == none)") narrows x from T? to T where the condition holds. */
  const narrowing = (e: Expr, negate: boolean, env: Env): { name: string; v: Var } | null => {
    if (e.kind === "Binary" && (e.op === "!=" || e.op === "==")) {
      const [x, other] = e.left.kind === "Name" ? [e.left, e.right] : [e.right, e.left];
      if (x.kind !== "Name" || other.kind !== "Literal" || other.type !== "none") return null;
      const positive = (e.op === "!=") !== negate;
      const v = env.vars.get(x.name);
      if (!positive || !v || v.ty.k !== "Optional") return null;
      return { name: x.name, v: { ty: v.ty.inner } };
    }
    if (e.kind === "Binary" && e.op === "and" && !negate) return narrowing(e.left, false, env) ?? narrowing(e.right, false, env);
    return null;
  };

  /**
   * When a variable of an entity or record type is bound, the refinements of its fields are
   * facts about the stored values: invariants hold at the start of every step (design doc,
   * 2.8). Adds those facts to env.facts.
   */
  const bindFacts = (env: Env, name: string, ty: Ty): void => {
    const fields: [string, Refined][] = [];
    if (ty.k === "Entity") {
      const d = decls.get(ty.name);
      if (d && d.kind === "Entity") for (const f of d.fields) { const r = resolveType(f.type); if (r.preds.length) fields.push([f.name, r]); }
    }
    if (ty.k === "Record") fields.push(...(recordPreds.get(ty) ?? []));
    for (const [fname, r] of fields) {
      const sort = sortOf(r.ty);
      if (!sort) continue;
      const term: Term = { t: "opaque", key: `${name}.${fname}`, sort };
      for (const pr of r.preds) {
        const penv: Env = { ...env, itTy: r.ty, itTerm: term, obligations: false };
        infer(pr.expr, penv, T.Bool);
        const t = termOf(pr.expr, penv);
        if (t) env.facts.push({ term: t, text: pr.source.replace(/\bit\b/g, `${name}.${fname}`) });
      }
    }
  };

  const oblige = (o: Omit<Obligation, "facts" | "factText" | "decl">, env: Env) => {
    if (!env.obligations) return;
    obligations.push({ ...o, decl: env.decl, facts: env.facts.map((f) => f.term), factText: env.facts.map((f) => f.text) });
  };

  /** Requires `value` (already typed) to satisfy the predicates of a refined type. */
  const requirePreds = (preds: Pred[], value: Expr, base: Ty, env: Env, span: Span, what: string) => {
    if (!preds.length || !env.obligations) return;
    const valueTerm = termOf(value, env) ?? { t: "opaque", key: printExpr(value), sort: sortOf(base) ?? "Int" };
    for (const pr of preds) {
      const penv: Env = { ...env, itTy: base, itTerm: valueTerm };
      infer(pr.expr, penv, T.Bool);
      const goal = termOf(pr.expr, penv) ?? { t: "opaque", key: `${pr.source} for ${printExpr(value)}`, sort: "Bool" };
      oblige({ severity: "must", kind: "refinement", span, claim: `${what} satisfies "${pr.source}"`, goal }, env);
    }
  };

  const rangeCheck = (e: Expr, ty: Ty, env: Env) => {
    const s = sortOf(ty);
    if (!s || s === "Bool" || ty.k === "NumLit") return;
    const t = termOf(e, env);
    if (!t) return;
    const limit = s === "Int" ? num(INT_LIMIT, "Int") : num(DECIMAL_LIMIT, "Real");
    const goal = s === "Int"
      ? app("and", [app("<=", [app("neg", [limit], s), t], "Bool"), app("<=", [t, limit], "Bool")], "Bool")
      : app("and", [app("<", [app("neg", [limit], s), t], "Bool"), app("<", [t, limit], "Bool")], "Bool");
    oblige({ severity: "runtime", kind: "range", span: e.span, claim: `${printExpr(e)} stays within the ${show(ty)} range`, goal }, env);
  };

  // ---------------------------------------------------------------- expressions

  const fail = (e: Expr, message: string, code: string = CODES.TYPE_MISMATCH): Ty => { err(code, message, e.span); return T.Unknown; };

  const expectTy = (e: Expr, env: Env, want: Ty, what: string): Ty => {
    const got = infer(e, env, want);
    if (!assignable(got, want)) err(CODES.TYPE_MISMATCH, `${what} should be ${show(want)}, but it is ${show(got)}`, e.span);
    return got;
  };

  const variantInfo = (name: string) => {
    const enumName = variants.get(name);
    if (!enumName) return null;
    const d = decls.get(enumName);
    if (!d || d.kind !== "EnumDecl") return null;
    return { enumName, decl: d, variant: d.variants.find((v) => v.name === name)! };
  };

  const infer = (e: Expr, env: Env, expected?: Ty): Ty => {
    const ty = inferInner(e, env, expected);
    types.set(e, ty);
    return ty;
  };

  const inferInner = (e: Expr, env: Env, expected?: Ty): Ty => {
    switch (e.kind) {
      case "Literal":
        switch (e.type) {
          case "int": return { k: "NumLit", decimal: false };
          case "decimal": return { k: "NumLit", decimal: true };
          case "string": return T.Text;
          case "bool": return T.Bool;
          case "duration": return T.Duration;
          case "none": return T.None;
        }
        break;
      case "Name": {
        const ref = resolution.refs.get(e);
        if (!ref) return T.Unknown; // already reported by the resolver
        if (ref.kind === "local") return env.vars.get(e.name)?.ty ?? T.Unknown;
        if (ref.kind === "variant") {
          const v = variantInfo(e.name)!;
          if (v.variant.fields.length) return fail(e, `variant ${e.name} carries data; call it, for example ${e.name}(…)`);
          return { k: "Enum", name: v.enumName };
        }
        if (ref.kind === "decl" && ref.decl.kind === "Entity") return { k: "Entity", name: ref.decl.name };
        if (ref.kind === "decl" || ref.kind === "builtin") return fail(e, `"${e.name}" is not a value here`);
        return T.Unknown;
      }
      case "Keyword":
        switch (e.name) {
          case "it": return env.itTy ?? fail(e, `"it" is only meaningful inside a refinement`);
          case "now": return T.Time;
          case "result": return env.inThen ? env.resultTy ?? T.None : fail(e, `"result" is only meaningful in a test's then clause`);
          case "accepted": return env.inThen ? T.Bool : fail(e, `"accepted" is only meaningful in a test's then clause`);
          case "effects":
            return env.inThen ? { k: "List", elem: { k: "Record", fields: [["cap", T.Text], ["args", { k: "List", elem: T.Unknown }]] } }
              : fail(e, `"effects" is only meaningful in a test's then clause`);
          case "caller":
            if (env.publicDecl) return fail(e, `"caller" is not available under "permit public", because the call may come from someone who is not signed in (amendment A26). Use "permit anyone" if only signed-in callers may call it.`);
            return env.callerTy ?? fail(e, `"caller" needs a principal declaration, such as "principal User"`);
        }
        return T.Unknown;
      case "Old":
        if (!env.inThen) return fail(e, `old(...) is only meaningful in a test's then clause`);
        return infer(e.expr, env, expected);
      case "IfExpr": {
        expectTy(e.cond, env, T.Bool, "an if condition");
        const a = infer(e.then, withFact(env, e.cond, false), expected);
        const b = infer(e.else, withFact(env, e.cond, true), expected);
        return unify(a, b) ?? fail(e, `the branches of this if have different types: ${show(a)} and ${show(b)}`);
      }
      case "Match": {
        const st = infer(e.subject, env);
        if (st.k !== "Enum") return st.k === "Unknown" ? T.Unknown : fail(e, `match needs an enum value, but this is ${show(st)}`);
        const ed = decls.get(st.name) as Extract<Decl, { kind: "EnumDecl" }>;
        const covered = new Set<string>();
        let wildcard = false;
        let result: Ty = T.Unknown;
        for (const arm of e.arms) {
          const aenv: Env = { ...env, vars: new Map(env.vars) };
          if (arm.pattern.kind === "Wildcard") wildcard = true;
          else {
            const v = ed.variants.find((x) => x.name === (arm.pattern as { name: string }).name);
            if (!v) { err(CODES.BAD_PATTERN, `${arm.pattern.name} is not a variant of ${st.name}`, e.span); continue; }
            covered.add(v.name);
            const binders = arm.pattern.binders ?? [];
            if (arm.pattern.binders && binders.length !== v.fields.length) {
              err(CODES.BAD_PATTERN, `${v.name} carries ${v.fields.length} value(s), but the pattern names ${binders.length}`, e.span);
            }
            binders.forEach((b, i) => { if (b !== "_" && v.fields[i]) aenv.vars.set(b, { ty: resolveType(v.fields[i]!.type).ty }); });
          }
          const at = infer(arm.body, aenv, expected);
          const u = unify(result, at);
          if (!u) err(CODES.TYPE_MISMATCH, `this match arm is ${show(at)}, but earlier arms are ${show(result)}`, arm.body.span);
          else result = u;
        }
        const missing = ed.variants.map((v) => v.name).filter((n) => !covered.has(n));
        if (!wildcard && missing.length) err(CODES.NOT_EXHAUSTIVE, `match does not cover ${missing.join(", ")}`, e.span);
        return result;
      }
      case "Binary": return binary(e, env);
      case "Not": expectTy(e.operand, env, T.Bool, "the operand of not"); return T.Bool;
      case "Neg": {
        const t = infer(e.operand, env);
        return isNumeric(t) || t.k === "Unknown" || t.k === "Duration" ? t : fail(e, `cannot negate ${show(t)}`);
      }
      case "Call": return call(e, env);
      case "FieldAccess": {
        const ot = infer(e.object, env);
        if (ot.k === "Record") {
          const f = ot.fields.find(([n]) => n === e.name);
          return f ? f[1] : fail(e, `${show(ot)} has no field "${e.name}"`, CODES.UNKNOWN_FIELD);
        }
        if (ot.k === "Entity") {
          const d = decls.get(ot.name);
          if (e.name === "id") return { k: "Id", target: ot.name };
          const f = d && d.kind === "Entity" ? d.fields.find((x) => x.name === e.name) : undefined;
          return f ? resolveType(f.type).ty : fail(e, `entity ${ot.name} has no field "${e.name}"`, CODES.UNKNOWN_FIELD);
        }
        return T.Unknown;
      }
      case "Index": {
        const ot = infer(e.object, env);
        if (ot.k === "List") { expectTy(e.index, env, T.Int, "a list index"); return ot.elem; }
        if (ot.k === "Map") { expectTy(e.index, env, ot.key, "a map key"); return { k: "Optional", inner: ot.value }; }
        if (ot.k === "Entity") { infer(e.index, env); return { k: "Optional", inner: ot }; }
        if (ot.k === "Unknown") { infer(e.index, env); return T.Unknown; }
        return fail(e, `cannot index ${show(ot)}`);
      }
      case "Quant": case "Count": case "Sum": case "Select": {
        const ct = infer(e.coll, env);
        const elem: Ty = ct.k === "List" || ct.k === "Set" ? ct.elem : ct.k === "Entity" ? ct : ct.k === "Unknown" ? T.Unknown : fail(e.coll, `cannot iterate over ${show(ct)}`);
        const inner: Env = { ...env, vars: new Map(env.vars).set(e.binder, { ty: elem }) };
        if (e.kind !== "Quant" && e.where) expectTy(e.where, inner, T.Bool, "a where condition");
        if (e.kind === "Quant") { expectTy(e.body, inner, T.Bool, `the body of ${e.q}`); return T.Bool; }
        if (e.kind === "Count") return T.Int;
        const vt = infer(e.value, inner);
        if (e.kind === "Sum") return isNumeric(vt) || vt.k === "Unknown" ? vt : fail(e.value, `sum needs numbers, but this is ${show(vt)}`);
        for (const o of e.orderBy) infer(o, inner);
        return { k: "List", elem: vt };
      }
      case "ListLit": {
        let elem: Ty = T.Unknown;
        for (const it of e.items) {
          const t = infer(it, env);
          const u = unify(elem, t);
          if (!u) err(CODES.TYPE_MISMATCH, `list items have different types: ${show(elem)} and ${show(t)}`, it.span);
          else elem = u;
        }
        return { k: "List", elem };
      }
      case "RecordLit":
        if (!e.assigns.length && expected && (expected.k === "Set" || expected.k === "Map" || expected.k === "List")) return expected;
        return { k: "Record", fields: e.assigns.map((a) => [a.name, infer(a.value, env)] as [string, Ty]) };
    }
    return T.Unknown;
  };

  const binary = (e: Extract<Expr, { kind: "Binary" }>, env: Env): Ty => {
    const op = e.op;
    if (op === "and" || op === "or") {
      expectTy(e.left, env, T.Bool, `the left side of ${op}`);
      // Short-circuit: the right side only runs when the left side allows it.
      expectTy(e.right, withFact(env, e.left, op === "or"), T.Bool, `the right side of ${op}`);
      return T.Bool;
    }
    const lt = infer(e.left, env), rt = infer(e.right, env);
    if (lt.k === "Unknown" || rt.k === "Unknown") return ["==", "!=", "<", "<=", ">", ">=", "in"].includes(op) ? T.Bool : T.Unknown;
    switch (op) {
      case "==": case "!=":
        if ((isNumeric(lt) && isNumeric(rt)) || unify(lt, rt)) return T.Bool;
        return fail(e, `cannot compare ${show(lt)} with ${show(rt)}`);
      case "<": case "<=": case ">": case ">=": {
        const ordered = (t: Ty) => isNumeric(t) || t.k === "Text" || t.k === "Time" || t.k === "Duration";
        if (ordered(lt) && unify(lt, rt)) return T.Bool;
        return fail(e, `cannot order ${show(lt)} and ${show(rt)}`);
      }
      case "in":
        if ((rt.k === "List" || rt.k === "Set") && unify(lt, rt.elem)) return T.Bool;
        return fail(e, `"in" needs a list or set of ${show(lt)}, but the right side is ${show(rt)}`);
      case "??":
        if (lt.k === "Optional" && assignable(rt, lt.inner)) return lt.inner;
        return fail(e, `?? needs an optional value on the left and a default of the same type, got ${show(lt)} and ${show(rt)}`);
    }
    // Arithmetic.
    if (op === "+" && lt.k === "Text" && rt.k === "Text") return T.Text;
    if (lt.k === "Time" && rt.k === "Duration" && (op === "+" || op === "-")) return T.Time;
    if (lt.k === "Time" && rt.k === "Time" && op === "-") return T.Duration;
    if (lt.k === "Duration" && rt.k === "Duration" && (op === "+" || op === "-")) return T.Duration;
    if (!isNumeric(lt) || !isNumeric(rt)) return fail(e, `cannot apply ${op} to ${show(lt)} and ${show(rt)}`);
    let result: Ty | null;
    if (lt.k === "Money" || rt.k === "Money") {
      const other = lt.k === "Money" ? rt : lt;
      if ((op === "+" || op === "-") && (other.k === "Money" || other.k === "NumLit")) result = T.Money;
      else if (op === "*" && (other.k === "Int" || other.k === "Decimal" || other.k === "NumLit")) result = T.Money;
      else result = null;
      if (!result) return fail(e, `Money ${op} ${show(other)} is not allowed; Money can be added to Money and multiplied by a number`);
    } else {
      result = unify(lt, rt);
      if (!result) return fail(e, `cannot apply ${op} to ${show(lt)} and ${show(rt)}; convert one side explicitly`);
    }
    if (op === "%" && sortOf(result) !== "Int") return fail(e, `% needs integers, got ${show(result)}`);
    if (op === "/" || op === "%") {
      const d = termOf(e.right, env);
      const s = sortOf(rt.k === "NumLit" ? result : rt) ?? "Int";
      const zero = num("0", s === "Real" ? "Real" : "Int");
      const goal: Term = d ? app("!=", [coerce(d, s)!, zero], "Bool") : { t: "opaque", key: `${printExpr(e.right)} != 0`, sort: "Bool" };
      oblige({ severity: "must", kind: "nonzero", span: e.span, claim: `${printExpr(e.right)} is not zero`, goal }, env);
    }
    types.set(e, result);
    rangeCheck(e, result, env);
    return result;
  };

  const call = (e: Extract<Expr, { kind: "Call" }>, env: Env): Ty => {
    if (e.callee.kind !== "Name") { e.args.forEach((a) => infer(a, env)); return fail(e, "only named functions and variants can be called"); }
    const name = e.callee.name;
    const ref = resolution.refs.get(e.callee);
    if (!ref) { e.args.forEach((a) => infer(a, env)); return T.Unknown; }
    const arity = (n: number) => {
      if (e.args.length !== n) { err(CODES.BAD_CALL, `${name} takes ${n} argument(s), got ${e.args.length}`, e.span); return false; }
      return true;
    };
    if (ref.kind === "variant") {
      const v = variantInfo(name)!;
      if (arity(v.variant.fields.length)) {
        e.args.forEach((a, i) => {
          const f = resolveType(v.variant.fields[i]!.type);
          expectTy(a, env, f.ty, `argument ${i + 1} of ${name}`);
          requirePreds(f.preds, a, f.ty, env, a.span, `argument ${i + 1} of ${name}`);
        });
      }
      return { k: "Enum", name: v.enumName };
    }
    if (ref.kind === "builtin") return builtin(name, e, env);
    if (ref.kind === "decl" && (ref.decl.kind === "FnDecl" || ref.decl.kind === "ExternFn")) {
      const sig = sigs.get(name)!;
      if (arity(sig.params.length)) {
        e.args.forEach((a, i) => {
          const prm = sig.params[i]!;
          expectTy(a, env, prm.type.ty, `argument ${prm.name} of ${name}`);
          requirePreds(prm.type.preds, a, prm.type.ty, env, a.span, `argument ${prm.name} of ${name}`);
        });
      }
      return sig.ret.ty;
    }
    if (ref.kind === "decl" && ref.decl.kind === "Permission") {
      const pd = ref.decl;
      if (arity(pd.params.length)) {
        e.args.forEach((a, i) => {
          const prm = resolveType(pd.params[i]!.type);
          expectTy(a, env, prm.ty, `argument ${pd.params[i]!.name} of ${name}`);
        });
      }
      return T.Bool;
    }
    if (ref.kind === "decl" && (ref.decl.kind === "Query" || ref.decl.kind === "Rule")) {
      e.args.forEach((a) => infer(a, env));
      return fail(e, `${name} is a ${ref.decl.kind.toLowerCase()}; it can be called from a test's when clause, not from an expression`, CODES.BAD_CALL);
    }
    e.args.forEach((a) => infer(a, env));
    return ref.kind === "import" ? T.Unknown : fail(e, `"${name}" cannot be called`, CODES.BAD_CALL);
  };

  const builtin = (name: string, e: Extract<Expr, { kind: "Call" }>, env: Env): Ty => {
    const ts = e.args.map((a) => infer(a, env));
    const want = (n: number) => { if (ts.length !== n) { err(CODES.BAD_CALL, `${name} takes ${n} argument(s), got ${ts.length}`, e.span); return false; } return true; };
    const isText = (t: Ty | undefined) => t?.k === "Text" || t?.k === "Unknown";
    switch (name) {
      case "len":
        if (want(1) && !["Text", "List", "Set", "Map", "Unknown"].includes(ts[0]!.k)) err(CODES.TYPE_MISMATCH, `len needs Text or a collection, got ${show(ts[0]!)}`, e.span);
        return T.Int;
      case "trim": case "lower": case "upper":
        if (want(1) && !isText(ts[0])) err(CODES.TYPE_MISMATCH, `${name} needs Text, got ${show(ts[0]!)}`, e.span);
        return T.Text;
      case "contains":
        if (want(2)) {
          const [a, b] = ts as [Ty, Ty];
          const ok = (isText(a) && isText(b)) || ((a.k === "List" || a.k === "Set") && unify(a.elem, b) !== null);
          if (!ok) err(CODES.TYPE_MISMATCH, `contains needs (Text, Text) or (a collection, an item), got ${show(a)} and ${show(b)}`, e.span);
        }
        return T.Bool;
      case "abs":
        if (want(1) && !isNumeric(ts[0]!) && ts[0]!.k !== "Unknown") err(CODES.TYPE_MISMATCH, `abs needs a number, got ${show(ts[0]!)}`, e.span);
        return ts[0] ?? T.Unknown;
      case "min": case "max": {
        if (!want(2)) return T.Unknown;
        const u = unify(ts[0]!, ts[1]!);
        if (!u || (!isNumeric(u) && u.k !== "Unknown")) return fail(e, `${name} needs two numbers of the same type, got ${show(ts[0]!)} and ${show(ts[1]!)}`);
        return u;
      }
    }
    return T.Unknown;
  };

  // ---------------------------------------------------------------- declarations

  const principalDecl = p.decls.find((d): d is Extract<Decl, { kind: "Principal" }> => d.kind === "Principal");
  const callerTy: Ty | undefined = principalDecl ? { k: "Entity", name: principalDecl.entity } : undefined;
  const usesCaps = new Set(p.decls.flatMap((d) => (d.kind === "Uses" ? d.caps.map((c) => `${c.service}.${c.op}`) : [])));

  const baseEnv = (decl: Decl): Env => {
    const env: Env = { decl: declKey(decl), vars: new Map(), facts: [], obligations: true, fieldTerms: new Map() };
    if (callerTy) { env.callerTy = callerTy; bindFacts(env, "caller", callerTy); }
    if ((decl.kind === "Rule" || decl.kind === "Query") && decl.permit.mode === "public") env.publicDecl = true;
    return env;
  };

  /** Every (entity, field) a clause list may write, for invalidating what we knew. */
  const writesIn = (cs: Clause[], scope: Map<string, Var>): { entity: string | null; field: string }[] => {
    const out: { entity: string | null; field: string }[] = [];
    const walk = (list: Clause[]) => {
      for (const cl of list) {
        if (cl.kind === "SetClause") {
          const t = scope.get(cl.target[0]!)?.ty;
          const inner = t?.k === "Optional" ? t.inner : t;
          out.push({ entity: inner?.k === "Entity" ? inner.name : null, field: cl.target[1]! });
        }
        if (cl.kind === "For") walk(cl.body);
        if (cl.kind === "IfClause") { walk(cl.then); walk(cl.else ?? []); }
      }
    };
    walk(cs);
    return out;
  };

  /** After writes we did not track exactly, every binding that might be affected gets an unknown value. */
  const invalidate = (env: Env, writes: { entity: string | null; field: string }[]): Env => {
    if (!writes.length) return env;
    const fieldTerms = new Map(env.fieldTerms ?? []);
    const bindings: [string, Ty][] = [...[...env.vars].map(([n, v]) => [n, v.ty] as [string, Ty]), ...(callerTy ? [["caller", callerTy] as [string, Ty]] : [])];
    for (const w of writes) {
      for (const [name, t] of bindings) {
        const ty = t.k === "Optional" ? t.inner : t;
        if (ty.k !== "Entity" || (w.entity !== null && ty.name !== w.entity)) continue;
        const d = entityDecl(ty.name);
        const f = d?.fields.find((x) => x.name === w.field);
        const sort = f ? sortOf(resolveType(f.type).ty) : null;
        if (sort) fieldTerms.set(`${name}.${w.field}`, fresh(`${name}.${w.field}`, sort));
      }
    }
    return { ...env, fieldTerms };
  };

  const bindParams = (env: Env, params: { name: string; type: TypeExpr }[]): Env => {
    for (const prm of params) {
      const r = resolveType(prm.type);
      env.vars.set(prm.name, { ty: r.ty });
      bindFacts(env, prm.name, r.ty);
      for (const pr of r.preds) {
        const sort = sortOf(r.ty);
        const penv: Env = { ...env, itTy: r.ty };
        if (sort) penv.itTerm = { t: "var", name: prm.name, sort };
        expectTy(pr.expr, penv, T.Bool, `the refinement on ${prm.name}`);
        const t = termOf(pr.expr, penv);
        if (t) env.facts.push({ term: t, text: pr.source.replace(/\bit\b/g, prm.name) });
      }
    }
    return env;
  };

  const checkRefinementsOf = (te: TypeExpr, where: string) => {
    const r = resolveType(te);
    const sort = sortOf(r.ty);
    for (const pr of r.preds) {
      const env: Env = { decl: where, vars: new Map(), facts: [], itTy: r.ty, obligations: false };
      if (sort) env.itTerm = { t: "var", name: "it", sort };
      expectTy(pr.expr, env, T.Bool, "a refinement");
    }
  };

  const entityDecl = (name: string) => {
    const d = decls.get(name);
    return d && d.kind === "Entity" ? d : undefined;
  };

  /** Checks the field assignments of a create or a given: known fields, right types, nothing required left out. */
  const checkAssigns = (entity: string, assigns: { name: string; value: Expr }[], env: Env, span: Span) => {
    const d = entityDecl(entity);
    if (!d) { assigns.forEach((a) => infer(a.value, env)); return; }
    for (const a of assigns) {
      const f = d.fields.find((x) => x.name === a.name);
      if (!f) { err(CODES.UNKNOWN_FIELD, `${entity} has no field "${a.name}"`, a.value.span); infer(a.value, env); continue; }
      const r = resolveType(f.type);
      expectTy(a.value, env, r.ty, `${entity}.${a.name}`);
    }
    const missing = d.fields.filter((f) => !f.default && !f.type.optional && !assigns.some((a) => a.name === f.name));
    if (missing.length) err(CODES.TYPE_MISMATCH, `creating ${entity} needs ${missing.map((f) => f.name).join(", ")}, which have no default`, span);
  };

  // Signatures first, so declarations can refer to each other in any order.
  for (const d of p.decls) {
    if (d.kind === "FnDecl" || d.kind === "ExternFn" || d.kind === "Query") {
      sigs.set(d.name, { name: d.name, params: d.params.map((x) => ({ name: x.name, type: resolveType(x.type) })), ret: resolveType(d.ret), decl: d });
    }
  }

  // ---------------------------------------------------------------- rule bodies

  const rejectNames = (r: Extract<Decl, { kind: "Rule" }>): string[] => {
    if (!r.rejects) return [];
    const e = decls.get(r.rejects);
    return e && e.kind === "EnumDecl" ? e.variants.map((v) => v.name) : [];
  };

  /** Checks a clause list. Returns the environment after it (lets bound, guard facts added). */
  const checkClauses = (cs: Clause[], env0: Env, rule: Extract<Decl, { kind: "Rule" }>, inCompensation: boolean): Env => {
    let env: Env = { ...env0, vars: new Map(env0.vars) };
    for (const cl of cs) {
      switch (cl.kind) {
        case "Let": {
          const t = infer(cl.value, env);
          const term = termOf(cl.value, env);
          env.vars.set(cl.name, term ? { ty: t, term } : { ty: t });
          env = { ...env, facts: [...env.facts] };
          bindFacts(env, cl.name, t);
          break;
        }
        case "Guard": {
          expectTy(cl.cond, env, T.Bool, "a guard condition");
          const allowed = rejectNames(rule);
          if (!allowed.includes(cl.reject)) {
            err(CODES.TYPE_MISMATCH, rule.rejects
              ? `${cl.reject} is not a variant of ${rule.rejects}, which ${rule.name} rejects with`
              : `${rule.name} rejects with ${cl.reject}, so it needs "rejects <Enum>" naming an enum that contains it`, cl.span);
          }
          env = withFact(env, cl.cond, false);
          break;
        }
        case "SetClause": {
          const [head, fieldName, ...more] = cl.target as [string, string, ...string[]];
          const v = env.vars.get(head);
          if (!v) { infer(cl.value, env); break; }
          if (v.ty.k === "Optional" && v.ty.inner.k === "Entity") {
            err(CODES.TYPE_MISMATCH, `${head} may be none here; check it first, for example: if ${head} != none { … }`, cl.span);
            infer(cl.value, env);
            break;
          }
          if (v.ty.k !== "Entity") { if (v.ty.k !== "Unknown") err(CODES.TYPE_MISMATCH, `only fields of stored entities can be set, and ${head} is ${show(v.ty)}`, cl.span); infer(cl.value, env); break; }
          if (more.length) { info(CODES.NOT_YET, "setting nested fields: supported after milestone 2", cl.span); infer(cl.value, env); break; }
          const ed = entityDecl(v.ty.name)!;
          const f = ed.fields.find((x) => x.name === fieldName);
          if (!f) { err(CODES.UNKNOWN_FIELD, `${v.ty.name} has no field "${fieldName}"`, cl.span); infer(cl.value, env); break; }
          const fty = resolveType(f.type).ty;
          expectTy(cl.value, env, fty, `${v.ty.name}.${fieldName}`);
          // Later reads of head.field mean the value just written. Facts about the old value stay
          // true of the old value. Any other binding of the same entity type might be this very
          // entity, so its copy of the field becomes unknown.
          const newTerm = termOf(cl.value, env);
          const sort = sortOf(fty);
          env = invalidate(env, [{ entity: v.ty.name, field: fieldName }]);
          if (sort) env.fieldTerms!.set(`${head}.${fieldName}`, newTerm ?? fresh(`${head}.${fieldName}`, sort));
          break;
        }
        case "Create": {
          if (!entityDecl(cl.entity)) { err(CODES.TYPE_MISMATCH, `${cl.entity} is not an entity`, cl.span); break; }
          checkAssigns(cl.entity, cl.assigns, env, cl.span);
          if (cl.as) env.vars.set(cl.as, { ty: { k: "Entity", name: cl.entity } });
          break;
        }
        case "Delete": {
          const t = infer(cl.target, env);
          if (t.k !== "Entity" && t.k !== "Unknown") err(CODES.TYPE_MISMATCH, `only stored entities can be deleted, and this is ${show(t)}`, cl.span);
          break;
        }
        case "For": {
          const ct = infer(cl.coll, env);
          const elem: Ty = ct.k === "List" || ct.k === "Set" ? ct.elem : ct.k === "Entity" ? ct : T.Unknown;
          if (elem.k === "Unknown" && ct.k !== "Unknown") err(CODES.TYPE_MISMATCH, `cannot iterate over ${show(ct)}`, cl.span);
          const inner: Env = { ...env, vars: new Map(env.vars).set(cl.binder, { ty: elem }), facts: [...env.facts] };
          bindFacts(inner, cl.binder, elem);
          // The body may run any number of times, so check it with nothing known about what it writes.
          const writes = writesIn(cl.body, inner.vars);
          const after = checkClauses(cl.body, invalidate(inner, writes), rule, inCompensation);
          env = invalidate({ ...env, facts: env.facts.filter((f) => after.facts.includes(f)) }, writesIn(cl.body, after.vars));
          break;
        }
        case "IfClause": {
          expectTy(cl.cond, env, T.Bool, "an if condition");
          const a = checkClauses(cl.then, withFact(env, cl.cond, false), rule, inCompensation);
          const b = checkClauses(cl.else ?? [], withFact(env, cl.cond, true), rule, inCompensation);
          // A field written in either branch is one of the two values afterwards.
          const fieldTerms = new Map(env.fieldTerms ?? []);
          const cond = termOf(cl.cond, env);
          for (const k of new Set([...(a.fieldTerms ?? new Map()).keys(), ...(b.fieldTerms ?? new Map()).keys()])) {
            const ta = a.fieldTerms?.get(k), tb = b.fieldTerms?.get(k);
            if (ta === tb) continue;
            const known = (ta ?? tb)!;
            const sort: Sort = known.t === "bool" ? "Bool" : known.sort;
            const base: Term = env.fieldTerms?.get(k) ?? { t: "opaque", key: k, sort };
            fieldTerms.set(k, cond ? app("ite", [cond, ta ?? base, tb ?? base], sort) : fresh(k, sort));
          }
          env = { ...env, fieldTerms, facts: env.facts.filter((f) => a.facts.includes(f) && b.facts.includes(f)) };
          break;
        }
        case "Emit": {
          const cap = `${cl.cap.service}.${cl.cap.op}`;
          if (inCompensation) err(CODES.TYPE_MISMATCH, "a confirm or compensate block cannot emit effects (design doc, 2.4)", cl.span);
          if (!usesCaps.has(cap)) err(CODES.TYPE_MISMATCH, `${rule.name} emits ${cap}, which the module does not declare; add "uses ${cap}"`, cl.span);
          cl.args.forEach((a) => infer(a, env));
          later.set("Effects (they are queued, but dispatching them and running confirm and compensate blocks arrives in milestone 4)", cl.span);
          // Confirm and compensate blocks run later, as their own system steps, against the state
          // at that time (design doc, 2.8). So they know only what was captured: the rule's
          // parameters with their refinements (A3), and bindings by type. Nothing the step
          // learned from guards or its own writes carries over, and stored fields are read
          // fresh, constrained only by the field refinements that every commit maintains.
          const capturedEnv = () => {
            const e2 = bindParams(baseEnv(rule), rule.params);
            for (const [name, v] of env.vars) {
              if (e2.vars.has(name)) continue;
              e2.vars.set(name, { ty: v.ty });
              bindFacts(e2, name, v.ty);
            }
            return e2;
          };
          if (cl.confirm) checkClauses(cl.confirm, capturedEnv(), rule, true);
          if (cl.compensate) checkClauses(cl.compensate, capturedEnv(), rule, true);
          break;
        }
        case "Raise": {
          const ev = decls.get(cl.event);
          if (!ev || ev.kind !== "EventDecl") { cl.args.forEach((a) => infer(a, env)); break; }
          if (cl.args.length !== ev.params.length) err(CODES.BAD_CALL, `${cl.event} takes ${ev.params.length} argument(s), got ${cl.args.length}`, cl.span);
          cl.args.forEach((a, i) => { const prm = ev.params[i]; if (prm) expectTy(a, env, resolveType(prm.type).ty, `argument ${prm.name} of ${cl.event}`); else infer(a, env); });
          break;
        }
        case "Return": {
          const t = infer(cl.value, env);
          if (rule.ret && !assignable(t, resolveType(rule.ret).ty)) err(CODES.TYPE_MISMATCH, `${rule.name} should return ${show(resolveType(rule.ret).ty)}, but this is ${show(t)}`, cl.span);
          if (!rule.ret) err(CODES.TYPE_MISMATCH, `${rule.name} returns a value, so it needs a return type, as in rule ${rule.name}(…): T`, cl.span);
          break;
        }
      }
    }
    return env;
  };

  const checkPermit = (permit: Extract<Decl, { kind: "Rule" }>["permit"], env: Env) => {
    if (permit.mode === "expr") expectTy(permit.expr!, env, T.Bool, "a permit condition");
    return permit.mode === "expr" ? withFact(env, permit.expr!, false) : env;
  };

  const containsEntity = (t: Ty): boolean =>
    t.k === "Entity" || (t.k === "List" || t.k === "Set" ? containsEntity(t.elem) : t.k === "Optional" ? containsEntity(t.inner)
      : t.k === "Record" ? t.fields.some(([, f]) => containsEntity(f)) : t.k === "Map" ? containsEntity(t.value) : false);

  // ---------------------------------------------------------------- tests

  const later = new Map<string, Span>();
  const checkAct = (act: Act, env: Env) => {
    const target = decls.get(act.call);
    if (act.as) {
      const t = infer(act.as, env);
      if (callerTy && !assignable(t, callerTy)) err(CODES.TYPE_MISMATCH, `"as" names the caller, which must be ${show(callerTy)}, but this is ${show(t)}`, act.as.span);
      if (!callerTy) err(CODES.TYPE_MISMATCH, `"as" sets the caller, which needs a principal declaration`, act.as.span);
    }
    if (!target || (target.kind !== "Query" && target.kind !== "Rule")) {
      if (target) err(CODES.BAD_CALL, `${act.call} is not a rule or query`, act.span);
      act.args.forEach((a) => infer(a, env));
      return;
    }
    const params = target.params.map((x) => ({ name: x.name, type: resolveType(x.type) }));
    if (act.args.length !== params.length) err(CODES.BAD_CALL, `${act.call} takes ${params.length} argument(s), got ${act.args.length}`, act.span);
    act.args.forEach((a, i) => { const prm = params[i]; if (prm) expectTy(a, env, prm.type.ty, `argument ${prm.name} of ${act.call}`); else infer(a, env); });
    if (act.outcome.kind === "reject") {
      const allowed = [...BUILTIN_OUTCOMES, ...(target.kind === "Rule" ? rejectNames(target) : [])];
      if (!allowed.includes(act.outcome.name)) err(CODES.TYPE_MISMATCH, `${act.call} cannot be rejected with ${act.outcome.name}; it can be rejected with ${allowed.join(", ")}`, act.span);
    }
    const resultTy = target.kind === "Query" ? sigs.get(act.call)!.ret.ty : target.ret ? resolveType(target.ret).ty : T.None;
    const tenv: Env = { ...env, resultTy, inThen: true };
    for (const t of act.thens) expectTy(t, tenv, T.Bool, "a then clause");
  };

  // ---------------------------------------------------------------- declarations

  for (const d of p.decls) {
    switch (d.kind) {
      case "Requirement": case "Uses": break;
      case "Principal": {
        const e = entityDecl(d.entity);
        if (!e) { err(CODES.TYPE_MISMATCH, `principal ${d.entity} must be an entity`, d.span); break; }
        if (d.by && !e.fields.some((f) => f.name === d.by)) err(CODES.UNKNOWN_FIELD, `${d.entity} has no field "${d.by}" to identify callers by`, d.span);
        break;
      }
      case "TypeDecl": checkRefinementsOf(d.type, declKey(d)); break;
      case "EnumDecl": for (const v of d.variants) for (const f of v.fields) checkRefinementsOf(f.type, declKey(d)); break;
      case "Entity":
        for (const f of d.fields) {
          checkRefinementsOf(f.type, declKey(d));
          if (f.default) expectTy(f.default, { ...baseEnv(d), obligations: false }, resolveType(f.type).ty, `the default of ${d.name}.${f.name}`);
        }
        break;
      case "FnDecl": {
        const env = bindParams(baseEnv(d), d.params);
        const sig = sigs.get(d.name)!;
        const bt = infer(d.body, env, sig.ret.ty);
        if (!assignable(bt, sig.ret.ty)) err(CODES.TYPE_MISMATCH, `${d.name} should return ${show(sig.ret.ty)}, but its body is ${show(bt)}`, d.body.span);
        requirePreds(sig.ret.preds, d.body, sig.ret.ty, env, d.body.span, `the result of ${d.name}`);
        break;
      }
      case "ExternFn": later.set("Extern functions (they are bound to host code in milestone 5)", d.span); break;
      case "Permission": {
        const env = bindParams(baseEnv(d), d.params);
        expectTy(d.body, env, T.Bool, `permission ${d.name}`);
        break;
      }
      case "Query": {
        const env = checkPermit(d.permit, bindParams(baseEnv(d), d.params));
        const sig = sigs.get(d.name)!;
        const bt = infer(d.body, env, sig.ret.ty);
        if (!assignable(bt, sig.ret.ty)) err(CODES.TYPE_MISMATCH, `${d.name} should return ${show(sig.ret.ty)}, but its body is ${show(bt)}`, d.body.span);
        requirePreds(sig.ret.preds, d.body, sig.ret.ty, env, d.body.span, `the result of ${d.name}`);
        if (containsEntity(sig.ret.ty)) {
          diagnostics.push({ code: CODES.ENTITY_IN_QUERY, severity: "warning", span: d.span,
            message: `${d.name} returns ${show(sig.ret.ty)}, which includes every field of the entity. Return a view record with only the fields callers should see (amendment A25).` });
        }
        break;
      }
      case "Rule": {
        if (d.permit.mode === "anyone" || d.permit.mode === "expr") { /* fine with or without a principal */ }
        const env = checkPermit(d.permit, bindParams(baseEnv(d), d.params));
        checkClauses(d.clauses, env, d, false);
        break;
      }
      case "Invariant": {
        const env = { ...baseEnv(d), obligations: false };
        expectTy(d.body, env, T.Bool, `invariant ${d.name}`);
        later.set("Invariant proofs (invariants are checked at every commit now; proving them arrives in milestone 3)", d.span);
        break;
      }
      case "Assert": {
        const r = decls.get(d.rule);
        if (!r || r.kind !== "Rule") break;
        const env = bindParams({ ...baseEnv(d), obligations: false }, r.params);
        expectTy(d.body, env, T.Bool, `assert ${d.name}`);
        later.set("Asserts (they are type-checked now; proving them arrives in milestone 3)", d.span);
        break;
      }
      case "EventDecl": for (const prm of d.params) resolveType(prm.type); break;
      case "Trigger": {
        const ev = d.event.parts.length === 1 ? decls.get(d.event.parts[0]!) : undefined;
        const env = { ...baseEnv(d), obligations: false };
        if (ev && ev.kind === "EventDecl") {
          if (d.binders.length !== ev.params.length) err(CODES.BAD_CALL, `${ev.name} carries ${ev.params.length} value(s), but the trigger names ${d.binders.length}`, d.span);
          d.binders.forEach((b, i) => { const prm = ev.params[i]; env.vars.set(b, { ty: prm ? resolveType(prm.type).ty : T.Unknown }); });
        } else d.binders.forEach((b) => env.vars.set(b, { ty: T.Unknown }));
        const r = decls.get(d.rule);
        if (r && r.kind === "Rule") {
          if (d.args.length !== r.params.length) err(CODES.BAD_CALL, `${r.name} takes ${r.params.length} argument(s), got ${d.args.length}`, d.span);
          d.args.forEach((a, i) => {
            const prm = r.params[i];
            if (!prm) { infer(a, env); return; }
            const want = resolveType(prm.type).ty;
            // A trigger may pass an Id where the rule takes the entity: the runtime loads it.
            const got = infer(a, env);
            const ok = assignable(got, want) || (want.k === "Entity" && got.k === "Id" && got.target === want.name);
            if (!ok) err(CODES.TYPE_MISMATCH, `argument ${prm.name} of ${r.name} should be ${show(want)}, but it is ${show(got)}`, a.span);
          });
          if (d.asSystem && r.permit.mode !== "system" && r.permit.mode !== "anyone") { /* system steps pass any permit */ }
        }
        break;
      }
      case "TestDecl": case "PropertyDecl": {
        const env: Env = { ...baseEnv(d), obligations: false };
        if (d.kind === "PropertyDecl") {
          for (const prm of d.params) env.vars.set(prm.name, { ty: resolveType(prm.type).ty });
          if (d.where) expectTy(d.where, env, T.Bool, "a property's where condition");
        }
        for (const g of d.givens) {
          if (!entityDecl(g.entity)) { err(CODES.TYPE_MISMATCH, `${g.entity} is not an entity`, g.span); continue; }
          checkAssigns(g.entity, g.assigns, env, g.span);
          env.vars.set(g.name, { ty: { k: "Entity", name: g.entity } });
        }
        for (const act of d.acts) checkAct(act, env);
        break;
      }
      case "Migration": later.set("Migrations (they run, with a dry run, from milestone 6)", d.span); break;
    }
  }
  for (const [what, span] of later) info(CODES.NOT_YET, what, span);

  return { diagnostics, obligations, types, resolution, sigs, resolveType };
}
