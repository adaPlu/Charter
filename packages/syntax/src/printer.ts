// Canonical printer (design doc, section 2.9): each syntax tree has exactly one text form.
// parse(print(t)) equals t up to source positions. Comments are not part of the tree, so they
// are not printed.
//
// Parentheses: an expression whose last part extends to the right as far as it can (an if
// expression, a quantifier body, a trailing "where", "order by" list) is "open". An open
// expression gets parentheses whenever something other than its own end follows it.
import { quote } from "./lexer.ts";
import type * as A from "./ast.ts";

const INDENT = "  ";

// Precedence levels, lowest first, matching the grammar's expression rules.
const L = { EXPR: 0, OR: 1, AND: 2, NOT: 3, CMP: 4, COAL: 5, ADD: 6, MUL: 7, UNARY: 8, POSTFIX: 9, PRIMARY: 10 };

function level(e: A.Expr): number {
  switch (e.kind) {
    case "IfExpr": case "Match": return L.EXPR;
    case "Binary":
      switch (e.op) {
        case "or": return L.OR;
        case "and": return L.AND;
        case "??": return L.COAL;
        case "+": case "-": return L.ADD;
        case "*": case "/": case "%": return L.MUL;
        default: return L.CMP;
      }
    case "Not": case "Quant": return L.NOT;
    case "Neg": return L.UNARY;
    case "FieldAccess": case "Call": case "Index": return L.POSTFIX;
    default: return L.PRIMARY;
  }
}

/** The subexpression printed last, if the expression ends with an unbounded expression. */
function tail(e: A.Expr): A.Expr | null {
  switch (e.kind) {
    case "IfExpr": return e.else;
    case "Quant": return e.body;
    case "Binary": return e.right;
    case "Not": return e.operand;
    case "Count": case "Sum": return e.where ?? null;
    case "Select": return e.orderBy.length ? e.orderBy[e.orderBy.length - 1]! : e.where ?? null;
    default: return null;
  }
}

/** True if tokens printed after e could be absorbed into e. */
function isOpen(e: A.Expr): boolean {
  switch (e.kind) {
    case "IfExpr": case "Quant": return true;
    case "Count": case "Sum": return e.where !== undefined;
    case "Select": return e.where !== undefined || e.orderBy.length > 0;
    case "Binary": case "Not": return isOpen(tail(e)!);
    default: return false;
  }
}

/** True if a following comma could be absorbed into e (only "order by" lists take commas). */
function absorbsComma(e: A.Expr): boolean {
  if (e.kind === "Select" && e.orderBy.length > 0) return true;
  const t = tail(e);
  return t !== null && absorbsComma(t);
}

/** True if a following "order by" could be absorbed into e. */
function absorbsOrderBy(e: A.Expr): boolean {
  if (e.kind === "Select" && e.orderBy.length === 0) return true;
  const t = tail(e);
  return t !== null && absorbsOrderBy(t);
}

const wrap = (s: string) => `(${s})`;

/** Context of a printed expression: the minimum precedence, and what follows it. */
interface Ctx { min: number; follow: "end" | "token" | "comma" | "orderBy" }

function expr(e: A.Expr, ctx: Ctx): string {
  const text = render(e);
  const needs =
    level(e) < ctx.min ||
    (ctx.follow === "token" && isOpen(e)) ||
    (ctx.follow === "comma" && absorbsComma(e)) ||
    (ctx.follow === "orderBy" && absorbsOrderBy(e));
  return needs ? wrap(text) : text;
}

const top = (e: A.Expr) => expr(e, { min: L.EXPR, follow: "end" });

function list(items: A.Expr[]): string {
  return items.map((it, i) => expr(it, { min: L.EXPR, follow: i < items.length - 1 ? "comma" : "end" })).join(", ");
}

function assigns(as: A.Assign[]): string {
  return as.map((a, i) => `${a.name} = ${expr(a.value, { min: L.EXPR, follow: i < as.length - 1 ? "comma" : "end" })}`).join(", ");
}

function render(e: A.Expr): string {
  switch (e.kind) {
    case "IfExpr":
      return `if ${top(e.cond)} then ${top(e.then)} else ${top(e.else)}`;
    case "Match": {
      const arms = e.arms.map((a, i) =>
        `${INDENT}${pattern(a.pattern)} => ${expr(a.body, { min: L.EXPR, follow: i < e.arms.length - 1 ? "comma" : "end" })}`);
      return `match ${top(e.subject)} {\n${arms.join(",\n")}\n}`;
    }
    case "Binary": {
      const lv = level(e);
      const cmp = lv === L.CMP;
      const left = expr(e.left, { min: cmp ? L.COAL : lv, follow: "token" });
      const right = expr(e.right, { min: lv + 1, follow: "end" });
      return `${left} ${e.op} ${right}`;
    }
    case "Not": return `not ${expr(e.operand, { min: L.NOT, follow: "end" })}`;
    case "Neg": return `-${expr(e.operand, { min: L.POSTFIX, follow: "token" })}`;
    case "Quant": return `${e.q} ${e.binder} in ${expr(e.coll, { min: L.POSTFIX, follow: "token" })}: ${top(e.body)}`;
    case "Count":
      return `count ${e.binder} in ${expr(e.coll, { min: L.POSTFIX, follow: "token" })}` + (e.where ? ` where ${top(e.where)}` : "");
    case "Sum":
      return `sum ${expr(e.value, { min: L.OR, follow: "token" })} for ${e.binder} in ${expr(e.coll, { min: L.POSTFIX, follow: "token" })}` +
        (e.where ? ` where ${top(e.where)}` : "");
    case "Select": {
      let s = `select ${expr(e.value, { min: L.OR, follow: "token" })} for ${e.binder} in ${expr(e.coll, { min: L.POSTFIX, follow: "token" })}`;
      if (e.where) s += ` where ${expr(e.where, { min: L.EXPR, follow: e.orderBy.length ? "orderBy" : "end" })}`;
      if (e.orderBy.length) s += ` order by ${list(e.orderBy)}`;
      return s;
    }
    case "FieldAccess": return `${expr(e.object, { min: L.POSTFIX, follow: "token" })}.${e.name}`;
    case "Call": return `${expr(e.callee, { min: L.POSTFIX, follow: "token" })}(${list(e.args)})`;
    case "Index": return `${expr(e.object, { min: L.POSTFIX, follow: "token" })}[${top(e.index)}]`;
    case "Name": return e.name;
    case "Keyword": return e.name;
    case "Old": return `old(${top(e.expr)})`;
    case "ListLit": return `[${list(e.items)}]`;
    case "RecordLit": return `{ ${assigns(e.assigns)} }`;
    case "Literal": return e.type === "string" ? quote(e.value) : e.value;
  }
}

function pattern(p: A.Pattern): string {
  if (p.kind === "Wildcard") return "_";
  return p.binders ? `${p.name}(${p.binders.join(", ")})` : p.name;
}

// ---------------------------------------------------------------- types

export function printType(t: A.TypeExpr, inGeneric = false): string {
  let s = base(t.base);
  if (t.optional) s += "?";
  if (t.refinement) {
    s += t.refinement.kind === "ShortRefinement"
      ? ` where ${t.refinement.op} ${expr(t.refinement.rhs, { min: L.COAL, follow: "token" })}`
      : ` where ${inGeneric ? wrap(top(t.refinement.expr)) : expr(t.refinement.expr, { min: L.EXPR, follow: "token" })}`;
  }
  return s;
}

function base(b: A.BaseType): string {
  switch (b.kind) {
    case "Prim": return b.name;
    case "Id": return `Id<${b.target.parts.join(".")}>`;
    case "List": return `List<${printType(b.elem, true)}>`;
    case "SetT": return `Set<${printType(b.elem, true)}>`;
    case "MapT": return `Map<${printType(b.key, true)}, ${printType(b.value, true)}>`;
    case "RecordT": return `{ ${fields(b.fields)} }`;
    case "Named": return b.name.parts.join(".");
  }
}

function fields(fs: A.Field[]): string {
  return fs.map((f, i) => {
    let s = `${f.name}: ${printType(f.type)}`;
    if (f.default) s += ` = ${expr(f.default, { min: L.EXPR, follow: i < fs.length - 1 ? "comma" : "end" })}`;
    return s;
  }).join(", ");
}

const params = (ps: A.Param[]) => ps.map((p) => `${p.name}: ${printType(p.type)}`).join(", ");
const links = (ls: A.Links) => (ls.length ? `  req ${ls.join(", ")}` : "");
const indent = (s: string, n = 1) => s.split("\n").map((l) => (l ? INDENT.repeat(n) + l : l)).join("\n");

// ---------------------------------------------------------------- clauses

function block(cs: A.Clause[]): string {
  return `{\n${indent(cs.map(clause).join("\n"))}\n}`;
}

function clause(c: A.Clause): string {
  let s: string;
  switch (c.kind) {
    case "Let": s = `let ${c.name} = ${top(c.value)}`; break;
    case "Guard": s = `guard ${top(c.cond)} else reject ${c.reject}`; break;
    case "SetClause": s = `set ${c.target.join(".")} = ${top(c.value)}`; break;
    case "Create": s = `create ${c.entity} { ${assigns(c.assigns)} }` + (c.as ? ` as ${c.as}` : ""); break;
    case "Delete": s = `delete ${top(c.target)}`; break;
    case "For": s = `for ${c.binder} in ${expr(c.coll, { min: L.POSTFIX, follow: "token" })} ${block(c.body)}`; break;
    case "IfClause": s = `if ${top(c.cond)} ${block(c.then)}` + (c.else ? ` else ${block(c.else)}` : ""); break;
    case "Emit": {
      s = `emit ${c.cap.service}.${c.cap.op}(${list(c.args)})`;
      if (c.confirm) s += `\n${INDENT}confirm ${indent(block(c.confirm)).trimStart()}`;
      if (c.compensate) s += `\n${INDENT}compensate ${indent(block(c.compensate)).trimStart()}`;
      break;
    }
    case "Raise": s = `raise ${c.event}(${list(c.args)})`; break;
    case "Return": s = `return ${top(c.value)}`; break;
  }
  return s + links(c.links);
}

function permit(p: A.Permit): string {
  const body = p.mode === "expr" ? top(p.expr!) : p.mode;
  return `permit ${body}${links(p.links)}`;
}

// ---------------------------------------------------------------- declarations

function acts(as: A.Act[]): string[] {
  return as.map((a) => {
    let s = `when ${a.call}(${list(a.args)})`;
    if (a.as) s += ` as ${top(a.as)}`;
    s += ` expect ${a.outcome.kind === "reject" ? `reject ${a.outcome.name}` : a.outcome.kind}`;
    for (const t of a.thens) s += `\n${INDENT}then ${top(t)}`;
    return s;
  });
}

function givens(gs: A.Given[]): string[] {
  return gs.map((g) => `given ${g.name} = create ${g.entity} { ${assigns(g.assigns)} }`);
}

function decl(d: A.Decl): string {
  switch (d.kind) {
    case "Requirement": return `requirement ${d.id} ${d.status} ${quote(d.text)}`;
    case "Uses": return `uses ${d.caps.map((c) => `${c.service}.${c.op}`).join(", ")}`;
    case "Principal": return `principal ${d.entity}` + (d.by ? ` by ${d.by}` : "");
    case "TypeDecl": return `type ${d.name} = ${printType(d.type)}${links(d.links)}`;
    case "EnumDecl": {
      const vs = d.variants.map((v) => (v.fields.length ? `${v.name}(${fields(v.fields)})` : v.name));
      return `enum ${d.name} { ${vs.join(", ")} }${links(d.links)}`;
    }
    case "Entity": return `entity ${d.name} { ${fields(d.fields)} }${links(d.links)}`;
    case "FnDecl": return `fn ${d.name}(${params(d.params)}): ${printType(d.ret)} =\n${indent(top(d.body))}${links(d.links)}`;
    case "ExternFn": return `extern fn ${d.name}(${params(d.params)}): ${printType(d.ret)}`;
    case "Permission": return `permission ${d.name}(${params(d.params)}) =\n${indent(top(d.body))}${links(d.links)}`;
    case "Rule": {
      let head = `rule ${d.name}(${params(d.params)})`;
      if (d.ret) head += `: ${printType(d.ret)}`;
      if (d.rejects) head += ` rejects ${d.rejects}`;
      head += links(d.links);
      const body = [permit(d.permit), ...d.clauses.map(clause)];
      return `${head}\n${indent(body.join("\n"))}`;
    }
    case "EventDecl": return `event ${d.name}(${params(d.params)})`;
    case "Trigger":
      return `on ${d.event.parts.join(".")}(${d.binders.join(", ")}) do ${d.rule}(${list(d.args)})` +
        (d.asSystem ? " as system" : "") + links(d.links);
    case "Invariant": return `invariant ${d.name}: ${top(d.body)}${links(d.links)}`;
    case "Assert": return `assert ${d.name}: ${d.rule} ${d.mode} implies ${top(d.body)}${links(d.links)}`;
    case "Query": return `query ${d.name}(${params(d.params)}): ${printType(d.ret)} ${permit(d.permit)} =\n${indent(top(d.body))}${links(d.links)}`;
    case "TestDecl": return `test ${quote(d.name)} {\n${indent([...givens(d.givens), ...acts(d.acts)].join("\n"))}\n}`;
    case "PropertyDecl": {
      let head = `property ${quote(d.name)}\n${INDENT}forall ${params(d.params)}`;
      if (d.where) head += ` where ${top(d.where)}`;
      return `${head} {\n${indent([...givens(d.givens), ...acts(d.acts)].join("\n"), 2)}\n${INDENT}}`;
    }
    case "Migration": {
      const ops = d.ops.map((o) =>
        o.kind === "add" ? `add ${o.entity}.${o.field}: ${printType(o.type)} = ${top(o.value)}`
        : o.kind === "rename" ? `rename ${o.entity}.${o.field} to ${o.to}`
        : `drop ${o.entity}.${o.field}`);
      return `migration ${d.from} -> ${d.to} {\n${indent(ops.join("\n"))}\n}`;
    }
  }
}

/** Prints a program in canonical form. Consecutive requirements share a paragraph. */
export function print(p: A.Program): string {
  const out: string[] = [`module ${p.module.parts.join(".")}@${p.version}`];
  if (p.imports.length) out.push(p.imports.map((i) => `import ${i.name.parts.join(".")}@${i.range}` + (i.alias ? ` as ${i.alias}` : "")).join("\n"));
  let prev: A.Decl["kind"] | null = null;
  for (const d of p.decls) {
    const text = decl(d);
    if (d.kind === "Requirement" && prev === "Requirement") out[out.length - 1] += "\n" + text;
    else out.push(text);
    prev = d.kind;
  }
  return out.join("\n\n") + "\n";
}

export { top as printExpr };
