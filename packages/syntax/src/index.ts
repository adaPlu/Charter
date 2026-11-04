// @charter/syntax: lexer, parser, canonical printer and diagnostics.
export * from "./lexer.ts";
export type * from "./ast.ts";
export * from "./diagnostics.ts";
export { parse, parseExpr, ParseError, type ParseResult } from "./parser.ts";
export { print, printExpr, printType } from "./printer.ts";

/**
 * Returns a copy of a syntax tree without source positions, with object keys in sorted order.
 * Two trees are the same program exactly when their stripped forms are deeply equal.
 */
export function stripSpans(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSpans);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node).sort()) {
      if (key === "span") continue;
      const v = (node as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = stripSpans(v);
    }
    return out;
  }
  return node;
}
