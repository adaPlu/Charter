// @charter/interp: the reference interpreter (design doc, sections 2.8 and 4.1). It follows
// the semantics directly and stays unoptimized, because it is the oracle the compiler is
// tested against.
//
// Milestone 1 scope: functions and queries. Rules, entities and the store arrive in
// milestone 2; touching them raises NotYet rather than guessing.
import type { Program, Expr, Decl, Arm } from "@charter/syntax";
import type { CheckResult, Ty, Pred } from "@charter/types";
import { V, Fault, SCALE, checkInt, divHalfEven, equal, compare, parseDec, toDec, show, type Value } from "./values.ts";

export * from "./values.ts";

export type Outcome =
  | { kind: "ok"; value: Value }
  | { kind: "reject"; name: string; detail?: string }
  | { kind: "fault"; fault: string; message: string };

export class NotYet extends Error {}

type Env = Map<string, Value>;

export interface Interpreter {
  callQuery(name: string, args: Value[]): Outcome;
  callFn(name: string, args: Value[]): Value;
  /** Evaluates a closed expression, such as a command-line argument or a test argument. */
  evalClosed(e: Expr, env?: Env, extra?: { it?: Value; result?: Value }): Value;
  /** Checks a value against a refined type's predicates. */
  satisfies(preds: Pred[], value: Value): boolean;
  coerce(v: Value, ty: Ty): Value;
}

export interface InterpOptions { now?: number }

export function interpreter(p: Program, c: CheckResult, opts: InterpOptions = {}): Interpreter {
  const now = opts.now ?? 0;
  const { decls, variants, refs } = c.resolution;

  const enumOf = (variant: string) => {
    const d = decls.get(variants.get(variant)!) as Extract<Decl, { kind: "EnumDecl" }>;
    return { decl: d, v: d.variants.find((x) => x.name === variant)! };
  };

  /** Converts a value to a declared type: integer literals become decimals where needed. */
  const coerce = (v: Value, ty: Ty): Value => {
    if ((ty.k === "Decimal" || ty.k === "Money") && v.t === "int") return V.dec(BigInt(v.v) * SCALE);
    if (ty.k === "Int" && v.t === "dec") {
      // Only reachable from an integer literal too large for Int (see the Literal case).
      if (v.v % SCALE !== 0n) throw new Fault("type", `${show(v)} is not an integer`);
      const n = v.v / SCALE;
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Fault("overflow", `${show(v)} is outside ±(2^53 - 1)`);
      return V.int(Number(n));
    }
    if (ty.k === "Optional" && v.t !== "none") return coerce(v, ty.inner);
    if (ty.k === "List" && v.t === "list") return { t: "list", items: v.items.map((x) => coerce(x, ty.elem)) };
    return v;
  };

  /** Resolution for expressions parsed outside the program, such as command-line arguments. */
  const refOf = (n: Extract<Expr, { kind: "Name" }>) => {
    const r = refs.get(n);
    if (r) return r;
    if (variants.has(n.name)) return { kind: "variant" as const, enumName: variants.get(n.name)!, variant: n.name };
    if (decls.has(n.name)) return { kind: "decl" as const, decl: decls.get(n.name)! };
    if (["len", "trim", "lower", "upper", "contains", "abs", "min", "max"].includes(n.name)) return { kind: "builtin" as const, name: n.name };
    return undefined;
  };

  const truthy = (v: Value): boolean => {
    if (v.t !== "bool") throw new Fault("type", `expected true or false, got ${show(v)}`);
    return v.v;
  };

  const satisfies = (preds: Pred[], value: Value) => preds.every((pr) => truthy(evalExpr(pr.expr, new Map(), { it: value })));

  const arith = (op: string, a: Value, b: Value): Value => {
    if (a.t === "text" && b.t === "text" && op === "+") return V.text(a.v + b.v);
    if (a.t === "time" && b.t === "dur") return { t: "time", v: op === "+" ? a.v + b.v : a.v - b.v };
    if (a.t === "time" && b.t === "time" && op === "-") return { t: "dur", v: a.v - b.v };
    if (a.t === "dur" && b.t === "dur") return { t: "dur", v: op === "+" ? a.v + b.v : a.v - b.v };
    if (a.t === "int" && b.t === "int") {
      switch (op) {
        case "+": return V.int(a.v + b.v);
        case "-": return V.int(a.v - b.v);
        case "*": { const r = a.v * b.v; checkInt(r); return V.int(r); }
        case "/": if (b.v === 0) throw new Fault("division", "division by zero"); return V.int(Math.trunc(a.v / b.v));
        case "%": if (b.v === 0) throw new Fault("division", "division by zero"); return V.int(a.v % b.v);
      }
    }
    const x = toDec(a), y = toDec(b);
    switch (op) {
      case "+": return V.dec(x + y);
      case "-": return V.dec(x - y);
      case "*": return V.dec(divHalfEven(x * y, SCALE));
      case "/": return V.dec(divHalfEven(x * SCALE, y));
    }
    throw new Fault("type", `cannot apply ${op} to ${show(a)} and ${show(b)}`);
  };

  const iterate = (coll: Value): Value[] => {
    if (coll.t === "list") return coll.items;
    throw new NotYet("iterating over entity tables arrives in milestone 2");
  };

  const builtin = (name: string, args: Value[]): Value => {
    const [a, b] = args as [Value, Value];
    switch (name) {
      case "len":
        if (a.t === "text") return V.int([...a.v].length);
        if (a.t === "list") return V.int(a.items.length);
        break;
      case "trim": if (a.t === "text") return V.text(a.v.trim()); break;
      case "lower": if (a.t === "text") return V.text(a.v.toLowerCase()); break;
      case "upper": if (a.t === "text") return V.text(a.v.toUpperCase()); break;
      case "contains":
        if (a.t === "text" && b.t === "text") return V.bool(a.v.includes(b.v));
        if (a.t === "list") return V.bool(a.items.some((x) => equal(x, b)));
        break;
      case "abs":
        if (a.t === "int") return V.int(Math.abs(a.v));
        if (a.t === "dec") return V.dec(a.v < 0n ? -a.v : a.v);
        break;
      case "min": return compare(a, b) <= 0 ? a : b;
      case "max": return compare(a, b) >= 0 ? a : b;
    }
    throw new Fault("type", `${name} cannot take ${args.map(show).join(", ")}`);
  };

  const matchArm = (arm: Arm, v: Value, env: Env): Env | null => {
    if (arm.pattern.kind === "Wildcard") return env;
    if (v.t !== "enum" || v.variant !== arm.pattern.name) return null;
    const inner = new Map(env);
    (arm.pattern.binders ?? []).forEach((b, i) => { if (b !== "_") inner.set(b, v.fields[i]!); });
    return inner;
  };

  const callFn = (name: string, args: Value[]): Value => {
    const sig = c.sigs.get(name)!;
    const d = sig.decl;
    if (d.kind !== "FnDecl") throw new NotYet(`${name} is an extern fn; extern functions are bound to host code from milestone 5`);
    const env: Env = new Map();
    sig.params.forEach((prm, i) => {
      const v = coerce(args[i]!, prm.type.ty);
      if (!satisfies(prm.type.preds, v)) throw new Fault("refinement", `argument ${prm.name} = ${show(v)} breaks the refinement of ${name}`);
      env.set(prm.name, v);
    });
    const out = coerce(evalExpr(d.body, env), sig.ret.ty);
    if (!satisfies(sig.ret.preds, out)) throw new Fault("refinement", `${name} returned ${show(out)}, which breaks its refined return type`);
    return out;
  };

  const evalExpr = (e: Expr, env: Env, extra: { it?: Value; result?: Value } = {}): Value => {
    const ev = (x: Expr, en: Env = env) => evalExpr(x, en, extra);
    switch (e.kind) {
      case "Literal":
        switch (e.type) {
          case "int": {
            // A literal's type is settled by where it is used (it may be a Decimal), so a literal
            // too large for Int starts out as an exact decimal instead of faulting.
            const n = BigInt(e.value);
            return n <= BigInt(Number.MAX_SAFE_INTEGER) ? V.int(Number(n)) : V.dec(n * SCALE);
          }
          case "decimal": return V.dec(parseDec(e.value));
          case "string": return V.text(e.value);
          case "bool": return V.bool(e.value === "true");
          case "none": return V.none;
          case "duration": {
            const m = /^(\d+)(ms|s|m|h|d)$/.exec(e.value)!;
            const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as "ms"];
            return { t: "dur", v: Number(m[1]) * unit };
          }
        }
        break;
      case "Name": {
        if (env.has(e.name)) return env.get(e.name)!;
        const ref = refOf(e);
        if (ref?.kind === "variant") return { t: "enum", type: ref.enumName, variant: ref.variant, fields: [] };
        throw new NotYet(`"${e.name}" needs the store, which arrives in milestone 2`);
      }
      case "Keyword":
        if (e.name === "it" && extra.it) return extra.it;
        if (e.name === "result" && extra.result) return extra.result;
        if (e.name === "now") return { t: "time", v: now };
        throw new NotYet(`${e.name} arrives in milestone 2`);
      case "Old": throw new NotYet("old(...) needs the store, which arrives in milestone 2");
      case "IfExpr": return truthy(ev(e.cond)) ? ev(e.then) : ev(e.else);
      case "Match": {
        const v = ev(e.subject);
        for (const arm of e.arms) { const en = matchArm(arm, v, env); if (en) return ev(arm.body, en); }
        throw new Fault("match", `no arm matches ${show(v)}`);
      }
      case "Binary": {
        if (e.op === "and") return V.bool(truthy(ev(e.left)) && truthy(ev(e.right)));
        if (e.op === "or") return V.bool(truthy(ev(e.left)) || truthy(ev(e.right)));
        const a = ev(e.left);
        if (e.op === "??") return a.t === "none" ? ev(e.right) : a;
        const b = ev(e.right);
        switch (e.op) {
          case "==": return V.bool(equal(a, b));
          case "!=": return V.bool(!equal(a, b));
          case "<": return V.bool(compare(a, b) < 0);
          case "<=": return V.bool(compare(a, b) <= 0);
          case ">": return V.bool(compare(a, b) > 0);
          case ">=": return V.bool(compare(a, b) >= 0);
          case "in": return V.bool(iterate(b).some((x) => equal(a, x)));
          default: return arith(e.op, a, b);
        }
      }
      case "Not": return V.bool(!truthy(ev(e.operand)));
      case "Neg": {
        const v = ev(e.operand);
        if (v.t === "int") return V.int(-v.v);
        if (v.t === "dec") return V.dec(-v.v);
        if (v.t === "dur") return { t: "dur", v: -v.v };
        throw new Fault("type", `cannot negate ${show(v)}`);
      }
      case "Call": {
        const callee = e.callee as Extract<Expr, { kind: "Name" }>;
        const args = e.args.map((a) => ev(a));
        const ref = refOf(callee);
        if (ref?.kind === "variant") {
          const { v } = enumOf(ref.variant);
          const fields = args.map((a, i) => coerce(a, c.resolveType(v.fields[i]!.type).ty));
          return { t: "enum", type: ref.enumName, variant: ref.variant, fields };
        }
        if (ref?.kind === "builtin") return builtin(ref.name, args);
        if (ref?.kind === "decl" && (ref.decl.kind === "FnDecl" || ref.decl.kind === "ExternFn")) return callFn(callee.name, args);
        throw new NotYet(`calling ${callee.name} arrives in milestone 2`);
      }
      case "FieldAccess": {
        const o = ev(e.object);
        if (o.t === "record") { const f = o.fields.find(([n]) => n === e.name); if (f) return f[1]; }
        throw new NotYet(`field ${e.name} of ${show(o)} needs the store, which arrives in milestone 2`);
      }
      case "Index": {
        const o = ev(e.object), i = ev(e.index);
        if (o.t === "list" && i.t === "int") {
          const item = o.items[i.v];
          if (!item) throw new Fault("index", `index ${i.v} is outside a list of ${o.items.length}`);
          return item;
        }
        throw new NotYet("indexing entity tables arrives in milestone 2");
      }
      case "Quant": {
        const items = iterate(ev(e.coll));
        const test = (x: Value) => truthy(ev(e.body, new Map(env).set(e.binder, x)));
        return V.bool(e.q === "forall" ? items.every(test) : items.some(test));
      }
      case "Count": case "Sum": case "Select": {
        let items = iterate(ev(e.coll)).map((x) => new Map(env).set(e.binder, x));
        if (e.where) items = items.filter((en) => truthy(ev(e.where!, en)));
        if (e.kind === "Count") return V.int(items.length);
        if (e.kind === "Sum") return items.reduce<Value>((acc, en) => arith("+", acc, ev(e.value, en)), V.int(0));
        if (e.orderBy.length) {
          const keyed = items.map((en) => ({ en, keys: e.orderBy.map((o) => ev(o, en)) }));
          keyed.sort((x, y) => { for (let i = 0; i < x.keys.length; i++) { const d = compare(x.keys[i]!, y.keys[i]!); if (d) return d; } return 0; });
          items = keyed.map((k) => k.en);
        }
        return { t: "list", items: items.map((en) => ev(e.value, en)) };
      }
      case "ListLit": return { t: "list", items: e.items.map((x) => ev(x)) };
      case "RecordLit": return { t: "record", fields: e.assigns.map((a) => [a.name, ev(a.value)] as [string, Value]) };
    }
    throw new Fault("internal", `cannot evaluate ${(e as Expr).kind}`);
  };

  const callQuery = (name: string, args: Value[]): Outcome => {
    const sig = c.sigs.get(name);
    if (!sig || sig.decl.kind !== "Query") throw new NotYet(`${name} is not a query; rules run from milestone 2`);
    const q = sig.decl;
    try {
      const env: Env = new Map();
      for (let i = 0; i < sig.params.length; i++) {
        const prm = sig.params[i]!;
        const v = coerce(args[i]!, prm.type.ty);
        if (!satisfies(prm.type.preds, v)) return { kind: "reject", name: "ValidationError", detail: prm.name };
        env.set(prm.name, v);
      }
      if (q.permit.mode === "expr" && !truthy(evalExpr(q.permit.expr!, env))) return { kind: "reject", name: "Denied" };
      return { kind: "ok", value: coerce(evalExpr(q.body, env), sig.ret.ty) };
    } catch (err) {
      if (err instanceof Fault) return { kind: "fault", fault: err.kind, message: err.message };
      throw err;
    }
  };

  return { callQuery, callFn, evalClosed: (e, env = new Map(), extra = {}) => evalExpr(e, env, extra), satisfies, coerce };
}

export function showOutcome(o: Outcome): string {
  switch (o.kind) {
    case "ok": return `Ok  ${show(o.value)}`;
    case "reject": return `Rejected  ${o.name}${o.detail ? `(${o.detail})` : ""}`;
    case "fault": return `Fault  ${o.fault}: ${o.message}`;
  }
}
