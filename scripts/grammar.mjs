// Grammar tooling for milestone 0.
//  - loadGrammar: reads spec/charter.ebnf into rules.
//  - grammarProblems: undefined, duplicate, unreachable and left-recursive rules.
//  - tokenize + recognize: checks whether a Charter program belongs to the grammar.
//
// The recognizer interprets the EBNF directly and keeps every possible parse (sets of end
// positions, memoized per rule and position). It therefore accepts every program the grammar
// allows, including ambiguous ones. It does not apply the longest-match rule (A18), which the
// real milestone 1 parser implements, and it builds no tree. It exists so the conformance
// corpus can test the grammar before the parser is written.
import { createHash } from "node:crypto";

/** Rules whose bodies describe one token at the character level. */
export const TOKEN_CLASSES = ["ident", "int", "decimal", "string", "duration", "req_id", "version"];
/** Rules used only inside token definitions. */
export const LEXICAL_HELPERS = ["letter", "digit"];
const LEXICAL = new Set([...TOKEN_CLASSES, ...LEXICAL_HELPERS]);
const WORD = /^[\p{L}_][\p{L}\p{N}_]*$/u;

// ---------------------------------------------------------------- EBNF reader

function ebnfTokens(text) {
  const toks = [];
  let i = 0, line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" && text[i + 1] === "*") {
      const end = text.indexOf("*)", i + 2);
      if (end < 0) throw new Error(`charter.ebnf:${line}: unterminated comment`);
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      i = end + 2; continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new Error(`charter.ebnf:${line}: unterminated terminal`);
      toks.push({ t: "term", v: text.slice(i + 1, end), line }); i = end + 1; continue;
    }
    if (c === "?") {
      const end = text.indexOf("?", i + 1);
      if (end < 0) throw new Error(`charter.ebnf:${line}: unterminated special sequence`);
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      toks.push({ t: "special", v: text.slice(i + 1, end).trim(), line }); i = end + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      toks.push({ t: "name", v: text.slice(i, j), line }); i = j; continue;
    }
    if ("=;|[]{}()".includes(c)) { toks.push({ t: c, line }); i++; continue; }
    throw new Error(`charter.ebnf:${line}: unexpected character "${c}"`);
  }
  return toks;
}

/** Parses the EBNF. Returns { rules: Map<name, node>, order: string[], lines: Map, duplicates: string[] }. */
export function loadGrammar(text) {
  const toks = ebnfTokens(text);
  let k = 0;
  const peek = () => toks[k];
  const take = (t) => {
    const tok = toks[k];
    if (!tok || tok.t !== t) throw new Error(`charter.ebnf:${tok?.line ?? "end"}: expected "${t}", found "${tok?.v ?? tok?.t ?? "end of file"}"`);
    k++; return tok;
  };
  const alt = () => {
    const options = [seq()];
    while (peek()?.t === "|") { k++; options.push(seq()); }
    return options.length === 1 ? options[0] : { k: "alt", items: options };
  };
  const seq = () => {
    const items = [];
    while (peek() && !["|", ";", "]", "}", ")"].includes(peek().t)) items.push(factor());
    if (items.length === 0) throw new Error(`charter.ebnf:${peek()?.line}: empty alternative`);
    return items.length === 1 ? items[0] : { k: "seq", items };
  };
  const factor = () => {
    const tok = toks[k++];
    switch (tok.t) {
      case "term": return { k: "term", v: tok.v };
      case "special": return { k: "special", v: tok.v };
      case "name": return { k: "ref", v: tok.v, line: tok.line };
      case "[": { const n = alt(); take("]"); return { k: "opt", item: n }; }
      case "{": { const n = alt(); take("}"); return { k: "rep", item: n }; }
      case "(": { const n = alt(); take(")"); return n; }
      default: throw new Error(`charter.ebnf:${tok.line}: unexpected "${tok.t}"`);
    }
  };
  const rules = new Map(), order = [], lines = new Map(), duplicates = [];
  while (k < toks.length) {
    const name = take("name");
    take("=");
    const body = alt();
    take(";");
    if (rules.has(name.v)) duplicates.push(name.v);
    rules.set(name.v, body); order.push(name.v); lines.set(name.v, name.line);
  }
  return { rules, order, lines, duplicates };
}

function walk(node, fn) {
  fn(node);
  if (node.items) node.items.forEach((n) => walk(n, fn));
  if (node.item) walk(node.item, fn);
}

/** Reserved words: alphabetic terminals in non-lexical rules. Symbols: the other terminals. */
export function vocabulary(g) {
  const reserved = new Set(), symbols = new Set();
  for (const [name, body] of g.rules) {
    if (LEXICAL.has(name)) continue;
    walk(body, (n) => {
      if (n.k !== "term") return;
      (WORD.test(n.v) ? reserved : symbols).add(n.v);
    });
  }
  return { reserved, symbols };
}

function nullable(g) {
  const N = new Set();
  const isNull = (n) => {
    switch (n.k) {
      case "term": case "special": return false;
      case "ref": return N.has(n.v);
      case "opt": case "rep": return true;
      case "seq": return n.items.every(isNull);
      case "alt": return n.items.some(isNull);
    }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of g.rules) if (!N.has(name) && isNull(body)) { N.add(name); changed = true; }
  }
  return { set: N, isNull };
}

/** Returns a list of human-readable problems. An empty list means the grammar is well-formed. */
export function grammarProblems(g, start = "program") {
  const problems = [];
  for (const d of g.duplicates) problems.push(`rule "${d}" is defined more than once`);
  if (!g.rules.has(start)) problems.push(`start rule "${start}" is missing`);

  for (const [name, body] of g.rules) {
    walk(body, (n) => {
      if (n.k === "ref" && !g.rules.has(n.v)) problems.push(`rule "${name}" uses undefined rule "${n.v}" (line ${n.line})`);
      if (n.k === "special" && !LEXICAL.has(name)) problems.push(`special sequence used outside a lexical rule in "${name}"`);
    });
  }

  const seen = new Set([start]), queue = [start];
  while (queue.length) {
    const r = queue.pop();
    const body = g.rules.get(r);
    if (!body) continue;
    walk(body, (n) => { if (n.k === "ref" && !seen.has(n.v)) { seen.add(n.v); queue.push(n.v); } });
  }
  for (const name of g.order) if (!seen.has(name)) problems.push(`rule "${name}" is unreachable from "${start}"`);

  // Left recursion: a rule that can reach itself without consuming a token.
  const { isNull } = nullable(g);
  const leftRefs = (n, out = new Set()) => {
    switch (n.k) {
      case "ref": out.add(n.v); break;
      case "opt": case "rep": leftRefs(n.item, out); break;
      case "alt": n.items.forEach((m) => leftRefs(m, out)); break;
      case "seq": for (const m of n.items) { leftRefs(m, out); if (!isNull(m)) break; } break;
    }
    return out;
  };
  const edges = new Map([...g.rules].map(([name, body]) => [name, leftRefs(body)]));
  for (const name of g.order) {
    const stack = [...(edges.get(name) ?? [])], visited = new Set();
    while (stack.length) {
      const r = stack.pop();
      if (r === name) { problems.push(`rule "${name}" is left-recursive`); break; }
      if (visited.has(r)) continue;
      visited.add(r);
      stack.push(...(edges.get(r) ?? []));
    }
  }
  return problems;
}

export function grammarStats(g) {
  const { reserved, symbols } = vocabulary(g);
  return {
    productions: g.order.length,
    syntacticRules: g.order.filter((r) => !LEXICAL.has(r)).length,
    tokenClasses: TOKEN_CLASSES.length,
    reservedWords: [...reserved].sort(),
    symbols: [...symbols].sort(),
  };
}

/** Hash of the grammar text with line endings normalized, so Windows and Linux agree. */
export const grammarHash = (text) =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

// ---------------------------------------------------------------- Charter tokenizer

const SYMBOLS = ["=>", "->", "==", "!=", "<=", ">=", "??", ...("=<>+-*/%.,:;()[]{}?@^~".split(""))];

/** Splits Charter source into tokens. Throws { line, col, message } on a lexical error. */
export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const push = (kind, text) => toks.push({ kind, text, line, col });
  const advance = (n) => {
    for (let j = 0; j < n; j++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; }
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if (/^\s/.test(rest)) { advance(1); continue; }
    if (rest.startsWith("//")) { while (i < src.length && src[i] !== "\n") advance(1); continue; }
    if (rest[0] === '"') {
      let j = 1, ok = false;
      while (j < rest.length) {
        if (rest[j] === "\\") { j += 2; continue; }
        if (rest[j] === "\n") break;
        if (rest[j] === '"') { ok = true; break; }
        j++;
      }
      if (!ok) throw { line, col, message: "unterminated string" };
      push("string", rest.slice(0, j + 1)); advance(j + 1); continue;
    }
    if ((m = /^R-\d+(?![\p{L}\p{N}_])/u.exec(rest))) { push("req_id", m[0]); advance(m[0].length); continue; }
    if ((m = /^\d+\.\d+\.\d+(?![\d.])/.exec(rest))) { push("version", m[0]); advance(m[0].length); continue; }
    if ((m = /^\d+\.\d+(?![\d])/.exec(rest))) { push("decimal", m[0]); advance(m[0].length); continue; }
    if ((m = /^\d+(ms|s|m|h|d)(?![\p{L}\p{N}_])/u.exec(rest))) { push("duration", m[0]); advance(m[0].length); continue; }
    if ((m = /^\d+(?![\p{L}_])/u.exec(rest))) { push("int", m[0]); advance(m[0].length); continue; }
    if ((m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest))) { push("word", m[0]); advance(m[0].length); continue; }
    const sym = SYMBOLS.find((s) => rest.startsWith(s));
    if (sym) { push("symbol", sym); advance(sym.length); continue; }
    throw { line, col, message: `unexpected character "${rest[0]}"` };
  }
  return toks;
}

// ---------------------------------------------------------------- sentence generator

const SAMPLE = {
  ident: ["a", "b", "x", "Foo", "item_1", "Ünï"],
  int: ["0", "7", "42"],
  decimal: ["1.5", "0.25"],
  string: ['"s"', '"say \\"hi\\""'],
  duration: ["30s", "5ms"],
  req_id: ["R-1", "R-12"],
  version: ["0.1.0", "2.10.3"],
};

/**
 * Generates a random sentence of the grammar, as source text. Below `budget` levels of rule
 * nesting it picks freely; deeper than that it takes the alternative that finishes soonest,
 * so generation always terminates. `rng` returns numbers in [0, 1).
 */
export function generate(g, rng, start = "program", budget = 7) {
  // Shortest completion depth of every rule, by fixpoint.
  const INF = 1e9;
  const depthOf = new Map([...g.rules.keys()].map((r) => [r, TOKEN_CLASSES.includes(r) ? 1 : INF]));
  const nodeDepth = (n) => {
    switch (n.k) {
      case "term": return 0;
      case "ref": return depthOf.get(n.v);
      case "opt": case "rep": return 0;
      case "seq": return Math.max(0, ...n.items.map(nodeDepth));
      case "alt": return Math.min(...n.items.map(nodeDepth));
      default: return INF;
    }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of g.rules) {
      if (TOKEN_CLASSES.includes(name)) continue;
      const d = nodeDepth(body) + 1;
      if (d < depthOf.get(name)) { depthOf.set(name, d); changed = true; }
    }
  }

  const out = [];
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const emit = (n, depth) => {
    const deep = depth >= budget;
    switch (n.k) {
      case "term": out.push(n.v); return;
      case "ref":
        if (TOKEN_CLASSES.includes(n.v)) { out.push(pick(SAMPLE[n.v])); return; }
        emit(g.rules.get(n.v), depth + 1); return;
      case "seq": n.items.forEach((m) => emit(m, depth)); return;
      case "alt": {
        if (deep) {
          const best = Math.min(...n.items.map(nodeDepth));
          emit(pick(n.items.filter((m) => nodeDepth(m) === best)), depth);
        } else emit(pick(n.items), depth);
        return;
      }
      case "opt": if (!deep && rng() < 0.5) emit(n.item, depth); return;
      case "rep": { const k = deep ? 0 : Math.floor(rng() * 3); for (let i = 0; i < k; i++) emit(n.item, depth); return; }
    }
  };
  emit({ k: "ref", v: start }, 0);
  return out.join(" ");
}

/** A small deterministic random number generator (mulberry32). */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- recognizer

/**
 * Checks whether `src` belongs to the grammar, starting from rule `start`.
 * Returns { ok: true } or { ok: false, line, col, message }.
 */
export function recognize(g, src, start = "program") {
  let toks;
  try { toks = tokenize(src); }
  catch (e) { return { ok: false, line: e.line, col: e.col, message: `lexical error: ${e.message}` }; }

  const { reserved } = vocabulary(g);
  const memo = new Map();
  let far = -1;
  const expected = new Set();
  const fail = (pos, what) => {
    if (pos > far) { far = pos; expected.clear(); }
    if (pos === far) expected.add(what);
  };

  const matchClass = (cls, pos) => {
    const t = toks[pos];
    const ok = t && (cls === "ident" ? t.kind === "word" && !reserved.has(t.text) : t.kind === cls);
    if (!ok) fail(pos, cls);
    return ok ? new Set([pos + 1]) : new Set();
  };

  const parse = (n, pos) => {
    switch (n.k) {
      case "term": {
        const t = toks[pos];
        if (t && t.text === n.v && (t.kind === "word" || t.kind === "symbol")) return new Set([pos + 1]);
        fail(pos, `"${n.v}"`);
        return new Set();
      }
      case "special": throw new Error("special sequences are only allowed in token rules");
      case "ref": {
        if (TOKEN_CLASSES.includes(n.v)) return matchClass(n.v, pos);
        const key = n.v + "@" + pos;
        if (memo.has(key)) return memo.get(key);
        memo.set(key, new Set()); // guards against left recursion, which grammarProblems rejects
        const result = parse(g.rules.get(n.v), pos);
        memo.set(key, result);
        return result;
      }
      case "seq": {
        let cur = new Set([pos]);
        for (const item of n.items) {
          const next = new Set();
          for (const p of cur) for (const q of parse(item, p)) next.add(q);
          if (next.size === 0) return next;
          cur = next;
        }
        return cur;
      }
      case "alt": {
        const out = new Set();
        for (const item of n.items) for (const q of parse(item, pos)) out.add(q);
        return out;
      }
      case "opt": {
        const out = new Set([pos]);
        for (const q of parse(n.item, pos)) out.add(q);
        return out;
      }
      case "rep": {
        const out = new Set([pos]);
        let frontier = [pos];
        while (frontier.length) {
          const next = [];
          for (const p of frontier) for (const q of parse(n.item, p)) if (!out.has(q)) { out.add(q); next.push(q); }
          frontier = next;
        }
        return out;
      }
    }
  };

  const ends = parse({ k: "ref", v: start }, 0);
  if (ends.has(toks.length)) return { ok: true, tokens: toks.length };

  // Report at the furthest point reached, either by a failed match or by a complete parse
  // that stopped before the end of the input.
  const longest = ends.size ? Math.max(...ends) : -1;
  if (longest > far) { far = longest; expected.clear(); }
  if (longest === far) expected.add("end of input");
  const at = toks[far];
  const list = [...expected].slice(0, 10).join(", ");
  return at
    ? { ok: false, line: at.line, col: at.col, message: `unexpected "${at.text}"; expected ${list}` }
    : { ok: false, line: toks.at(-1)?.line ?? 1, col: toks.at(-1)?.col ?? 1, message: `unexpected end of input; expected ${list}` };
}
