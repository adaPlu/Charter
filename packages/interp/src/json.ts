// The JSON form of values at the HTTP boundary (charter serve). Unlike the storage encoding in
// values.ts, this form is for people and clients: decimals are strings ("40.00", exact),
// enums without data are their variant name, ids are strings, records are objects.
import type { Ty } from "@charter/types";
import type { Decl } from "@charter/syntax";
import { V, SCALE, parseDec, toCents, formatDec, Fault, type Value } from "./values.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function toJson(v: Value): Json {
  switch (v.t) {
    case "int": return v.v;
    case "dec": return formatDec(v.v, v.money);
    case "bool": return v.v;
    case "text": return v.v;
    case "time": return new Date(v.v).toISOString();
    case "dur": return `${v.v}ms`;
    case "none": return null;
    case "enum": return v.fields.length ? { variant: v.variant, fields: v.fields.map(toJson) } : v.variant;
    case "list": return v.items.map(toJson);
    case "record": return Object.fromEntries(v.fields.map(([n, x]) => [n, toJson(x)]));
    case "id": return v.v;
    case "ref": return v.id;
    case "table": return v.entity;
  }
}

/** Converts a client's JSON value to the declared type, or throws a ValidationError fault. */
export function fromJson(j: unknown, ty: Ty, decls: Map<string, Decl>): Value {
  const bad = (): never => { throw new Fault("validation", `expected ${ty.k}, got ${JSON.stringify(j)}`); };
  if (ty.k === "Optional") return j === null || j === undefined ? V.none : fromJson(j, ty.inner, decls);
  switch (ty.k) {
    case "Int": return typeof j === "number" && Number.isSafeInteger(j) ? V.int(j) : typeof j === "string" && /^-?\d+$/.test(j) ? V.int(Number(j)) : bad();
    case "Decimal": case "Money": {
      const text = typeof j === "number" ? String(j) : typeof j === "string" && /^-?\d+(\.\d+)?$/.test(j) ? j : bad();
      const v = parseDec(text);
      return ty.k === "Money" ? V.dec(toCents(v), true) : V.dec(v);
    }
    case "Bool": return typeof j === "boolean" ? V.bool(j) : bad();
    case "Text": return typeof j === "string" ? V.text(j) : bad();
    case "Time": { const t = typeof j === "string" ? Date.parse(j) : typeof j === "number" ? j : NaN; return Number.isFinite(t) ? { t: "time", v: t } : bad(); }
    case "Duration": return typeof j === "number" ? { t: "dur", v: j } : bad();
    case "Id": return typeof j === "string" ? { t: "id", entity: ty.target, v: j } : bad();
    case "Entity": return typeof j === "string" ? { t: "id", entity: ty.name, v: j } : bad();
    case "List": case "Set": return Array.isArray(j) ? { t: "list", items: j.map((x) => fromJson(x, ty.elem, decls)) } : bad();
    case "Record": {
      if (!j || typeof j !== "object" || Array.isArray(j)) return bad();
      const o = j as Record<string, unknown>;
      return { t: "record", fields: ty.fields.map(([n, ft]) => [n, fromJson(o[n] ?? null, ft, decls)] as [string, Value]) };
    }
    case "Enum": {
      const d = decls.get(ty.name);
      if (!d || d.kind !== "EnumDecl") return bad();
      const name = typeof j === "string" ? j : j && typeof j === "object" ? String((j as { variant?: unknown }).variant) : "";
      const variant = d.variants.find((x) => x.name === name);
      if (!variant || variant.fields.length) return bad(); // payload variants as input: later
      return { t: "enum", type: ty.name, variant: name, fields: [] };
    }
    default: return bad();
  }
}

export { SCALE };
