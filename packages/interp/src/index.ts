// @charter/interp: the reference interpreter (design doc, sections 2.8 and 4.1). It follows
// the step semantics directly and stays unoptimized, because it is the oracle the compiler is
// tested against.
//
// A step (one rule call) runs inside one store transaction:
//   1. entity arguments are loaded (NotFound), parameter refinements checked (ValidationError)
//   2. the permit is evaluated (Denied)
//   3. clauses run against a working copy; a failed guard rejects
//   4. every invariant, field refinement and reference is checked (InvariantViolated)
//   5. on success the working copy, queued effects and the step record commit together
// A rejected or faulted step is logged and changes nothing else. Events raised by a step run
// their triggers afterwards, each as its own step, with a seed derived from the parent's, so
// replay reproduces them exactly (amendment A10).
//
// Milestone 2 scope: effects are queued in the outbox but not dispatched, so confirm and
// compensate blocks do not run yet (milestone 4). Extern functions are bound in milestone 5.
import { createHash, randomBytes } from "node:crypto";
import type { Program, Expr, Decl, Arm, Clause, TypeExpr } from "@charter/syntax";
import type { CheckResult, Ty, Pred } from "@charter/types";
import { Store, canonicalJson, type Json, type StepRecord } from "@charter/store";
import {
  V, Fault, SCALE, checkInt, divHalfEven, toCents, equal, compare, parseDec, toDec, show, encode, decode, type Value,
} from "./values.ts";

export * from "./values.ts";

export type Outcome =
  | { kind: "ok"; value: Value }
  | { kind: "reject"; name: string; detail?: string }
  | { kind: "fault"; fault: string; message: string };

export interface StepResult {
  outcome: Outcome;
  /** Effects this step queued, as records { cap, args }. Empty unless the step committed. */
  effects: Value[];
  /** Outcomes of steps started by triggers, in the order they ran. */
  triggered: { rule: string; outcome: Outcome }[];
}

export class NotYet extends Error {}

type Env = Map<string, Value>;
type Rec = Map<string, Value>;

/** Read access to state: the committed store, or the store plus a step's working copy. */
interface View { get(entity: string, id: string): Rec | undefined; ids(entity: string): string[] }

interface Ctx {
  view: View;
  before?: View;
  caller: Value | null;
  system: boolean;
  now: number;
  it?: Value;
  result?: Value;
  effects?: Value[];
  accepted?: boolean;
  step?: StepState;
}

class StepState {
  overlay = new Map<string, { entity: string; id: string; rec: Rec | null; dirty: boolean }>();
  effects: { cap: string; args: Value[] }[] = [];
  events: { event: string; args: Value[] }[] = [];
  counter = 0;
  base: View;
  n: number;
  seed: string;
  constructor(base: View, n: number, seed: string) { this.base = base; this.n = n; this.seed = seed; }
  view(): View {
    return {
      get: (entity, id) => {
        const o = this.overlay.get(`${entity}\u0000${id}`);
        return o ? o.rec ?? undefined : this.base.get(entity, id);
      },
      ids: (entity) => {
        const set = new Set(this.base.ids(entity));
        for (const o of this.overlay.values()) if (o.entity === entity) { if (o.rec) set.add(o.id); else set.delete(o.id); }
        return [...set].sort();
      },
    };
  }
  write(entity: string, id: string, rec: Rec | null) { this.overlay.set(`${entity}\u0000${id}`, { entity, id, rec, dirty: true }); }
  /** New ids derive from the step's random seed, so they replay exactly but cannot be guessed (A10). */
  newId(): string {
    return createHash("sha256").update(`${this.seed}:${this.n}:${this.counter++}`).digest("hex").slice(0, 16);
  }
}

function storeView(store: Store): View {
  return {
    get: (entity, id) => {
      const r = store.get(entity, id);
      return r ? new Map(Object.entries(r).map(([k, v]) => [k, decode(v)])) : undefined;
    },
    ids: (entity) => store.scan(entity).map((r) => r.id),
  };
}

const encodeRec = (rec: Rec) => Object.fromEntries([...rec].map(([k, v]) => [k, encode(v)])) as { [k: string]: Json };

function encodeOutcome(o: Outcome): Json {
  return o.kind === "ok" ? { ok: encode(o.value) } : o.kind === "reject" ? { reject: o.name, detail: o.detail ?? null } : { fault: o.fault };
}

export interface Interpreter {
  store: Store;
  callQuery(name: string, args: Value[], opts?: CallOptions): Outcome;
  callRule(name: string, args: Value[], opts?: CallOptions): StepResult;
  callFn(name: string, args: Value[]): Value;
  /** Evaluates an expression outside any step, such as a command-line or test argument. */
  evalClosed(e: Expr, env?: Env, extra?: Partial<Ctx>): Value;
  satisfies(preds: Pred[], value: Value): boolean;
  coerce(v: Value, ty: Ty): Value;
  /** Creates a record directly, for a test's given setup. Not a step, so it is not logged. */
  createRecord(entity: string, assigns: [string, Value][], env?: Env): Value;
  /** A read-only view of the current state, for old(...) in tests. */
  snapshot(): View;
  /** Re-runs the step log on an empty store and reports whether outcomes and state match. */
  replay(): { steps: number; mismatches: string[]; stateHash: string; replayedHash: string };
}

export interface CallOptions { caller?: Value | null; system?: boolean; now?: number; seed?: string }
export interface InterpOptions { now?: number | (() => number); store?: Store }

export function interpreter(p: Program, c: CheckResult, opts: InterpOptions = {}): Interpreter {
  const store = opts.store ?? new Store();
  const clock = typeof opts.now === "function" ? opts.now : () => (opts.now as number | undefined) ?? 0;
  const { decls, variants, refs } = c.resolution;
  const principal = p.decls.find((d) => d.kind === "Principal");
  const invariants = p.decls.filter((d): d is Extract<Decl, { kind: "Invariant" }> => d.kind === "Invariant");
  const entities = p.decls.filter((d): d is Extract<Decl, { kind: "Entity" }> => d.kind === "Entity");
  const triggers = p.decls.filter((d): d is Extract<Decl, { kind: "Trigger" }> => d.kind === "Trigger");
  const committed = storeView(store);

  /** Resolution, including for expressions parsed outside the program (command-line arguments). */
  const refOf = (n: Extract<Expr, { kind: "Name" }>) => {
    const r = refs.get(n);
    if (r) return r;
    if (variants.has(n.name)) return { kind: "variant" as const, enumName: variants.get(n.name)!, variant: n.name };
    if (decls.has(n.name)) return { kind: "decl" as const, decl: decls.get(n.name)! };
    if (["len", "trim", "lower", "upper", "contains", "abs", "min", "max"].includes(n.name)) return { kind: "builtin" as const, name: n.name };
    return undefined;
  };

  const enumOf = (variant: string) => {
    const d = decls.get(variants.get(variant)!) as Extract<Decl, { kind: "EnumDecl" }>;
    return { decl: d, v: d.variants.find((x) => x.name === variant)! };
  };

  const fieldTypes = new Map<string, Map<string, { ty: Ty; preds: Pred[]; decl: Extract<Decl, { kind: "Entity" }>["fields"][number] }>>();
  for (const e of entities) fieldTypes.set(e.name, new Map(e.fields.map((f) => [f.name, { ...c.resolveType(f.type), decl: f }])));

  /** Converts a value to a declared type: integer literals become decimals where needed (A21). */
  const coerce = (v: Value, ty: Ty): Value => {
    if (ty.k === "Decimal" && v.t === "int") return V.dec(BigInt(v.v) * SCALE);
    if (ty.k === "Money" && (v.t === "int" || v.t === "dec")) return V.dec(toCents(toDec(v)), true);
    if (ty.k === "Int" && v.t === "dec") {
      if (v.v % SCALE !== 0n) throw new Fault("type", `${show(v)} is not an integer`);
      const n = v.v / SCALE;
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Fault("overflow", `${show(v)} is outside ±(2^53 - 1)`);
      return V.int(Number(n));
    }
    if (ty.k === "Optional" && v.t !== "none") return coerce(v, ty.inner);
    if (ty.k === "List" && v.t === "list") return { t: "list", items: v.items.map((x) => coerce(x, ty.elem)) };
    if (ty.k === "Id" && v.t === "ref") return { t: "id", entity: v.entity, v: v.id };
    return v;
  };

  const truthy = (v: Value): boolean => {
    if (v.t !== "bool") throw new Fault("type", `expected true or false, got ${show(v)}`);
    return v.v;
  };

  const pure = (): Ctx => ({ view: committed, caller: null, system: false, now: clock() });
  const satisfies = (preds: Pred[], value: Value, ctx: Ctx = pure()) =>
    preds.every((pr) => truthy(evalExpr(pr.expr, new Map(), { ...ctx, it: value })));

  /**
   * Checks every refinement a value must meet, including those nested inside it:
   * list elements, record fields, and the refinements of named types (also when optional).
   * `satisfies` alone sees only the outermost predicates, because nested ones are not part of `Ty`.
   */
  const conforms = (te: TypeExpr, value: Value, ctx: Ctx = pure()): boolean => {
    if (value.t === "none") return true; // whether none is allowed at all is the coercion's job
    const b = te.base;
    if (b.kind === "List" && value.t === "list" && !value.items.every((x) => conforms(b.elem, x, ctx))) return false;
    if (b.kind === "RecordT" && value.t === "record") {
      for (const f of b.fields) {
        const fv = value.fields.find(([n]) => n === f.name);
        if (fv && !conforms(f.type, fv[1], ctx)) return false;
      }
    }
    if (b.kind === "Named" && b.name.parts.length === 1) {
      const d = c.resolution.decls.get(b.name.parts[0]!);
      if (d && d.kind === "TypeDecl" && !conforms(d.type, value, ctx)) return false;
    }
    return satisfies(c.resolveType(te).preds, value, ctx);
  };

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
    const money = (a.t === "dec" && a.money === true) || (b.t === "dec" && b.money === true);
    const x = toDec(a), y = toDec(b);
    let r: bigint;
    switch (op) {
      case "+": r = x + y; break;
      case "-": r = x - y; break;
      case "*": r = divHalfEven(x * y, SCALE); break;
      case "/": r = divHalfEven(x * SCALE, y); break;
      default: throw new Fault("type", `cannot apply ${op} to ${show(a)} and ${show(b)}`);
    }
    return V.dec(money ? toCents(r) : r, money);
  };

  const iterate = (coll: Value, ctx: Ctx): Value[] => {
    if (coll.t === "list") return coll.items;
    if (coll.t === "table") return ctx.view.ids(coll.entity).map((id) => ({ t: "ref", entity: coll.entity, id }) as Value);
    throw new Fault("type", `cannot iterate over ${show(coll)}`);
  };

  const field = (o: Value, name: string, ctx: Ctx): Value => {
    if (o.t === "record") { const f = o.fields.find(([n]) => n === name); if (f) return f[1]; }
    if (o.t === "ref") {
      if (name === "id") return { t: "id", entity: o.entity, v: o.id };
      const rec = ctx.view.get(o.entity, o.id);
      if (!rec) throw new Fault("missing", `${o.entity} ${o.id} no longer exists`);
      const v = rec.get(name);
      if (v) return v;
    }
    if (o.t === "none") throw new Fault("none", `cannot read ${name} of none`);
    throw new Fault("type", `${show(o)} has no field ${name}`);
  };

  const builtin = (name: string, args: Value[]): Value => {
    const [a, b] = args as [Value, Value];
    switch (name) {
      case "len":
        if (a.t === "text") return V.int([...a.v].length);
        if (a.t === "list") return V.int(a.items.length);
        if (a.t === "record") return V.int(a.fields.length);
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
        if (a.t === "dec") return V.dec(a.v < 0n ? -a.v : a.v, a.money === true);
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
      if (!conforms(d.params[i]!.type, v)) throw new Fault("refinement", `argument ${prm.name} = ${show(v)} breaks the refinement of ${name}`);
      env.set(prm.name, v);
    });
    const out = coerce(evalExpr(d.body, env, pure()), sig.ret.ty);
    if (!satisfies(sig.ret.preds, out)) throw new Fault("refinement", `${name} returned ${show(out)}, which breaks its refined return type`);
    return out;
  };

  const evalExpr = (e: Expr, env: Env, ctx: Ctx): Value => {
    const ev = (x: Expr, en: Env = env, cx: Ctx = ctx) => evalExpr(x, en, cx);
    switch (e.kind) {
      case "Literal":
        switch (e.type) {
          case "int": {
            // A literal's type is settled by where it is used, so one too large for Int starts
            // out as an exact decimal instead of faulting (A21).
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
        if (ref?.kind === "decl" && ref.decl.kind === "Entity") return { t: "table", entity: ref.decl.name };
        throw new Fault("internal", `"${e.name}" has no value here`);
      }
      case "Keyword":
        switch (e.name) {
          case "it": if (ctx.it) return ctx.it; break;
          case "result": if (ctx.result) return ctx.result; break;
          case "now": return { t: "time", v: ctx.now };
          case "caller": return ctx.caller ?? V.none;
          case "effects": return { t: "list", items: ctx.effects ?? [] };
          case "accepted": return V.bool(ctx.accepted ?? false);
        }
        throw new Fault("internal", `${e.name} has no value here`);
      case "Old":
        if (!ctx.before) throw new Fault("internal", "old(...) is only meaningful in a test's then clause");
        return ev(e.expr, env, { ...ctx, view: ctx.before });
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
          case "in": return V.bool(iterate(b, ctx).some((x) => equal(a, x)));
          default: return arith(e.op, a, b);
        }
      }
      case "Not": return V.bool(!truthy(ev(e.operand)));
      case "Neg": {
        const v = ev(e.operand);
        if (v.t === "int") return V.int(-v.v);
        if (v.t === "dec") return V.dec(-v.v, v.money === true);
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
        if (ref?.kind === "decl" && ref.decl.kind === "Permission") {
          const pd = ref.decl;
          const penv: Env = new Map(pd.params.map((prm, i) => [prm.name, args[i]!] as [string, Value]));
          return ev(pd.body, penv);
        }
        throw new Fault("internal", `${callee.name} cannot be called here`);
      }
      case "FieldAccess": return field(ev(e.object), e.name, ctx);
      case "Index": {
        const o = ev(e.object), i = ev(e.index);
        if (o.t === "list" && i.t === "int") {
          const item = o.items[i.v];
          if (!item) throw new Fault("index", `index ${i.v} is outside a list of ${o.items.length}`);
          return item;
        }
        if (o.t === "table" && (i.t === "id" || i.t === "ref")) {
          const id = i.t === "id" ? i.v : i.id;
          return ctx.view.get(o.entity, id) ? { t: "ref", entity: o.entity, id } : V.none;
        }
        throw new Fault("type", `cannot index ${show(o)} with ${show(i)}`);
      }
      case "Quant": {
        const items = iterate(ev(e.coll), ctx);
        const test = (x: Value) => truthy(ev(e.body, new Map(env).set(e.binder, x)));
        return V.bool(e.q === "forall" ? items.every(test) : items.some(test));
      }
      case "Count": case "Sum": case "Select": {
        let items = iterate(ev(e.coll), ctx).map((x) => new Map(env).set(e.binder, x));
        if (e.where) items = items.filter((en) => truthy(ev(e.where!, en)));
        if (e.kind === "Count") return V.int(items.length);
        if (e.kind === "Sum") return items.reduce<Value>((acc, en) => arith("+", acc, ev(e.value, en)), V.int(0));
        if (e.orderBy.length) {
          const keyed = items.map((en) => ({ en, keys: e.orderBy.map((o) => ev(o, en)) }));
          keyed.sort((x, y) => { for (let k = 0; k < x.keys.length; k++) { const d = compare(x.keys[k]!, y.keys[k]!); if (d) return d; } return 0; });
          items = keyed.map((k) => k.en);
        }
        return { t: "list", items: items.map((en) => ev(e.value, en)) };
      }
      case "ListLit": return { t: "list", items: e.items.map((x) => ev(x)) };
      case "RecordLit": return { t: "record", fields: e.assigns.map((a) => [a.name, ev(a.value)] as [string, Value]) };
    }
    throw new Fault("internal", `cannot evaluate ${(e as Expr).kind}`);
  };

  // ---------------------------------------------------------------- records

  /** Builds a record from assignments plus field defaults, coerced to the field types. */
  const buildRecord = (entity: string, assigns: [string, Value][], ctx: Ctx, env: Env): Rec => {
    const types = fieldTypes.get(entity)!;
    const rec: Rec = new Map();
    for (const [name, f] of types) {
      const given = assigns.find(([n]) => n === name);
      if (given) rec.set(name, coerce(given[1], f.ty));
      else if (f.decl.default) rec.set(name, coerce(evalExpr(f.decl.default, env, ctx), f.ty));
      else if (f.ty.k === "Optional") rec.set(name, V.none);
      else throw new Fault("missing", `${entity}.${name} has no value and no default`);
    }
    return rec;
  };

  const createRecord = (entity: string, assigns: [string, Value][], env: Env = new Map()): Value => {
    const ctx = pure();
    const rec = buildRecord(entity, assigns, ctx, env);
    const id = `${entity.toLowerCase()}-${store.scan(entity).length + 1}`;
    store.transaction(() => { store.put(entity, id, encodeRec(rec)); return {}; });
    return { t: "ref", entity, id };
  };

  // ---------------------------------------------------------------- invariants

  /** Short-form invariants: "Product.stock >= 0" means "forall x in Product: x.stock >= 0". */
  const desugared = new Map<Decl, Expr>();
  const invariantBody = (inv: Extract<Decl, { kind: "Invariant" }>): Expr => {
    const cached = desugared.get(inv);
    if (cached) return cached;
    let entity: string | null = null;
    const rewrite = (e: Expr): Expr => {
      if (e.kind === "FieldAccess" && e.object.kind === "Name") {
        const r = refOf(e.object);
        if (r?.kind === "decl" && r.decl.kind === "Entity") {
          entity = r.decl.name;
          return { ...e, object: { kind: "Name", name: "__self", span: e.span } };
        }
      }
      const out: Record<string, unknown> = { ...e };
      for (const [k, v] of Object.entries(e)) {
        if (v && typeof v === "object" && "kind" in (v as object) && k !== "span") out[k] = rewrite(v as Expr);
        else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" && "kind" in x ? rewrite(x as Expr) : x));
      }
      return out as Expr;
    };
    const body = inv.body.kind === "Quant" ? inv.body : rewrite(inv.body);
    const result: Expr = entity && body !== inv.body
      ? { kind: "Quant", q: "forall", binder: "__self", coll: { kind: "Name", name: entity, span: inv.span }, body, span: inv.span }
      : inv.body;
    desugared.set(inv, result);
    return result;
  };

  /** Returns the name of the first broken invariant, field refinement or reference, or null. */
  const brokenInvariant = (st: StepState, ctx: Ctx): string | null => {
    for (const inv of invariants) if (!truthy(evalExpr(invariantBody(inv), new Map(), ctx))) return inv.name;
    const deleted = new Set<string>();
    for (const o of st.overlay.values()) {
      if (!o.dirty) continue;
      if (!o.rec) { deleted.add(`${o.entity}\u0000${o.id}`); continue; }
      for (const [name, f] of fieldTypes.get(o.entity)!) {
        const v = o.rec.get(name)!;
        if (f.preds.length && v.t !== "none" && !satisfies(f.preds, v, ctx)) return `${o.entity}.${name} refinement`;
        if (f.ty.k === "Id" && v.t === "id" && fieldTypes.has(f.ty.target) && !ctx.view.get(f.ty.target, v.v)) return `${o.entity}.${name} must refer to an existing ${f.ty.target}`;
      }
    }
    if (deleted.size) {
      for (const e of entities) {
        const idFields = [...fieldTypes.get(e.name)!].filter(([, f]) => f.ty.k === "Id" && fieldTypes.has((f.ty as { target: string }).target));
        if (!idFields.length) continue;
        for (const id of ctx.view.ids(e.name)) {
          const rec = ctx.view.get(e.name, id)!;
          for (const [name, f] of idFields) {
            const v = rec.get(name)!;
            if (v.t === "id" && deleted.has(`${(f.ty as { target: string }).target}\u0000${v.v}`)) return `${e.name}.${name} must refer to an existing ${(f.ty as { target: string }).target}`;
          }
        }
      }
    }
    return null;
  };

  // ---------------------------------------------------------------- clauses

  type Flow = { kind: "next" } | { kind: "return"; value: Value } | { kind: "reject"; name: string };

  const runClauses = (cs: Clause[], env: Env, ctx: Ctx, st: StepState): Flow => {
    for (const cl of cs) {
      const f = runClause(cl, env, ctx, st);
      if (f.kind !== "next") return f;
    }
    return { kind: "next" };
  };

  const runClause = (cl: Clause, env: Env, ctx: Ctx, st: StepState): Flow => {
    const ev = (e: Expr) => evalExpr(e, env, ctx);
    switch (cl.kind) {
      case "Let": env.set(cl.name, ev(cl.value)); return { kind: "next" };
      case "Guard": return truthy(ev(cl.cond)) ? { kind: "next" } : { kind: "reject", name: cl.reject };
      case "SetClause": {
        if (cl.target.length !== 2) throw new NotYet("setting nested fields arrives after milestone 2");
        const target = env.get(cl.target[0]!);
        if (!target || target.t !== "ref") throw new Fault("type", `${cl.target[0]} is not a stored entity${target?.t === "none" ? " (it is none)" : ""}`);
        const rec = ctx.view.get(target.entity, target.id);
        if (!rec) throw new Fault("missing", `${target.entity} ${target.id} no longer exists`);
        const f = fieldTypes.get(target.entity)!.get(cl.target[1]!);
        if (!f) throw new Fault("type", `${target.entity} has no field ${cl.target[1]}`);
        st.write(target.entity, target.id, new Map(rec).set(cl.target[1]!, coerce(ev(cl.value), f.ty)));
        return { kind: "next" };
      }
      case "Create": {
        const assigns = cl.assigns.map((a) => [a.name, ev(a.value)] as [string, Value]);
        const rec = buildRecord(cl.entity, assigns, ctx, env);
        const id = st.newId();
        st.write(cl.entity, id, rec);
        if (cl.as) env.set(cl.as, { t: "ref", entity: cl.entity, id });
        return { kind: "next" };
      }
      case "Delete": {
        const target = ev(cl.target);
        if (target.t !== "ref") throw new Fault("type", `cannot delete ${show(target)}`);
        st.write(target.entity, target.id, null);
        return { kind: "next" };
      }
      case "For": {
        for (const item of iterate(ev(cl.coll), ctx)) {
          const f = runClauses(cl.body, new Map(env).set(cl.binder, item), ctx, st);
          if (f.kind !== "next") return f;
        }
        return { kind: "next" };
      }
      case "IfClause": {
        const branch = truthy(ev(cl.cond)) ? cl.then : cl.else ?? [];
        return runClauses(branch, new Map(env), ctx, st);
      }
      case "Emit": st.effects.push({ cap: `${cl.cap.service}.${cl.cap.op}`, args: cl.args.map(ev) }); return { kind: "next" };
      case "Raise": st.events.push({ event: cl.event, args: cl.args.map(ev) }); return { kind: "next" };
      case "Return": return { kind: "return", value: ev(cl.value) };
    }
  };

  // ---------------------------------------------------------------- calls

  const bindParams = (params: { name: string; type: import("@charter/syntax").TypeExpr }[], args: Value[], ctx: Ctx): Env | Outcome => {
    const env: Env = new Map();
    if (args.length !== params.length) return { kind: "reject", name: "ValidationError", detail: `expected ${params.length} argument(s)` };
    for (let i = 0; i < params.length; i++) {
      const prm = params[i]!;
      const r = c.resolveType(prm.type);
      let v = args[i]!;
      if (r.ty.k === "Entity") {
        const id = v.t === "ref" || v.t === "id" ? (v.t === "ref" ? v.id : v.v) : v.t === "text" ? v.v : null;
        if (id === null || !ctx.view.get(r.ty.name, id)) return { kind: "reject", name: "NotFound", detail: prm.name };
        v = { t: "ref", entity: r.ty.name, id };
      } else {
        try { v = coerce(v, r.ty); } catch { return { kind: "reject", name: "ValidationError", detail: prm.name }; }
        if (!conforms(prm.type, v, ctx)) return { kind: "reject", name: "ValidationError", detail: prm.name };
      }
      env.set(prm.name, v);
    }
    return env;
  };

  const permitted = (permit: Extract<Decl, { kind: "Rule" }>["permit"], env: Env, ctx: Ctx): boolean => {
    if (permit.mode === "system") return ctx.system;
    if (ctx.system) return true; // internal steps (triggers, operators) act for the program itself
    if (permit.mode === "public") return true; // A26: callers who are not signed in, too
    if (principal && !ctx.caller) return false; // anyone means any authenticated caller
    if (permit.mode === "anyone") return true;
    return truthy(evalExpr(permit.expr!, env, ctx));
  };

  const callerValue = (o: CallOptions): Value | null => {
    if (!o.caller || o.caller.t === "none") return null;
    if (!principal || principal.kind !== "Principal") return o.caller;
    const id = o.caller.t === "ref" ? o.caller.id : o.caller.t === "id" ? o.caller.v : o.caller.t === "text" ? o.caller.v : null;
    return id !== null && committed.get(principal.entity, id) ? { t: "ref", entity: principal.entity, id } : null;
  };

  const callQuery = (name: string, args: Value[], o: CallOptions = {}): Outcome => {
    const sig = c.sigs.get(name);
    if (!sig || sig.decl.kind !== "Query") throw new Fault("internal", `${name} is not a query`);
    const q = sig.decl;
    const ctx: Ctx = { view: committed, caller: callerValue(o), system: o.system ?? false, now: o.now ?? clock() };
    try {
      const env = bindParams(q.params, args, ctx);
      if (!(env instanceof Map)) return env;
      if (!permitted(q.permit, env, ctx)) return { kind: "reject", name: "Denied" };
      return { kind: "ok", value: coerce(evalExpr(q.body, env, ctx), sig.ret.ty) };
    } catch (err) {
      if (err instanceof Fault) return { kind: "fault", fault: err.kind, message: err.message };
      throw err;
    }
  };

  const callRule = (name: string, args: Value[], o: CallOptions = {}, label = name, depth = 0): StepResult => {
    const d = decls.get(name);
    if (!d || d.kind !== "Rule") throw new Fault("internal", `${name} is not a rule`);
    if (depth > 50) throw new Fault("internal", "triggers nested more than 50 deep; the trigger graph must be acyclic");
    const n = store.nextStep();
    const seed = o.seed ?? randomBytes(8).toString("hex");
    const now = o.now ?? clock();
    const caller = callerValue(o);
    let result!: StepResult;
    let events: { event: string; args: Value[] }[] = [];

    store.transaction(() => {
      const st = new StepState(committed, n, seed);
      const ctx: Ctx = { view: st.view(), caller, system: o.system ?? false, now, step: st };
      let outcome: Outcome;
      try {
        const env = bindParams(d.params, args, ctx);
        if (!(env instanceof Map)) outcome = env;
        else if (!permitted(d.permit, env, ctx)) outcome = { kind: "reject", name: "Denied" };
        else {
          const flow = runClauses(d.clauses, env, ctx, st);
          if (flow.kind === "reject") outcome = { kind: "reject", name: flow.name };
          else {
            const broken = brokenInvariant(st, ctx);
            outcome = broken ? { kind: "reject", name: "InvariantViolated", detail: broken }
              : { kind: "ok", value: flow.kind === "return" ? flow.value : V.none };
          }
        }
      } catch (err) {
        if (!(err instanceof Fault)) throw err;
        outcome = { kind: "fault", fault: err.kind, message: err.message };
      }
      const ok = outcome.kind === "ok";
      if (ok) {
        for (const ov of st.overlay.values()) {
          if (!ov.dirty) continue;
          if (ov.rec) store.put(ov.entity, ov.id, encodeRec(ov.rec)); else store.delete(ov.entity, ov.id);
        }
        st.effects.forEach((ef, i) => store.queueEffect({ step: n, index: i, cap: ef.cap, args: ef.args.map(encode), status: "pending" }));
        events = st.events;
      }
      store.logStep({
        n, rule: label, caller: caller?.t === "ref" ? caller.id : null, system: o.system ?? false,
        args: args.map((a) => (a.t === "table" ? null : encode(a))), now, seed, outcome: encodeOutcome(outcome),
      });
      const effects = ok ? st.effects.map((ef) => ({ t: "record", fields: [["cap", V.text(ef.cap)], ["args", { t: "list", items: ef.args }]] }) as Value) : [];
      result = { outcome, effects, triggered: [] };
      return {};
    });

    // Triggers run after commit, each as its own step, with a seed derived from this one's.
    events.forEach((ev, k) => {
      for (const tr of triggers) {
        if (tr.event.parts.join(".") !== ev.event) continue;
        const env: Env = new Map(tr.binders.map((b, i) => [b, ev.args[i] ?? V.none] as [string, Value]));
        const targs = tr.args.map((a) => evalExpr(a, env, pure()));
        const childSeed = createHash("sha256").update(`${seed}:${k}:${tr.rule}`).digest("hex").slice(0, 16);
        const child = callRule(tr.rule, targs, { caller: tr.asSystem ? null : caller, system: tr.asSystem, now, seed: childSeed }, `on:${ev.event}->${tr.rule}`, depth + 1);
        result.triggered.push({ rule: tr.rule, outcome: child.outcome }, ...child.triggered);
      }
    });
    return result;
  };

  const replay = () => {
    const fresh = interpreter(p, c, { store: new Store(), now: opts.now ?? 0 });
    const mismatches: string[] = [];
    const log: StepRecord[] = store.steps();
    for (const s of log) {
      if (s.rule.startsWith("on:")) continue; // triggered steps are re-created by their parents
      const args = s.args.map((a) => decode(a));
      const caller: Value | null = s.caller ? { t: "text", v: s.caller } : null;
      const r = fresh.callRule(s.rule, args, { caller, system: s.system, now: s.now, seed: s.seed });
      const got = canonicalJson(encodeOutcome(r.outcome)), want = canonicalJson(s.outcome);
      if (got !== want) mismatches.push(`step ${s.n} ${s.rule}: logged ${want}, replayed ${got}`);
    }
    return { steps: log.length, mismatches, stateHash: store.stateHash(), replayedHash: fresh.store.stateHash() };
  };

  return {
    store,
    callQuery,
    callRule: (name, args, o = {}) => callRule(name, args, o),
    callFn,
    evalClosed: (e, env = new Map(), extra = {}) => evalExpr(e, env, { ...pure(), ...extra }),
    satisfies: (preds, value) => satisfies(preds, value),
    coerce,
    createRecord,
    snapshot: () => {
      const copy = new Store();
      copy.transaction(() => {
        for (const e of entities) for (const r of store.scan(e.name)) copy.put(e.name, r.id, r.rec);
        return {};
      });
      return storeView(copy);
    },
    replay,
  };
}

export function showOutcome(o: Outcome): string {
  switch (o.kind) {
    case "ok": return `Ok  ${show(o.value)}`;
    case "reject": return `Rejected  ${o.name}${o.detail ? `(${o.detail})` : ""}`;
    case "fault": return `Fault  ${o.fault}: ${o.message}`;
  }
}

export { toJson, fromJson } from "./json.ts";
