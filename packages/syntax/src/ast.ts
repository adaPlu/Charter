// Syntax tree for Charter 0.1. One interface per grammar construct. Spans are positions in the
// source and are excluded from hashes (design doc, section 2.9).
import type { Span } from "./lexer.ts";

export type Links = string[];

export interface Program { kind: "Program"; module: QName; version: string; imports: Import[]; decls: Decl[]; span: Span }
export interface QName { kind: "QName"; parts: string[]; span: Span }
export interface Import { kind: "Import"; name: QName; range: string; alias?: string; span: Span }

export type Decl =
  | Requirement | Uses | Principal | TypeDecl | EnumDecl | Entity | FnDecl | ExternFn | Permission
  | Rule | EventDecl | Trigger | Invariant | Assert | Query | TestDecl | PropertyDecl | Migration;

export interface Requirement { kind: "Requirement"; id: string; status: "confirmed" | "inferred" | "open"; text: string; span: Span }
export interface Uses { kind: "Uses"; caps: Capability[]; span: Span }
export interface Capability { service: string; op: string }
export interface Principal { kind: "Principal"; entity: string; by?: string; span: Span }
export interface TypeDecl { kind: "TypeDecl"; name: string; type: TypeExpr; links: Links; span: Span }
export interface EnumDecl { kind: "EnumDecl"; name: string; variants: Variant[]; links: Links; span: Span }
export interface Variant { name: string; fields: Field[]; span: Span }
export interface Entity { kind: "Entity"; name: string; fields: Field[]; links: Links; span: Span }
export interface Field { name: string; type: TypeExpr; default?: Expr; span: Span }
export interface Param { name: string; type: TypeExpr; span: Span }
export interface FnDecl { kind: "FnDecl"; name: string; params: Param[]; ret: TypeExpr; body: Expr; links: Links; span: Span }
export interface ExternFn { kind: "ExternFn"; name: string; params: Param[]; ret: TypeExpr; span: Span }
export interface Permission { kind: "Permission"; name: string; params: Param[]; body: Expr; links: Links; span: Span }
export interface Rule {
  kind: "Rule"; name: string; params: Param[]; ret?: TypeExpr; rejects?: string; links: Links;
  permit: Permit; clauses: Clause[]; span: Span;
}
export interface Permit { mode: "anyone" | "public" | "system" | "expr"; expr?: Expr; links: Links; span: Span }
export interface EventDecl { kind: "EventDecl"; name: string; params: Param[]; span: Span }
export interface Trigger { kind: "Trigger"; event: QName; binders: string[]; rule: string; args: Expr[]; asSystem: boolean; links: Links; span: Span }
export interface Invariant { kind: "Invariant"; name: string; body: Expr; links: Links; span: Span }
export interface Assert { kind: "Assert"; name: string; rule: string; mode: "permitted" | "succeeds"; body: Expr; links: Links; span: Span }
export interface Query { kind: "Query"; name: string; params: Param[]; ret: TypeExpr; permit: Permit; body: Expr; links: Links; span: Span }
export interface TestDecl { kind: "TestDecl"; name: string; givens: Given[]; acts: Act[]; span: Span }
export interface PropertyDecl { kind: "PropertyDecl"; name: string; params: Param[]; where?: Expr; givens: Given[]; acts: Act[]; span: Span }
export interface Given { name: string; entity: string; assigns: Assign[]; span: Span }
export interface Act { call: string; args: Expr[]; as?: Expr; outcome: Outcome; thens: Expr[]; span: Span }
export type Outcome = { kind: "ok" } | { kind: "reject"; name: string } | { kind: "any" };
export interface Migration { kind: "Migration"; from: string; to: string; ops: MigOp[]; span: Span }
export type MigOp =
  | { kind: "add"; entity: string; field: string; type: TypeExpr; value: Expr; span: Span }
  | { kind: "rename"; entity: string; field: string; to: string; span: Span }
  | { kind: "drop"; entity: string; field: string; span: Span };

// ---------- types

export interface TypeExpr { kind: "Type"; base: BaseType; optional: boolean; refinement?: Refinement; span: Span }
export type PrimName = "Bool" | "Int" | "Decimal" | "Money" | "Text" | "Time" | "Duration";
export type BaseType =
  | { kind: "Prim"; name: PrimName }
  | { kind: "Id"; target: QName }
  | { kind: "List"; elem: TypeExpr }
  | { kind: "SetT"; elem: TypeExpr }
  | { kind: "MapT"; key: TypeExpr; value: TypeExpr }
  | { kind: "RecordT"; fields: Field[] }
  | { kind: "Named"; name: QName };
export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in";
export type Refinement =
  | { kind: "ShortRefinement"; op: CmpOp; rhs: Expr }
  | { kind: "ExprRefinement"; expr: Expr };

// ---------- clauses

export type Clause =
  | { kind: "Let"; name: string; value: Expr; links: Links; span: Span }
  | { kind: "Guard"; cond: Expr; reject: string; links: Links; span: Span }
  | { kind: "SetClause"; target: string[]; value: Expr; links: Links; span: Span }
  | { kind: "Create"; entity: string; assigns: Assign[]; as?: string; links: Links; span: Span }
  | { kind: "Delete"; target: Expr; links: Links; span: Span }
  | { kind: "For"; binder: string; coll: Expr; body: Clause[]; links: Links; span: Span }
  | { kind: "IfClause"; cond: Expr; then: Clause[]; else?: Clause[]; links: Links; span: Span }
  | { kind: "Emit"; cap: Capability; args: Expr[]; confirm?: Clause[]; compensate?: Clause[]; links: Links; span: Span }
  | { kind: "Raise"; event: string; args: Expr[]; links: Links; span: Span }
  | { kind: "Return"; value: Expr; links: Links; span: Span };

// ---------- expressions

export type BinOp = "or" | "and" | CmpOp | "??" | "+" | "-" | "*" | "/" | "%";
export interface Assign { name: string; value: Expr }
export type Pattern = { kind: "Wildcard" } | { kind: "VariantPattern"; name: string; binders: string[] | null };
export interface Arm { pattern: Pattern; body: Expr }

export type Expr =
  | { kind: "IfExpr"; cond: Expr; then: Expr; else: Expr; span: Span }
  | { kind: "Match"; subject: Expr; arms: Arm[]; span: Span }
  | { kind: "Binary"; op: BinOp; left: Expr; right: Expr; span: Span }
  | { kind: "Not"; operand: Expr; span: Span }
  | { kind: "Neg"; operand: Expr; span: Span }
  | { kind: "Quant"; q: "forall" | "exists"; binder: string; coll: Expr; body: Expr; span: Span }
  | { kind: "Count"; binder: string; coll: Expr; where?: Expr; span: Span }
  | { kind: "Sum"; value: Expr; binder: string; coll: Expr; where?: Expr; span: Span }
  | { kind: "Select"; value: Expr; binder: string; coll: Expr; where?: Expr; orderBy: Expr[]; span: Span }
  | { kind: "FieldAccess"; object: Expr; name: string; span: Span }
  | { kind: "Call"; callee: Expr; args: Expr[]; span: Span }
  | { kind: "Index"; object: Expr; index: Expr; span: Span }
  | { kind: "Name"; name: string; span: Span }
  | { kind: "Keyword"; name: "caller" | "now" | "it" | "result" | "effects" | "accepted"; span: Span }
  | { kind: "Old"; expr: Expr; span: Span }
  | { kind: "ListLit"; items: Expr[]; span: Span }
  | { kind: "RecordLit"; assigns: Assign[]; span: Span }
  | { kind: "Literal"; type: "int" | "decimal" | "string" | "duration" | "bool" | "none"; value: string; span: Span };

export type ExprKind = Expr["kind"];
