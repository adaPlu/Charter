// Types, refinement predicates and the small logic that proof obligations are written in.
import type { Expr, Span } from "@charter/syntax";

export type Ty =
  | { k: "Int" } | { k: "Decimal" } | { k: "Money" } | { k: "Bool" } | { k: "Text" } | { k: "Time" } | { k: "Duration" }
  | { k: "NumLit"; decimal: boolean }          // a numeric literal not yet fixed to Int, Decimal or Money
  | { k: "None" }                              // the literal none
  | { k: "Enum"; name: string }
  | { k: "Record"; fields: [string, Ty][] }
  | { k: "List"; elem: Ty } | { k: "Set"; elem: Ty } | { k: "Map"; key: Ty; value: Ty }
  | { k: "Optional"; inner: Ty }
  | { k: "Id"; target: string }
  | { k: "Entity"; name: string }
  | { k: "Unknown" };                          // not checked yet, or after an error (stops cascades)

export const T = {
  Int: { k: "Int" } as Ty, Decimal: { k: "Decimal" } as Ty, Money: { k: "Money" } as Ty, Bool: { k: "Bool" } as Ty,
  Text: { k: "Text" } as Ty, Time: { k: "Time" } as Ty, Duration: { k: "Duration" } as Ty, Unknown: { k: "Unknown" } as Ty,
  None: { k: "None" } as Ty,
};

/** A refinement predicate: an expression over `it`, written in the scope where it appeared. */
export interface Pred { expr: Expr; source: string }
export interface Refined { ty: Ty; preds: Pred[] }

export const isNumeric = (t: Ty) => t.k === "Int" || t.k === "Decimal" || t.k === "Money" || t.k === "NumLit";

export function show(t: Ty): string {
  switch (t.k) {
    case "NumLit": return t.decimal ? "Decimal" : "Int";
    case "None": return "none";
    case "Enum": case "Entity": return t.name;
    case "Record": return t.fields.length ? `{ ${t.fields.map(([n, f]) => `${n}: ${show(f)}`).join(", ")} }` : "{}";
    case "List": return `List<${show(t.elem)}>`;
    case "Set": return `Set<${show(t.elem)}>`;
    case "Map": return `Map<${show(t.key)}, ${show(t.value)}>`;
    case "Optional": return `${show(t.inner)}?`;
    case "Id": return `Id<${t.target}>`;
    default: return t.k;
  }
}

export function same(a: Ty, b: Ty): boolean { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------- the obligation logic

export type Sort = "Int" | "Real" | "Bool";

/**
 * Terms of the logic. Numbers are exact decimal strings. An "opaque" term stands for a
 * subexpression the logic cannot describe (a text length, an enum comparison, ...): the same
 * key always means the same unknown value, which keeps the encoding sound.
 */
export type Term =
  | { t: "var"; name: string; sort: Sort }
  | { t: "num"; value: string; sort: "Int" | "Real" }
  | { t: "bool"; value: boolean }
  | { t: "opaque"; key: string; sort: Sort }
  | { t: "app"; op: TermOp; args: Term[]; sort: Sort };

export type TermOp = "+" | "-" | "*" | "/" | "neg" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or" | "not" | "ite";

export interface Obligation {
  /** "must": failing to prove is a compile error. "runtime": failing keeps a runtime check. */
  severity: "must" | "runtime";
  kind: "nonzero" | "refinement" | "range";
  decl: string;
  span: Span;
  /** What is being proved, in Charter syntax, for messages. */
  claim: string;
  facts: Term[];
  /** Facts as they were written, for messages. */
  factText: string[];
  goal: Term;
}
