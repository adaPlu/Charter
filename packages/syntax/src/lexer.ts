// Lexer for Charter 0.1 (spec/charter.ebnf, lexical section, amendment A20).

export type TokenKind =
  | "word" | "int" | "decimal" | "string" | "duration" | "req_id" | "version" | "symbol" | "eof";

export interface Span { line: number; col: number; offset: number }

export interface Token { kind: TokenKind; text: string; span: Span }

/** Every alphabetic terminal of the grammar. A test checks this against spec/grammar.lock.json. */
export const RESERVED: ReadonlySet<string> = new Set([
  "Bool", "Decimal", "Duration", "Id", "Int", "List", "Map", "Money", "Set", "Text", "Time", "_",
  "accepted", "add", "and", "any", "anyone", "as", "assert", "by", "caller", "compensate", "confirm", "confirmed",
  "count", "create", "delete", "do", "drop", "effects", "else", "emit", "entity", "enum", "event",
  "exists", "expect", "extern", "false", "fn", "for", "forall", "given", "guard", "if", "implies",
  "import", "in", "inferred", "invariant", "it", "let", "match", "migration", "module", "none", "not",
  "now", "ok", "old", "on", "open", "or", "order", "permission", "permit", "permitted", "principal",
  "property", "query", "raise", "reject", "rejects", "rename", "req", "requirement", "result",
  "return", "rule", "select", "set", "succeeds", "sum", "system", "test", "then", "to", "true", "type",
  "uses", "when", "where",
]);

const SYMBOLS = ["=>", "->", "==", "!=", "<=", ">=", "??", ..."=<>+-*/%.,:;()[]{}?@^~".split("")];

export class LexError extends Error {
  span: Span;
  constructor(message: string, span: Span) { super(message); this.span = span; }
}

/** Splits source text into tokens, ending with an eof token. Comments and whitespace are dropped. */
export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0, line = 1, col = 1;
  const here = (): Span => ({ line, col, offset: i });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") { line++; col = 1; } else col++;
      i++;
    }
  };
  const push = (kind: TokenKind, text: string) => { toks.push({ kind, text, span: here() }); advance(text.length); };

  while (i < src.length) {
    const rest = src.slice(i);
    const c = rest[0]!;
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) { advance(1); continue; }
    if (rest.startsWith("//")) { while (i < src.length && src[i] !== "\n") advance(1); continue; }
    if (c === '"') {
      let j = 1, closed = false;
      while (j < rest.length) {
        if (rest[j] === "\\") { j += 2; continue; }
        if (rest[j] === "\n") break;
        if (rest[j] === '"') { closed = true; break; }
        j++;
      }
      if (!closed) throw new LexError("unterminated string", here());
      push("string", rest.slice(0, j + 1));
      continue;
    }
    if ((m = /^R-\d+(?![\p{L}\p{N}_])/u.exec(rest))) { push("req_id", m[0]); continue; }
    if ((m = /^\d+\.\d+\.\d+(?![\d.])/.exec(rest))) { push("version", m[0]); continue; }
    if ((m = /^\d+\.\d+(?!\d)/.exec(rest))) { push("decimal", m[0]); continue; }
    if ((m = /^\d+(ms|s|m|h|d)(?![\p{L}\p{N}_])/u.exec(rest))) { push("duration", m[0]); continue; }
    if ((m = /^\d+(?![\p{L}_])/u.exec(rest))) { push("int", m[0]); continue; }
    if ((m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest))) { push("word", m[0]); continue; }
    const sym = SYMBOLS.find((s) => rest.startsWith(s));
    if (sym) { push("symbol", sym); continue; }
    throw new LexError(`unexpected character "${c}"`, here());
  }
  toks.push({ kind: "eof", text: "", span: here() });
  return toks;
}

/** Decodes the text of a string token, including its escapes. */
export function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/g, (_, e: string) => (e === "n" ? "\n" : e === "t" ? "\t" : e));
}

/** Encodes a string value as Charter source. */
export function quote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}
