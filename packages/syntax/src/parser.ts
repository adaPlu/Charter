// Recursive-descent parser for Charter 0.1 (spec/charter.ebnf). Every function is named after
// the grammar rule it implements and records that rule in `coverage` when it succeeds, so the
// conformance corpus can show that every production is exercised (design doc, section 8.5).
// Disambiguation follows amendment A18: trailing expressions extend as far right as they can.
import { lex, LexError, RESERVED, unquote, type Span, type Token } from "./lexer.ts";
import type * as A from "./ast.ts";
import type { Diagnostic } from "./diagnostics.ts";

const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">=", "in"]);
const PRIMS = new Set(["Bool", "Int", "Decimal", "Money", "Text", "Time", "Duration"]);
const CLAUSE_START = new Set(["let", "guard", "set", "create", "delete", "for", "if", "emit", "raise", "return"]);

export class ParseError extends Error {
  span: Span;
  constructor(message: string, span: Span) { super(message); this.span = span; }
}

export interface ParseResult { program?: A.Program; diagnostics: Diagnostic[]; coverage: Set<string> }

/** Parses a whole module. Never throws: errors come back as diagnostics. */
export function parse(src: string): ParseResult {
  const coverage = new Set<string>();
  try {
    const p = new Parser(lex(src), coverage);
    const program = p.program();
    return { program, diagnostics: [], coverage };
  } catch (e) {
    if (e instanceof LexError) return { diagnostics: [{ code: "CH0001", severity: "error", message: e.message, span: e.span }], coverage };
    if (e instanceof ParseError) return { diagnostics: [{ code: "CH0002", severity: "error", message: e.message, span: e.span }], coverage };
    throw e;
  }
}

/** Parses a single expression, for example a command-line argument. */
export function parseExpr(src: string): A.Expr {
  const p = new Parser(lex(src), new Set());
  const e = p.expr();
  p.expectEof();
  return e;
}

class Parser {
  private pos = 0;
  private toks: Token[];
  private coverage: Set<string>;
  constructor(toks: Token[], coverage: Set<string>) { this.toks = toks; this.coverage = coverage; }

  // ---------------------------------------------------------------- helpers

  private peek(k = 0): Token { return this.toks[Math.min(this.pos + k, this.toks.length - 1)]!; }
  private span(): Span { return this.peek().span; }
  private at(text: string, k = 0): boolean {
    const t = this.peek(k);
    return (t.kind === "word" || t.kind === "symbol") && t.text === text;
  }
  private eat(text: string): boolean { if (this.at(text)) { this.pos++; return true; } return false; }
  private fail(expected: string): never {
    const t = this.peek();
    const found = t.kind === "eof" ? "end of input" : `"${t.text}"`;
    let msg = `expected ${expected}, found ${found}`;
    if (t.kind === "symbol" && CMP_OPS.has(t.text)) msg += ". Comparisons do not chain; add parentheses";
    if (t.kind === "word" && RESERVED.has(t.text) && expected === "a name") msg += ` ("${t.text}" is a reserved word)`;
    throw new ParseError(msg, t.span);
  }
  private expect(text: string): void { if (!this.eat(text)) this.fail(`"${text}"`); }
  private take(kind: Token["kind"], what: string): Token {
    const t = this.peek();
    if (t.kind !== kind) this.fail(what);
    this.pos++;
    return t;
  }
  private cover<T>(rule: string, value: T): T { this.coverage.add(rule); return value; }
  expectEof(): void { if (this.peek().kind !== "eof") this.fail("end of input"); }

  ident(): string {
    const t = this.peek();
    if (t.kind !== "word" || RESERVED.has(t.text)) this.fail("a name");
    this.pos++;
    return t.text;
  }
  private isIdent(k = 0): boolean { const t = this.peek(k); return t.kind === "word" && !RESERVED.has(t.text); }

  qname(): A.QName {
    const span = this.span();
    const parts = [this.ident()];
    while (this.at(".") && this.isIdent(1)) { this.pos++; parts.push(this.ident()); }
    return this.cover("qname", { kind: "QName", parts, span });
  }

  private commaList<T>(item: () => T): T[] {
    const out = [item()];
    while (this.eat(",")) out.push(item());
    return out;
  }

  // ---------------------------------------------------------------- program

  program(): A.Program {
    const span = this.span();
    this.expect("module");
    const name = this.qname();
    this.expect("@");
    const version = this.take("version", "a version such as 0.1.0").text;
    this.cover("module_decl", null);
    const imports: A.Import[] = [];
    while (this.at("import")) imports.push(this.import());
    const decls: A.Decl[] = [];
    while (this.peek().kind !== "eof") decls.push(this.decl());
    return this.cover("program", { kind: "Program", module: name, version, imports, decls, span });
  }

  private import(): A.Import {
    const span = this.span();
    this.expect("import");
    const name = this.qname();
    this.expect("@");
    const range = this.verspec();
    const imp: A.Import = { kind: "Import", name, range, span };
    if (this.eat("as")) imp.alias = this.ident();
    return this.cover("import", imp);
  }

  private verspec(): string {
    let prefix = "";
    if (this.at("^") || this.at("~")) { prefix = this.peek().text; this.pos++; }
    const t = this.peek();
    if (t.kind !== "version" && t.kind !== "decimal" && t.kind !== "int") this.fail("a version range such as ^1.0");
    this.pos++;
    return this.cover("verspec", prefix + t.text);
  }

  private decl(): A.Decl {
    const t = this.peek();
    let d: A.Decl;
    switch (t.kind === "word" ? t.text : "") {
      case "requirement": d = this.requirement(); break;
      case "uses": d = this.uses(); break;
      case "principal": d = this.principal(); break;
      case "type": d = this.typeDecl(); break;
      case "enum": d = this.enumDecl(); break;
      case "entity": d = this.entity(); break;
      case "fn": d = this.fnDecl(); break;
      case "extern": d = this.externFn(); break;
      case "permission": d = this.permission(); break;
      case "rule": d = this.rule(); break;
      case "event": d = this.event(); break;
      case "on": d = this.trigger(); break;
      case "invariant": d = this.invariant(); break;
      case "assert": d = this.assert(); break;
      case "query": d = this.query(); break;
      case "test": d = this.test(); break;
      case "property": d = this.property(); break;
      case "migration": d = this.migration(); break;
      default: this.fail("a declaration (requirement, type, enum, entity, fn, rule, query, test, ...)");
    }
    return this.cover("decl", d);
  }

  private links(): A.Links {
    if (!this.eat("req")) return [];
    const ids = this.commaList(() => this.take("req_id", "a requirement id such as R-1").text);
    return this.cover("links", ids);
  }

  private requirement(): A.Requirement {
    const span = this.span();
    this.expect("requirement");
    const id = this.take("req_id", "a requirement id such as R-1").text;
    const st = this.peek().text;
    if (st !== "confirmed" && st !== "inferred" && st !== "open") this.fail('"confirmed", "inferred" or "open"');
    this.pos++;
    this.cover("status", null);
    const text = unquote(this.take("string", "a quoted requirement text").text);
    return this.cover("requirement", { kind: "Requirement", id, status: st, text, span });
  }

  private capability(): A.Capability {
    const service = this.ident();
    this.expect(".");
    const op = this.ident();
    return this.cover("capability", { service, op });
  }

  private uses(): A.Uses {
    const span = this.span();
    this.expect("uses");
    return this.cover("uses", { kind: "Uses", caps: this.commaList(() => this.capability()), span });
  }

  private principal(): A.Principal {
    const span = this.span();
    this.expect("principal");
    const p: A.Principal = { kind: "Principal", entity: this.ident(), span };
    if (this.eat("by")) p.by = this.ident();
    return this.cover("principal", p);
  }

  private typeDecl(): A.TypeDecl {
    const span = this.span();
    this.expect("type");
    const name = this.ident();
    this.expect("=");
    const type = this.type();
    return this.cover("type_decl", { kind: "TypeDecl", name, type, links: this.links(), span });
  }

  private enumDecl(): A.EnumDecl {
    const span = this.span();
    this.expect("enum");
    const name = this.ident();
    this.expect("{");
    const variants = this.commaList(() => this.variant());
    this.expect("}");
    return this.cover("enum_decl", { kind: "EnumDecl", name, variants, links: this.links(), span });
  }

  private variant(): A.Variant {
    const span = this.span();
    const name = this.ident();
    let fields: A.Field[] = [];
    if (this.eat("(")) { fields = this.fieldList(); this.expect(")"); }
    return this.cover("variant", { name, fields, span });
  }

  private entity(): A.Entity {
    const span = this.span();
    this.expect("entity");
    const name = this.ident();
    this.expect("{");
    const fields = this.fieldList();
    this.expect("}");
    return this.cover("entity", { kind: "Entity", name, fields, links: this.links(), span });
  }

  private fieldList(): A.Field[] { return this.cover("field_list", this.commaList(() => this.field())); }

  private field(): A.Field {
    const span = this.span();
    const name = this.ident();
    this.expect(":");
    const f: A.Field = { name, type: this.type(), span };
    if (this.eat("=")) f.default = this.expr();
    return this.cover("field", f);
  }

  private params(): A.Param[] { return this.cover("params", this.commaList(() => this.param())); }
  private param(): A.Param {
    const span = this.span();
    const name = this.ident();
    this.expect(":");
    return this.cover("param", { name, type: this.type(), span });
  }
  private paramList(): A.Param[] {
    this.expect("(");
    const ps = this.at(")") ? [] : this.params();
    this.expect(")");
    return ps;
  }

  // ---------------------------------------------------------------- types

  type(): A.TypeExpr {
    const span = this.span();
    const base = this.base();
    const optional = this.eat("?");
    const t: A.TypeExpr = { kind: "Type", base, optional, span };
    if (this.eat("where")) t.refinement = this.refinement();
    return this.cover("type", t);
  }

  private base(): A.BaseType {
    const t = this.peek();
    let b: A.BaseType;
    if (t.kind === "word" && PRIMS.has(t.text)) { this.pos++; b = { kind: "Prim", name: t.text as A.PrimName }; }
    else if (this.eat("Id")) { this.expect("<"); b = { kind: "Id", target: this.qname() }; this.expect(">"); }
    else if (this.eat("List")) { this.expect("<"); b = { kind: "List", elem: this.type() }; this.expect(">"); }
    else if (this.eat("Set")) { this.expect("<"); b = { kind: "SetT", elem: this.type() }; this.expect(">"); }
    else if (this.eat("Map")) {
      this.expect("<"); const key = this.type(); this.expect(","); const value = this.type(); this.expect(">");
      b = { kind: "MapT", key, value };
    }
    else if (this.eat("{")) { b = { kind: "RecordT", fields: this.fieldList() }; this.expect("}"); }
    else if (this.isIdent()) b = { kind: "Named", name: this.qname() };
    else this.fail("a type");
    return this.cover("base", b);
  }

  private refinement(): A.Refinement {
    const t = this.peek();
    if (t.kind === "symbol" && CMP_OPS.has(t.text) || this.at("in")) {
      this.pos++;
      this.cover("cmp_op", null);
      return this.cover("refinement", { kind: "ShortRefinement", op: t.text as A.CmpOp, rhs: this.coalesce() });
    }
    return this.cover("refinement", { kind: "ExprRefinement", expr: this.expr() });
  }

  // ---------------------------------------------------------------- functions, permissions, rules

  private fnDecl(): A.FnDecl {
    const span = this.span();
    this.expect("fn");
    const name = this.ident();
    const params = this.paramList();
    this.expect(":");
    const ret = this.type();
    this.expect("=");
    const body = this.expr();
    return this.cover("fn_decl", { kind: "FnDecl", name, params, ret, body, links: this.links(), span });
  }

  private externFn(): A.ExternFn {
    const span = this.span();
    this.expect("extern"); this.expect("fn");
    const name = this.ident();
    const params = this.paramList();
    this.expect(":");
    return this.cover("extern_fn", { kind: "ExternFn", name, params, ret: this.type(), span });
  }

  private permission(): A.Permission {
    const span = this.span();
    this.expect("permission");
    const name = this.ident();
    const params = this.paramList();
    this.expect("=");
    const body = this.expr();
    return this.cover("permission", { kind: "Permission", name, params, body, links: this.links(), span });
  }

  private rule(): A.Rule {
    const span = this.span();
    this.expect("rule");
    const name = this.ident();
    const params = this.paramList();
    const r: Partial<A.Rule> = { kind: "Rule", name, params, span };
    if (this.eat(":")) r.ret = this.type();
    if (this.eat("rejects")) r.rejects = this.ident();
    r.links = this.links();
    r.permit = this.permit();
    r.clauses = this.clauses();
    return this.cover("rule", r as A.Rule);
  }

  private permit(): A.Permit {
    const span = this.span();
    this.expect("permit");
    let p: A.Permit;
    if (this.eat("anyone")) p = { mode: "anyone", links: [], span };
    else if (this.eat("system")) p = { mode: "system", links: [], span };
    else p = { mode: "expr", expr: this.expr(), links: [], span };
    p.links = this.links();
    return this.cover("permit", p);
  }

  private clauses(): A.Clause[] {
    const out: A.Clause[] = [];
    while (this.peek().kind === "word" && CLAUSE_START.has(this.peek().text)) out.push(this.clause());
    return out;
  }

  private block(): A.Clause[] {
    this.expect("{");
    const cs = this.clauses();
    this.expect("}");
    return cs;
  }

  private clause(): A.Clause {
    const span = this.span();
    const kw = this.peek().text;
    this.pos++;
    let c: A.Clause;
    switch (kw) {
      case "let": {
        const name = this.ident(); this.expect("=");
        c = this.cover("let_clause", { kind: "Let", name, value: this.expr(), links: [], span });
        break;
      }
      case "guard": {
        const cond = this.expr(); this.expect("else"); this.expect("reject");
        c = this.cover("guard_clause", { kind: "Guard", cond, reject: this.ident(), links: [], span });
        break;
      }
      case "set": {
        const target = [this.ident()];
        this.expect(".");
        target.push(this.ident());
        while (this.eat(".")) target.push(this.ident());
        this.cover("lvalue", null);
        this.expect("=");
        c = this.cover("set_clause", { kind: "SetClause", target, value: this.expr(), links: [], span });
        break;
      }
      case "create": {
        const entity = this.ident(); this.expect("{");
        const assigns = this.at("}") ? [] : this.assigns();
        this.expect("}");
        const cr: A.Clause = { kind: "Create", entity, assigns, links: [], span };
        if (this.eat("as")) cr.as = this.ident();
        c = this.cover("create_clause", cr);
        break;
      }
      case "delete": c = this.cover("delete_clause", { kind: "Delete", target: this.expr(), links: [], span }); break;
      case "for": {
        const binder = this.ident(); this.expect("in");
        const coll = this.postfix();
        c = this.cover("for_clause", { kind: "For", binder, coll, body: this.block(), links: [], span });
        break;
      }
      case "if": {
        const cond = this.expr();
        const then = this.block();
        const ic: A.Clause = { kind: "IfClause", cond, then, links: [], span };
        if (this.eat("else")) ic.else = this.block();
        c = this.cover("if_clause", ic);
        break;
      }
      case "emit": {
        const cap = this.capability();
        const args = this.argList();
        const em: A.Clause = { kind: "Emit", cap, args, links: [], span };
        if (this.eat("confirm")) em.confirm = this.block();
        if (this.eat("compensate")) em.compensate = this.block();
        c = this.cover("emit_clause", em);
        break;
      }
      case "raise": {
        const event = this.ident();
        c = this.cover("raise_clause", { kind: "Raise", event, args: this.argList(), links: [], span });
        break;
      }
      case "return": c = this.cover("return_clause", { kind: "Return", value: this.expr(), links: [], span }); break;
      default: this.fail("a clause");
    }
    c.links = this.links();
    return this.cover("clause", c);
  }

  // ---------------------------------------------------------------- other declarations

  private event(): A.EventDecl {
    const span = this.span();
    this.expect("event");
    const name = this.ident();
    return this.cover("event", { kind: "EventDecl", name, params: this.paramList(), span });
  }

  private trigger(): A.Trigger {
    const span = this.span();
    this.expect("on");
    const event = this.qname();
    this.expect("(");
    const binders = this.at(")") ? [] : this.commaList(() => this.ident());
    this.expect(")");
    this.expect("do");
    const rule = this.ident();
    const args = this.argList();
    let asSystem = false;
    if (this.eat("as")) { this.expect("system"); asSystem = true; }
    return this.cover("trigger", { kind: "Trigger", event, binders, rule, args, asSystem, links: this.links(), span });
  }

  private invariant(): A.Invariant {
    const span = this.span();
    this.expect("invariant");
    const name = this.ident();
    this.expect(":");
    const body = this.expr();
    return this.cover("invariant", { kind: "Invariant", name, body, links: this.links(), span });
  }

  private assert(): A.Assert {
    const span = this.span();
    this.expect("assert");
    const name = this.ident();
    this.expect(":");
    const rule = this.ident();
    const mode = this.peek().text;
    if (mode !== "permitted" && mode !== "succeeds") this.fail('"permitted" or "succeeds"');
    this.pos++;
    this.expect("implies");
    const body = this.expr();
    return this.cover("assert", { kind: "Assert", name, rule, mode, body, links: this.links(), span });
  }

  private query(): A.Query {
    const span = this.span();
    this.expect("query");
    const name = this.ident();
    const params = this.paramList();
    this.expect(":");
    const ret = this.type();
    const permit = this.permit();
    this.expect("=");
    const body = this.expr();
    return this.cover("query", { kind: "Query", name, params, ret, permit, body, links: this.links(), span });
  }

  private test(): A.TestDecl {
    const span = this.span();
    this.expect("test");
    const name = unquote(this.take("string", "a quoted test name").text);
    this.expect("{");
    const { givens, acts } = this.testBody();
    return this.cover("test", { kind: "TestDecl", name, givens, acts, span });
  }

  private property(): A.PropertyDecl {
    const span = this.span();
    this.expect("property");
    const name = unquote(this.take("string", "a quoted property name").text);
    this.expect("forall");
    const params = this.params();
    const p: Partial<A.PropertyDecl> = { kind: "PropertyDecl", name, params, span };
    if (this.eat("where")) p.where = this.expr();
    this.expect("{");
    const { givens, acts } = this.testBody();
    return this.cover("property", { ...p, givens, acts } as A.PropertyDecl);
  }

  private testBody(): { givens: A.Given[]; acts: A.Act[] } {
    const givens: A.Given[] = [];
    while (this.at("given")) givens.push(this.given());
    const acts = [this.act()];
    while (this.at("when")) acts.push(this.act());
    this.expect("}");
    return { givens, acts };
  }

  private given(): A.Given {
    const span = this.span();
    this.expect("given");
    const name = this.ident();
    this.expect("="); this.expect("create");
    const entity = this.ident();
    this.expect("{");
    const assigns = this.at("}") ? [] : this.assigns();
    this.expect("}");
    return this.cover("given", { name, entity, assigns, span });
  }

  private act(): A.Act {
    const span = this.span();
    this.expect("when");
    const call = this.ident();
    const args = this.argList();
    const act: Partial<A.Act> = { call, args, span };
    if (this.eat("as")) act.as = this.expr();
    this.expect("expect");
    let outcome: A.Outcome;
    if (this.eat("ok")) outcome = { kind: "ok" };
    else if (this.eat("any")) outcome = { kind: "any" };
    else if (this.eat("reject")) outcome = { kind: "reject", name: this.ident() };
    else this.fail('"ok", "any" or "reject <name>"');
    this.cover("outcome", null);
    const thens: A.Expr[] = [];
    while (this.eat("then")) thens.push(this.expr());
    return this.cover("act", { ...act, outcome, thens } as A.Act);
  }

  private migration(): A.Migration {
    const span = this.span();
    this.expect("migration");
    const from = this.take("version", "a version").text;
    this.expect("->");
    const to = this.take("version", "a version").text;
    this.expect("{");
    const ops: A.MigOp[] = [];
    while (!this.at("}")) ops.push(this.migOp());
    this.expect("}");
    return this.cover("migration", { kind: "Migration", from, to, ops, span });
  }

  private migOp(): A.MigOp {
    const span = this.span();
    let op: A.MigOp;
    if (this.eat("add")) {
      const entity = this.ident(); this.expect("."); const field = this.ident(); this.expect(":");
      const type = this.type(); this.expect("=");
      op = { kind: "add", entity, field, type, value: this.expr(), span };
    } else if (this.eat("rename")) {
      const entity = this.ident(); this.expect("."); const field = this.ident(); this.expect("to");
      op = { kind: "rename", entity, field, to: this.ident(), span };
    } else if (this.eat("drop")) {
      const entity = this.ident(); this.expect(".");
      op = { kind: "drop", entity, field: this.ident(), span };
    } else this.fail('"add", "rename" or "drop"');
    return this.cover("mig_op", op);
  }

  // ---------------------------------------------------------------- expressions

  expr(): A.Expr {
    let e: A.Expr;
    if (this.at("if")) e = this.ifExpr();
    else if (this.at("match")) e = this.matchExpr();
    else e = this.orExpr();
    return this.cover("expr", e);
  }

  private ifExpr(): A.Expr {
    const span = this.span();
    this.expect("if");
    const cond = this.expr(); this.expect("then");
    const then = this.expr(); this.expect("else");
    return this.cover("if_expr", { kind: "IfExpr", cond, then, else: this.expr(), span });
  }

  private matchExpr(): A.Expr {
    const span = this.span();
    this.expect("match");
    const subject = this.expr();
    this.expect("{");
    const arms = this.commaList(() => this.arm());
    this.expect("}");
    return this.cover("match_expr", { kind: "Match", subject, arms, span });
  }

  private arm(): A.Arm {
    const pattern = this.pattern();
    this.expect("=>");
    return this.cover("arm", { pattern, body: this.expr() });
  }

  private pattern(): A.Pattern {
    if (this.eat("_")) return this.cover("pattern", { kind: "Wildcard" });
    const name = this.ident();
    let binders: string[] | null = null;
    if (this.eat("(")) {
      binders = this.commaList(() => (this.eat("_") ? "_" : this.ident()));
      this.cover("binder", null);
      this.expect(")");
    }
    return this.cover("pattern", { kind: "VariantPattern", name, binders });
  }

  private binaryChain(next: () => A.Expr, ops: string[], rule: string): A.Expr {
    let left = next();
    for (;;) {
      const t = this.peek();
      if (!((t.kind === "symbol" || t.kind === "word") && ops.includes(t.text))) break;
      this.pos++;
      const right = next();
      left = { kind: "Binary", op: t.text as A.BinOp, left, right, span: t.span };
    }
    return this.cover(rule, left);
  }

  private orExpr(): A.Expr { return this.binaryChain(() => this.andExpr(), ["or"], "or_expr"); }
  private andExpr(): A.Expr { return this.binaryChain(() => this.notExpr(), ["and"], "and_expr"); }

  private notExpr(): A.Expr {
    const span = this.span();
    let e: A.Expr;
    if (this.eat("not")) e = { kind: "Not", operand: this.notExpr(), span };
    else if (this.at("forall") || this.at("exists")) e = this.quantExpr();
    else e = this.cmpExpr();
    return this.cover("not_expr", e);
  }

  private quantExpr(): A.Expr {
    const span = this.span();
    const q = this.peek().text as "forall" | "exists";
    this.pos++;
    const binder = this.ident();
    this.expect("in");
    const coll = this.postfix();
    this.expect(":");
    return this.cover("quant_expr", { kind: "Quant", q, binder, coll, body: this.expr(), span });
  }

  private cmpExpr(): A.Expr {
    const left = this.coalesce();
    const t = this.peek();
    if ((t.kind === "symbol" || t.kind === "word") && CMP_OPS.has(t.text)) {
      this.pos++;
      this.cover("cmp_op", null);
      const right = this.coalesce();
      return this.cover("cmp_expr", { kind: "Binary", op: t.text as A.CmpOp, left, right, span: t.span });
    }
    return this.cover("cmp_expr", left);
  }

  coalesce(): A.Expr { return this.binaryChain(() => this.addExpr(), ["??"], "coalesce"); }
  private addExpr(): A.Expr { return this.binaryChain(() => this.mulExpr(), ["+", "-"], "add_expr"); }
  private mulExpr(): A.Expr { return this.binaryChain(() => this.unary(), ["*", "/", "%"], "mul_expr"); }

  private unary(): A.Expr {
    const span = this.span();
    if (this.eat("-")) return this.cover("unary", { kind: "Neg", operand: this.postfix(), span });
    return this.cover("unary", this.postfix());
  }

  postfix(): A.Expr {
    let e = this.primary();
    for (;;) {
      const span = this.span();
      if (this.at(".") && this.isIdent(1)) { this.pos++; e = { kind: "FieldAccess", object: e, name: this.ident(), span }; }
      else if (this.at("(")) e = { kind: "Call", callee: e, args: this.argList(), span };
      else if (this.eat("[")) { const index = this.expr(); this.expect("]"); e = { kind: "Index", object: e, index, span }; }
      else break;
    }
    return this.cover("postfix", e);
  }

  private argList(): A.Expr[] {
    this.expect("(");
    const args = this.at(")") ? [] : this.args();
    this.expect(")");
    return args;
  }
  private args(): A.Expr[] { return this.cover("args", this.commaList(() => this.expr())); }
  private assigns(): A.Assign[] {
    return this.cover("assigns", this.commaList(() => {
      const name = this.ident(); this.expect("=");
      return { name, value: this.expr() };
    }));
  }

  private primary(): A.Expr {
    const t = this.peek();
    const span = t.span;
    const lit = (type: Extract<A.Expr, { kind: "Literal" }>["type"], value: string): A.Expr => {
      this.pos++;
      this.cover("literal", null);
      return { kind: "Literal", type, value, span };
    };
    let e: A.Expr;
    switch (t.kind) {
      case "int": e = lit("int", t.text); break;
      case "decimal": e = lit("decimal", t.text); break;
      case "string": e = lit("string", unquote(t.text)); break;
      case "duration": e = lit("duration", t.text); break;
      case "word":
        if (t.text === "true" || t.text === "false") { e = lit("bool", t.text); break; }
        if (t.text === "none") { e = lit("none", "none"); break; }
        if (["caller", "now", "it", "result", "effects"].includes(t.text)) {
          this.pos++;
          e = { kind: "Keyword", name: t.text as "caller", span };
          break;
        }
        if (t.text === "old") { this.pos++; this.expect("("); const inner = this.expr(); this.expect(")"); e = { kind: "Old", expr: inner, span }; break; }
        if (t.text === "count" || t.text === "sum" || t.text === "select") { e = this.aggregate(); break; }
        e = { kind: "Name", name: this.ident(), span };
        break;
      case "symbol":
        if (t.text === "(") { this.pos++; e = this.expr(); this.expect(")"); break; }
        if (t.text === "[") { this.pos++; const items = this.at("]") ? [] : this.args(); this.expect("]"); e = { kind: "ListLit", items, span }; break; }
        if (t.text === "{") { this.pos++; const assigns = this.assigns(); this.expect("}"); e = { kind: "RecordLit", assigns, span }; break; }
        this.fail("an expression");
      default: this.fail("an expression");
    }
    return this.cover("primary", e);
  }

  private aggregate(): A.Expr {
    const span = this.span();
    const kw = this.peek().text;
    this.pos++;
    let e: A.Expr;
    if (kw === "count") {
      const binder = this.ident(); this.expect("in");
      const coll = this.postfix();
      const c: Extract<A.Expr, { kind: "Count" }> = { kind: "Count", binder, coll, span };
      if (this.eat("where")) c.where = this.expr();
      e = c;
    } else {
      const value = this.orExpr();
      this.expect("for");
      const binder = this.ident(); this.expect("in");
      const coll = this.postfix();
      const where = this.eat("where") ? this.expr() : undefined;
      if (kw === "sum") {
        const s: Extract<A.Expr, { kind: "Sum" }> = { kind: "Sum", value, binder, coll, span };
        if (where) s.where = where;
        e = s;
      } else {
        const orderBy: A.Expr[] = [];
        if (this.eat("order")) { this.expect("by"); orderBy.push(...this.commaList(() => this.expr())); }
        const s: Extract<A.Expr, { kind: "Select" }> = { kind: "Select", value, binder, coll, orderBy, span };
        if (where) s.where = where;
        e = s;
      }
    }
    return this.cover("aggregate", e);
  }
}
