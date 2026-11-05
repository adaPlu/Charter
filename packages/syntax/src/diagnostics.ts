// Diagnostics shared by every stage. Codes are stable, so the repair loop and the tests can
// rely on them (design doc, section 8.3).
import type { Span } from "./lexer.ts";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  span: Span;
  /** Facts the checker knew, when the diagnostic is about an unproven obligation. */
  known?: string[];
  /** A concrete counterexample from the solver, as variable name to value. */
  witness?: Record<string, string>;
  fixes?: { kind: string; text: string }[];
}

/** Stable diagnostic codes. Grouped by stage: 00xx syntax, 01xx names, 02xx types, 04xx proofs, 09xx not yet supported. */
export const CODES = {
  LEX: "CH0001",
  PARSE: "CH0002",
  UNKNOWN_NAME: "CH0101",
  DUPLICATE_NAME: "CH0102",
  SHADOWED_NAME: "CH0103",
  TYPE_MISMATCH: "CH0201",
  NOT_EXHAUSTIVE: "CH0202",
  BAD_CALL: "CH0203",
  UNKNOWN_FIELD: "CH0204",
  BAD_PATTERN: "CH0205",
  ENTITY_IN_QUERY: "CH0230",
  DIVISION_UNPROVEN: "CH0401",
  REFINEMENT_UNPROVEN: "CH0402",
  RANGE_RUNTIME: "CH0410",
  INFERRED_REQUIREMENT: "CH0450",
  NOT_YET: "CH0901",
} as const;

export function formatDiagnostic(file: string, d: Diagnostic): string {
  const head = `${file}:${d.span.line}:${d.span.col}  ${d.severity} ${d.code}  ${d.message}`;
  const extra: string[] = [];
  if (d.known?.length) extra.push(`    known: ${d.known.join(", ")}`);
  if (d.witness && Object.keys(d.witness).length) {
    extra.push(`    counterexample: ${Object.entries(d.witness).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  }
  for (const f of d.fixes ?? []) extra.push(`    fix (${f.kind}): ${f.text}`);
  return [head, ...extra].join("\n");
}
