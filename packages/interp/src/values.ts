// Runtime values and exact arithmetic (design doc, sections 2.3 and 4.2; amendments A4, A13).

export type Value =
  | { t: "int"; v: number }
  | { t: "dec"; v: bigint }            // scaled by 10^18
  | { t: "bool"; v: boolean }
  | { t: "text"; v: string }
  | { t: "time"; v: number }           // milliseconds since the epoch, UTC
  | { t: "dur"; v: number }            // milliseconds
  | { t: "none" }
  | { t: "enum"; type: string; variant: string; fields: Value[] }
  | { t: "list"; items: Value[] }
  | { t: "record"; fields: [string, Value][] };

export const SCALE = 10n ** 18n;
export const DEC_LIMIT = 10n ** 38n * SCALE; // A13: magnitudes stay below 10^38
export const INT_MAX = Number.MAX_SAFE_INTEGER; // A4

/** A fault aborts the step: a bug, never an expected outcome (design doc, section 2.5). */
export class Fault extends Error {
  kind: string;
  constructor(kind: string, message: string) { super(message); this.kind = kind; }
}

export const V = {
  int: (v: number): Value => { checkInt(v); return { t: "int", v }; },
  dec: (v: bigint): Value => { checkDec(v); return { t: "dec", v }; },
  bool: (v: boolean): Value => ({ t: "bool", v }),
  text: (v: string): Value => ({ t: "text", v }),
  none: { t: "none" } as Value,
};

export function checkInt(v: number): void {
  if (!Number.isSafeInteger(v)) throw new Fault("overflow", `integer result ${v} is outside ±(2^53 - 1)`);
}
export function checkDec(v: bigint): void {
  if (v >= DEC_LIMIT || v <= -DEC_LIMIT) throw new Fault("overflow", `decimal result ${formatDec(v)} is outside ±10^38`);
}

export function parseDec(text: string): bigint {
  const neg = text.startsWith("-");
  const [whole, frac = ""] = (neg ? text.slice(1) : text).split(".");
  if (frac.length > 18) throw new Fault("precision", `${text} has more than 18 digits after the point`);
  const v = BigInt(whole!) * SCALE + BigInt((frac + "0".repeat(18)).slice(0, 18) || "0");
  return neg ? -v : v;
}

export function formatDec(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / SCALE, frac = (a % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** n / d rounded half to even, for any signs. */
export function divHalfEven(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Fault("division", "division by zero");
  let q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n, ad = d < 0n ? -d : d;
  const away = (n < 0n) !== (d < 0n) ? -1n : 1n;
  if (twice > ad || (twice === ad && q % 2n !== 0n)) q += away;
  return q;
}

export const toDec = (x: Value): bigint => (x.t === "dec" ? x.v : x.t === "int" ? BigInt(x.v) * SCALE : (() => { throw new Fault("type", `expected a number, got ${show(x)}`); })());

export function equal(a: Value, b: Value): boolean {
  if ((a.t === "int" || a.t === "dec") && (b.t === "int" || b.t === "dec")) return toDec(a) === toDec(b);
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "enum": { const o = b as typeof a; return a.type === o.type && a.variant === o.variant && a.fields.length === o.fields.length && a.fields.every((f, i) => equal(f, o.fields[i]!)); }
    case "list": { const o = b as typeof a; return a.items.length === o.items.length && a.items.every((x, i) => equal(x, o.items[i]!)); }
    case "record": { const o = b as typeof a; return a.fields.length === o.fields.length && a.fields.every(([n, x]) => { const f = o.fields.find(([m]) => m === n); return f !== undefined && equal(x, f[1]); }); }
    case "none": return true;
    default: return (a as { v: unknown }).v === (b as { v: unknown }).v;
  }
}

/** Orders two values of the same kind; none sorts after everything (amendment A8). */
export function compare(a: Value, b: Value): number {
  if (a.t === "none" || b.t === "none") return a.t === b.t ? 0 : a.t === "none" ? 1 : -1;
  if ((a.t === "int" || a.t === "dec") && (b.t === "int" || b.t === "dec")) { const x = toDec(a), y = toDec(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (a.t === "text" && b.t === "text") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if ((a.t === "time" || a.t === "dur") && a.t === b.t) return a.v - (b as typeof a).v;
  if (a.t === "bool" && b.t === "bool") return Number(a.v) - Number(b.v);
  throw new Fault("type", `cannot order ${show(a)} and ${show(b)}`);
}

export function show(v: Value): string {
  switch (v.t) {
    case "int": return String(v.v);
    case "dec": return formatDec(v.v);
    case "bool": return String(v.v);
    case "text": return JSON.stringify(v.v);
    case "time": return new Date(v.v).toISOString();
    case "dur": return `${v.v}ms`;
    case "none": return "none";
    case "enum": return v.fields.length ? `${v.variant}(${v.fields.map(show).join(", ")})` : v.variant;
    case "list": return `[${v.items.map(show).join(", ")}]`;
    case "record": return `{ ${v.fields.map(([n, x]) => `${n} = ${show(x)}`).join(", ")} }`;
  }
}
