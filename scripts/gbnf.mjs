// A small GBNF reader and character-level recognizer, used only to test spec/charter.gbnf:
// the exported grammar must accept every program the real parser accepts (written with a
// space between tokens). Supports the GBNF subset the exporter emits: rules, "literals",
// [character classes] with ranges and negation, groups, |, *, + and ?.

function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) =>
    e.startsWith("u") && e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16))
    : e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e);
}

export function parseGbnf(text) {
  const rules = new Map();
  const body = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n");
  const defs = body.split(/\n(?=[a-z][a-z0-9-]* ::=)/);
  for (const def of defs) {
    const m = /^([a-z][a-z0-9-]*) ::= ([\s\S]*)$/.exec(def.trim());
    if (!m) throw new Error(`gbnf: cannot read "${def.slice(0, 40)}"`);
    rules.set(m[1], parseExpr(m[2]));
  }
  return rules;
}

function parseExpr(src) {
  let i = 0;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const alt = () => {
    const items = [seq()];
    skip();
    while (src[i] === "|") { i++; items.push(seq()); skip(); }
    return items.length === 1 ? items[0] : { k: "alt", items };
  };
  const seq = () => {
    const items = [];
    for (;;) {
      skip();
      if (i >= src.length || src[i] === "|" || src[i] === ")") break;
      let atom;
      if (src[i] === '"') {
        let j = i + 1;
        while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        atom = { k: "lit", v: unescape(src.slice(i + 1, j)) };
        i = j + 1;
      } else if (src[i] === "[") {
        let j = i + 1;
        while (src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
        atom = charClass(src.slice(i + 1, j));
        i = j + 1;
      } else if (src[i] === "(") {
        i++;
        atom = alt();
        skip();
        if (src[i] !== ")") throw new Error("gbnf: missing )");
        i++;
      } else {
        const m = /^[a-z][a-z0-9-]*/.exec(src.slice(i));
        if (!m) throw new Error(`gbnf: unexpected "${src.slice(i, i + 10)}"`);
        atom = { k: "ref", v: m[0] };
        i += m[0].length;
      }
      const q = src[i];
      if (q === "*" || q === "+" || q === "?") { atom = { k: q, item: atom }; i++; }
      items.push(atom);
    }
    return items.length === 1 ? items[0] : { k: "seq", items };
  };
  return alt();
}

function charClass(body) {
  const neg = body.startsWith("^");
  const s = unescape(neg ? body.slice(1) : body);
  const ranges = [];
  for (let k = 0; k < s.length; k++) {
    if (s[k + 1] === "-" && k + 2 < s.length) { ranges.push([s.charCodeAt(k), s.charCodeAt(k + 2)]); k += 2; }
    else ranges.push([s.charCodeAt(k), s.charCodeAt(k)]);
  }
  return { k: "class", neg, ranges };
}

/** True if `text` is a sentence of the grammar's root rule. */
export function gbnfAccepts(rules, text, start = "root") {
  const memo = new Map();
  const parse = (n, pos) => {
    switch (n.k) {
      case "lit": return text.startsWith(n.v, pos) ? new Set([pos + n.v.length]) : new Set();
      case "class": {
        if (pos >= text.length) return new Set();
        const c = text.charCodeAt(pos);
        const inside = n.ranges.some(([a, b]) => c >= a && c <= b);
        return inside !== n.neg ? new Set([pos + 1]) : new Set();
      }
      case "ref": {
        const key = n.v + "@" + pos;
        if (memo.has(key)) return memo.get(key);
        memo.set(key, new Set());
        const r = rules.get(n.v);
        if (!r) throw new Error(`gbnf: undefined rule ${n.v}`);
        const out = parse(r, pos);
        memo.set(key, out);
        return out;
      }
      case "seq": {
        let cur = new Set([pos]);
        for (const it of n.items) {
          const next = new Set();
          for (const p of cur) for (const q of parse(it, p)) next.add(q);
          if (!next.size) return next;
          cur = next;
        }
        return cur;
      }
      case "alt": { const out = new Set(); for (const it of n.items) for (const q of parse(it, pos)) out.add(q); return out; }
      case "?": { const out = new Set([pos]); for (const q of parse(n.item, pos)) out.add(q); return out; }
      case "*": case "+": {
        const out = n.k === "*" ? new Set([pos]) : new Set();
        let frontier = [pos];
        const seen = new Set([pos]);
        while (frontier.length) {
          const next = [];
          for (const p of frontier) for (const q of parse(n.item, p)) { out.add(q); if (!seen.has(q)) { seen.add(q); next.push(q); } }
          frontier = next;
        }
        return out;
      }
    }
  };
  return parse({ k: "ref", v: start }, 0).has(text.length);
}
