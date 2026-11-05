// @charter/resolve: binds every name to its declaration or local binding, enforces the
// module's flat namespace and the no-shadowing rule (design doc, section 2.6), and builds the
// dependency graph used for transitive hashes.
//
// Milestone 1 scope: dependencies are syntactic references. The behavioral edges of
// amendment A1 (rules depend on invariants over entities they write) arrive in milestone 6.
import { createHash } from "node:crypto";
import { CODES, type Decl, type Diagnostic, type Expr, type Program, type Clause, type TypeExpr, type Span, type Act, type Given } from "@charter/syntax";
import { ownHash, declKey, type Hash } from "@charter/graph";

export const BUILTIN_FUNCTIONS = ["len", "trim", "lower", "upper", "contains", "abs", "min", "max"] as const;
/** Outcomes every rule and query can produce without declaring them (design doc, 2.5 and A7). */
export const BUILTIN_OUTCOMES = ["Denied", "NotFound", "ValidationError", "Conflict", "Disabled", "InvariantViolated"] as const;

export type Ref =
  | { kind: "decl"; decl: Decl }
  | { kind: "variant"; enumName: string; variant: string }
  | { kind: "local"; name: string; binding: string }
  | { kind: "builtin"; name: string }
  | { kind: "import"; alias: string };

export interface Resolution {
  diagnostics: Diagnostic[];
  /** Every top-level name, including enum variants, mapped to its declaration. */
  decls: Map<string, Decl>;
  /** Variant name to its enum's name. */
  variants: Map<string, string>;
  /** What each Name expression refers to. */
  refs: WeakMap<Expr, Ref>;
  /** Declaration key to the keys of the declarations it references. */
  deps: Map<string, Set<string>>;
  imports: Set<string>;
}

const named = (d: Decl): string | null =>
  "name" in d && typeof d.name === "string" && d.kind !== "TestDecl" && d.kind !== "PropertyDecl" ? d.name : null;

export function resolve(p: Program): Resolution {
  const diagnostics: Diagnostic[] = [];
  const decls = new Map<string, Decl>();
  const variants = new Map<string, string>();
  const refs = new WeakMap<Expr, Ref>();
  const deps = new Map<string, Set<string>>();
  const imports = new Set(p.imports.map((i) => i.alias ?? i.name.parts[i.name.parts.length - 1]!));
  const requirements = new Set<string>();
  const err = (code: string, message: string, span: Span) => diagnostics.push({ code, severity: "error", message, span });

  // ---- pass 1: the flat namespace
  const declare = (name: string, d: Decl, span: Span) => {
    if (decls.has(name) || (BUILTIN_FUNCTIONS as readonly string[]).includes(name) || imports.has(name)) {
      err(CODES.DUPLICATE_NAME, `"${name}" is already defined in this module; every top-level name must be unique`, span);
      return;
    }
    decls.set(name, d);
  };
  for (const d of p.decls) {
    if (d.kind === "Requirement") {
      if (requirements.has(d.id)) err(CODES.DUPLICATE_NAME, `requirement ${d.id} is defined twice`, d.span);
      requirements.add(d.id);
      continue;
    }
    const n = named(d);
    if (n) declare(n, d, d.span);
    if (d.kind === "EnumDecl") for (const v of d.variants) { declare(v.name, d, v.span); variants.set(v.name, d.name); }
  }

  // ---- pass 2: references
  let current = "";
  const use = (key: string) => { if (key !== current) deps.get(current)!.add(key); };

  type Scope = Map<string, string>;
  const visible = (scopes: Scope[], name: string) => scopes.some((s) => s.has(name));
  const bind = (scopes: Scope[], name: string, what: string, span: Span) => {
    if (name === "_") return;
    if (visible(scopes, name) || decls.has(name)) {
      err(CODES.SHADOWED_NAME, `"${name}" is already visible here; Charter does not allow shadowing, so pick a new name`, span);
    }
    scopes[scopes.length - 1]!.set(name, what);
  };

  const typeRefs = (t: TypeExpr, scopes: Scope[]) => {
    const b = t.base;
    if (b.kind === "Named" || b.kind === "Id") {
      const q = b.kind === "Named" ? b.name : b.target;
      const head = q.parts[0]!;
      if (q.parts.length > 1 && imports.has(head)) { /* external type, checked when imports exist */ }
      else if (q.parts.length > 1) err(CODES.UNKNOWN_NAME, `unknown module "${head}" in ${q.parts.join(".")}; add an import`, q.span);
      else if (decls.has(head)) use(declKey(decls.get(head)!));
      else err(CODES.UNKNOWN_NAME, `unknown type "${head}"`, q.span);
    }
    if (b.kind === "List" || b.kind === "SetT") typeRefs(b.elem, scopes);
    if (b.kind === "MapT") { typeRefs(b.key, scopes); typeRefs(b.value, scopes); }
    if (b.kind === "RecordT") for (const f of b.fields) { typeRefs(f.type, scopes); if (f.default) expr(f.default, scopes); }
    if (t.refinement) expr(t.refinement.kind === "ShortRefinement" ? t.refinement.rhs : t.refinement.expr, scopes);
  };

  const expr = (e: Expr, scopes: Scope[]): void => {
    switch (e.kind) {
      case "Name": {
        const n = e.name;
        for (let i = scopes.length - 1; i >= 0; i--) {
          const b = scopes[i]!.get(n);
          if (b !== undefined) { refs.set(e, { kind: "local", name: n, binding: b }); return; }
        }
        if (variants.has(n)) { refs.set(e, { kind: "variant", enumName: variants.get(n)!, variant: n }); use(declKey(decls.get(n)!)); return; }
        if (decls.has(n)) { refs.set(e, { kind: "decl", decl: decls.get(n)! }); use(declKey(decls.get(n)!)); return; }
        if ((BUILTIN_FUNCTIONS as readonly string[]).includes(n)) { refs.set(e, { kind: "builtin", name: n }); return; }
        if (imports.has(n)) { refs.set(e, { kind: "import", alias: n }); return; }
        err(CODES.UNKNOWN_NAME, `unknown name "${n}"`, e.span);
        return;
      }
      case "IfExpr": expr(e.cond, scopes); expr(e.then, scopes); expr(e.else, scopes); return;
      case "Match":
        expr(e.subject, scopes);
        for (const a of e.arms) {
          const inner = [...scopes, new Map<string, string>()];
          if (a.pattern.kind === "VariantPattern") {
            if (!variants.has(a.pattern.name)) err(CODES.UNKNOWN_NAME, `unknown variant "${a.pattern.name}"`, e.span);
            for (const b of a.pattern.binders ?? []) bind(inner, b, "pattern", e.span);
          }
          expr(a.body, inner);
        }
        return;
      case "Binary": expr(e.left, scopes); expr(e.right, scopes); return;
      case "Not": case "Neg": expr(e.operand, scopes); return;
      case "Quant": case "Count": case "Sum": case "Select": {
        expr(e.coll, scopes);
        const inner = [...scopes, new Map<string, string>()];
        bind(inner, e.binder, e.kind.toLowerCase(), e.span);
        if (e.kind === "Quant") expr(e.body, inner);
        if (e.kind === "Sum" || e.kind === "Select") expr(e.value, inner);
        if (e.kind !== "Quant" && e.where) expr(e.where, inner);
        if (e.kind === "Select") for (const o of e.orderBy) expr(o, inner);
        return;
      }
      case "FieldAccess": expr(e.object, scopes); return;
      case "Call": expr(e.callee, scopes); e.args.forEach((a) => expr(a, scopes)); return;
      case "Index": expr(e.object, scopes); expr(e.index, scopes); return;
      case "Old": expr(e.expr, scopes); return;
      case "ListLit": e.items.forEach((a) => expr(a, scopes)); return;
      case "RecordLit": e.assigns.forEach((a) => expr(a.value, scopes)); return;
      case "Keyword": case "Literal": return;
    }
  };

  const clauses = (cs: Clause[], scopes: Scope[]): void => {
    for (const c of cs) {
      checkLinks(c.links, c.span);
      switch (c.kind) {
        case "Let": expr(c.value, scopes); bind(scopes, c.name, "let", c.span); break;
        case "Guard": expr(c.cond, scopes); break;
        case "SetClause": {
          const head = c.target[0]!;
          if (!visible(scopes, head)) err(CODES.UNKNOWN_NAME, `unknown name "${head}"`, c.span);
          expr(c.value, scopes);
          break;
        }
        case "Create":
          if (!decls.has(c.entity)) err(CODES.UNKNOWN_NAME, `unknown entity "${c.entity}"`, c.span);
          else use(declKey(decls.get(c.entity)!));
          c.assigns.forEach((a) => expr(a.value, scopes));
          if (c.as) bind(scopes, c.as, "create", c.span);
          break;
        case "Delete": expr(c.target, scopes); break;
        case "For": {
          expr(c.coll, scopes);
          const inner = [...scopes, new Map<string, string>()];
          bind(inner, c.binder, "for", c.span);
          clauses(c.body, inner);
          break;
        }
        case "IfClause":
          expr(c.cond, scopes);
          clauses(c.then, [...scopes, new Map()]);
          if (c.else) clauses(c.else, [...scopes, new Map()]);
          break;
        case "Emit":
          c.args.forEach((a) => expr(a, scopes));
          if (c.confirm) clauses(c.confirm, [...scopes, new Map()]);
          if (c.compensate) clauses(c.compensate, [...scopes, new Map()]);
          break;
        case "Raise":
          if (!decls.has(c.event)) err(CODES.UNKNOWN_NAME, `unknown event "${c.event}"`, c.span);
          else use(declKey(decls.get(c.event)!));
          c.args.forEach((a) => expr(a, scopes));
          break;
        case "Return": expr(c.value, scopes); break;
      }
    }
  };

  const checkLinks = (links: string[], span: Span) => {
    for (const id of links) if (!requirements.has(id)) err(CODES.UNKNOWN_NAME, `${id} is not a requirement in this module`, span);
  };

  const paramScope = (params: { name: string; type: TypeExpr; span: Span }[], scopes: Scope[]) => {
    for (const prm of params) { typeRefs(prm.type, scopes); bind(scopes, prm.name, "param", prm.span); }
  };

  const callTarget = (name: string, span: Span) => {
    const d = decls.get(name);
    if (!d) err(CODES.UNKNOWN_NAME, `unknown rule or query "${name}"`, span);
    else use(declKey(d));
  };

  const testBody = (givens: Given[], acts: Act[], scopes: Scope[]) => {
    for (const g of givens) {
      if (!decls.has(g.entity)) err(CODES.UNKNOWN_NAME, `unknown entity "${g.entity}"`, g.span);
      else use(declKey(decls.get(g.entity)!));
      g.assigns.forEach((a) => expr(a.value, scopes));
      bind(scopes, g.name, "given", g.span);
    }
    for (const a of acts) {
      callTarget(a.call, a.span);
      a.args.forEach((x) => expr(x, scopes));
      if (a.as) expr(a.as, scopes);
      a.thens.forEach((t) => expr(t, scopes));
    }
  };

  for (const d of p.decls) {
    current = declKey(d);
    deps.set(current, new Set());
    const scopes: Scope[] = [new Map()];
    if ("links" in d) checkLinks(d.links, d.span);
    switch (d.kind) {
      case "TypeDecl": typeRefs(d.type, scopes); break;
      case "EnumDecl": for (const v of d.variants) for (const f of v.fields) typeRefs(f.type, scopes); break;
      case "Entity": for (const f of d.fields) { typeRefs(f.type, scopes); if (f.default) expr(f.default, scopes); } break;
      case "FnDecl": paramScope(d.params, scopes); typeRefs(d.ret, scopes); expr(d.body, scopes); break;
      case "ExternFn": paramScope(d.params, scopes); typeRefs(d.ret, scopes); break;
      case "Permission": paramScope(d.params, scopes); expr(d.body, scopes); break;
      case "Rule":
        paramScope(d.params, scopes);
        if (d.ret) typeRefs(d.ret, scopes);
        if (d.rejects) {
          const r = decls.get(d.rejects);
          if (!r || r.kind !== "EnumDecl") err(CODES.UNKNOWN_NAME, `rejects needs an enum, and "${d.rejects}" is not one`, d.span);
          else use(declKey(r));
        }
        checkLinks(d.permit.links, d.permit.span);
        if (d.permit.expr) expr(d.permit.expr, scopes);
        clauses(d.clauses, scopes);
        break;
      case "EventDecl": paramScope(d.params, scopes); break;
      case "Trigger":
        for (const b of d.binders) bind(scopes, b, "trigger", d.span);
        callTarget(d.rule, d.span);
        d.args.forEach((a) => expr(a, scopes));
        if (d.event.parts.length === 1) {
          const ev = decls.get(d.event.parts[0]!);
          if (!ev || ev.kind !== "EventDecl") err(CODES.UNKNOWN_NAME, `unknown event "${d.event.parts[0]}"`, d.span);
          else use(declKey(ev));
        }
        break;
      case "Invariant": expr(d.body, scopes); break;
      case "Assert": {
        const r = decls.get(d.rule);
        if (!r || r.kind !== "Rule") { err(CODES.UNKNOWN_NAME, `assert names "${d.rule}", which is not a rule`, d.span); break; }
        use(declKey(r));
        paramScope(r.params, scopes);
        expr(d.body, scopes);
        break;
      }
      case "Query":
        paramScope(d.params, scopes);
        typeRefs(d.ret, scopes);
        checkLinks(d.permit.links, d.permit.span);
        if (d.permit.expr) expr(d.permit.expr, scopes);
        expr(d.body, scopes);
        break;
      case "TestDecl": testBody(d.givens, d.acts, scopes); break;
      case "PropertyDecl":
        paramScope(d.params, scopes);
        if (d.where) expr(d.where, scopes);
        testBody(d.givens, d.acts, scopes);
        break;
      case "Migration":
        for (const op of d.ops) {
          if (!decls.has(op.entity)) err(CODES.UNKNOWN_NAME, `unknown entity "${op.entity}"`, op.span);
          if (op.kind === "add") { typeRefs(op.type, scopes); expr(op.value, scopes); }
        }
        break;
      case "Principal":
        if (!decls.has(d.entity)) err(CODES.UNKNOWN_NAME, `unknown entity "${d.entity}"`, d.span);
        else use(declKey(decls.get(d.entity)!));
        break;
      case "Requirement": case "Uses": break;
    }
  }
  return { diagnostics, decls, variants, refs, deps, imports };
}

/**
 * Transitive hash of every declaration: its own hash plus the own hashes of everything it can
 * reach through references, so a change anywhere it depends on changes it (design doc, 2.9).
 */
export function transitiveHashes(p: Program, r: Resolution): Map<string, { own: Hash; transitive: Hash }> {
  const own = new Map(p.decls.map((d) => [declKey(d), ownHash(d)]));
  const out = new Map<string, { own: Hash; transitive: Hash }>();
  for (const key of own.keys()) {
    const seen = new Set<string>([key]);
    const stack = [...(r.deps.get(key) ?? [])];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(...(r.deps.get(k) ?? []));
    }
    const parts = [...seen].sort().map((k) => `${k}=${own.get(k)}`).join("\n");
    out.set(key, { own: own.get(key)!, transitive: createHash("sha256").update(parts).digest("hex") });
  }
  return out;
}
