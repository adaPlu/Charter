// Deterministic CBOR encoding (RFC 8949, section 4.2.1, "core deterministic encoding").
// Hashes are computed over these bytes, so the encoding must never depend on key order,
// platform or JavaScript engine. Only the value shapes a syntax tree can contain are allowed.

export type CborValue = null | boolean | number | string | CborValue[] | { [key: string]: CborValue };

function head(major: number, n: number, out: number[]): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`cbor: length or value ${n} out of range`);
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 0x100) out.push(m | 24, n);
  else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
  else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else {
    const hi = Math.floor(n / 0x100000000), lo = n >>> 0;
    out.push(m | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  }
}

const utf8 = new TextEncoder();

function encodeInto(v: CborValue, out: number[]): void {
  if (v === null) { out.push(0xf6); return; }
  if (v === true) { out.push(0xf5); return; }
  if (v === false) { out.push(0xf4); return; }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`cbor: only safe integers are encoded, got ${v}`);
    if (v >= 0) head(0, v, out); else head(1, -1 - v, out);
    return;
  }
  if (typeof v === "string") {
    const bytes = utf8.encode(v);
    head(3, bytes.length, out);
    for (const b of bytes) out.push(b);
    return;
  }
  if (Array.isArray(v)) {
    head(4, v.length, out);
    for (const item of v) encodeInto(item, out);
    return;
  }
  // Maps: keys sorted by the bytewise order of their encodings (RFC 8949, 4.2.1).
  const entries = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
    const kb: number[] = [];
    encodeInto(k, kb);
    return { kb, x };
  });
  entries.sort((a, b) => {
    const n = Math.min(a.kb.length, b.kb.length);
    for (let i = 0; i < n; i++) if (a.kb[i] !== b.kb[i]) return a.kb[i]! - b.kb[i]!;
    return a.kb.length - b.kb.length;
  });
  head(5, entries.length, out);
  for (const e of entries) { out.push(...e.kb); encodeInto(e.x, out); }
}

export function encodeCbor(v: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(v, out);
  return Uint8Array.from(out);
}
