// @charter/store: the transactional state store (design doc, sections 2.1 and 4.4).
//
// SQLite through Node's built-in node:sqlite (synchronous, no native build), one writer.
// A whole step, reads included, runs inside BEGIN IMMEDIATE, so steps are serializable even
// when several processes share one database file.
//
// Milestone 2 layout: one generic table of records, keyed by entity type and id, holding the
// record as canonical JSON. One table per entity with real columns and CHECK constraints comes
// with code generation in milestone 5. The store knows nothing about Charter types: values
// arrive already encoded as JSON.
import { createHash } from "node:crypto";

// node:sqlite prints an ExperimentalWarning on load. Hide that one warning, nothing else.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const text = typeof w === "string" ? w : w.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emit as (w: string | Error, ...r: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import("node:sqlite");

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Rec = { [field: string]: Json };

export interface StepRecord {
  n: number;
  /** Rule or query name, or a system step such as "#trigger:Rule". */
  rule: string;
  caller: string | null;
  system: boolean;
  args: Json[];
  now: number;
  seed: string;
  outcome: Json;
}

export interface OutboxEntry { step: number; index: number; cap: string; args: Json[]; status: "pending" }

/** JSON with object keys sorted, so equal values always give equal text. */
export function canonicalJson(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k]!)}`).join(",")}}`;
  return JSON.stringify(v);
}

export class Store {
  private db: InstanceType<typeof DatabaseSync>;
  private inTx = false;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (type, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS steps (n INTEGER PRIMARY KEY, rule TEXT NOT NULL, caller TEXT, system INTEGER NOT NULL,
        args TEXT NOT NULL, now INTEGER NOT NULL, seed TEXT NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (step INTEGER NOT NULL, idx INTEGER NOT NULL, cap TEXT NOT NULL, args TEXT NOT NULL,
        status TEXT NOT NULL, PRIMARY KEY (step, idx));
    `);
  }

  /** Runs fn inside one exclusive transaction. Throwing, or returning { rollback: true }, undoes everything. */
  transaction<T>(fn: () => T & { rollback?: boolean }): T {
    if (this.inTx) throw new Error("store: transactions do not nest");
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec(out?.rollback ? "ROLLBACK" : "COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  get(type: string, id: string): Rec | undefined {
    const row = this.db.prepare("SELECT data FROM records WHERE type = ? AND id = ?").get(type, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Rec) : undefined;
  }

  put(type: string, id: string, rec: Rec): void {
    this.db.prepare("INSERT INTO records (type, id, data) VALUES (?, ?, ?) ON CONFLICT (type, id) DO UPDATE SET data = excluded.data")
      .run(type, id, canonicalJson(rec));
  }

  delete(type: string, id: string): void {
    this.db.prepare("DELETE FROM records WHERE type = ? AND id = ?").run(type, id);
  }

  /** Every record of one type, in ascending id order (design doc, 2.1: deterministic iteration). */
  scan(type: string): { id: string; rec: Rec }[] {
    return (this.db.prepare("SELECT id, data FROM records WHERE type = ? ORDER BY id").all(type) as { id: string; data: string }[])
      .map((r) => ({ id: r.id, rec: JSON.parse(r.data) as Rec }));
  }

  nextStep(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM steps").get() as { n: number };
    return row.n;
  }

  logStep(s: StepRecord): void {
    this.db.prepare("INSERT INTO steps (n, rule, caller, system, args, now, seed, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.n, s.rule, s.caller, s.system ? 1 : 0, canonicalJson(s.args), s.now, s.seed, canonicalJson(s.outcome));
  }

  steps(): StepRecord[] {
    return (this.db.prepare("SELECT * FROM steps ORDER BY n").all() as Record<string, unknown>[]).map((r) => ({
      n: Number(r.n), rule: String(r.rule), caller: r.caller === null ? null : String(r.caller), system: r.system === 1,
      args: JSON.parse(String(r.args)) as Json[], now: Number(r.now), seed: String(r.seed), outcome: JSON.parse(String(r.outcome)) as Json,
    }));
  }

  queueEffect(e: OutboxEntry): void {
    this.db.prepare("INSERT INTO outbox (step, idx, cap, args, status) VALUES (?, ?, ?, ?, ?)")
      .run(e.step, e.index, e.cap, canonicalJson(e.args), e.status);
  }

  outbox(): OutboxEntry[] {
    return (this.db.prepare("SELECT * FROM outbox ORDER BY step, idx").all() as Record<string, unknown>[]).map((r) => ({
      step: Number(r.step), index: Number(r.idx), cap: String(r.cap), args: JSON.parse(String(r.args)) as Json[], status: "pending",
    }));
  }

  /** SHA-256 over every record, in (type, id) order. Replay must reproduce it exactly. */
  stateHash(): string {
    const h = createHash("sha256");
    for (const r of this.db.prepare("SELECT type, id, data FROM records ORDER BY type, id").all() as { type: string; id: string; data: string }[]) {
      h.update(`${r.type}\u0000${r.id}\u0000${r.data}\n`);
    }
    return h.digest("hex");
  }

  close(): void { this.db.close(); }
}
