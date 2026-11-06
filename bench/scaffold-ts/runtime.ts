// The TypeScript arm's scaffold (design doc, 7.2: "same app scaffold"). It gives a TypeScript
// program the same services Charter's runtime gives a Charter program, so the comparison
// measures the language, not missing infrastructure:
//   - every rule call runs in one SQLite transaction; throwing Reject (or anything) rolls back
//   - queries run read-only
//   - ctx.caller is the caller's id (or null), ctx.system says whether the call is a system call
//   - ctx.newId() gives a fresh id, ctx.now() the time
//   - the HTTP contract and status codes are exactly those of "charter serve"
// The generated program is a file app.ts that default-exports an App. It must do its own
// validation, permission checks and invariants: that is the work Charter makes declarative.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (/SQLite is an experimental feature/.test(typeof w === "string" ? w : w.message)) return;
  (emit as (w: string | Error, ...r: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import("node:sqlite");

/** Throw this to reject a call. reason is one of the names in the task's contract. */
export class Reject extends Error {
  reason: string;
  detail: string | undefined;
  constructor(reason: string, detail?: string) { super(reason); this.reason = reason; this.detail = detail; }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A record store: tables of JSON records keyed by id. */
export interface Db {
  get(table: string, id: string): { [k: string]: Json } | undefined;
  put(table: string, id: string, record: { [k: string]: Json }): void;
  delete(table: string, id: string): void;
  /** Every record of a table, in ascending id order. */
  all(table: string): { id: string; record: { [k: string]: Json } }[];
}

export interface Ctx {
  caller: string | null;
  system: boolean;
  db: Db;
  newId(): string;
  now(): number;
}

export type Handler = (ctx: Ctx, ...args: Json[]) => Json | void;
export interface App { rules: Record<string, Handler>; queries: Record<string, Handler> }

function statusOf(reason: string, isQuery: boolean): number {
  switch (reason) {
    case "ValidationError": return 400;
    case "NotFound": return 404;
    case "Denied": return isQuery ? 404 : 403;
    default: return 409;
  }
}

export async function start(app: App, dbFile: string, port: number): Promise<number> {
  const sql = new DatabaseSync(dbFile);
  sql.exec("CREATE TABLE IF NOT EXISTS records (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tbl, id))");
  const db: Db = {
    get: (t, id) => { const r = sql.prepare("SELECT data FROM records WHERE tbl = ? AND id = ?").get(t, id) as { data: string } | undefined; return r ? JSON.parse(r.data) : undefined; },
    put: (t, id, rec) => { sql.prepare("INSERT INTO records VALUES (?, ?, ?) ON CONFLICT (tbl, id) DO UPDATE SET data = excluded.data").run(t, id, JSON.stringify(rec)); },
    delete: (t, id) => { sql.prepare("DELETE FROM records WHERE tbl = ? AND id = ?").run(t, id); },
    all: (t) => (sql.prepare("SELECT id, data FROM records WHERE tbl = ? ORDER BY id").all(t) as { id: string; data: string }[]).map((r) => ({ id: r.id, record: JSON.parse(r.data) })),
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body) + "\n"); };
    const m = /^\/(rules|queries)\/(\w+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) return send(404, { error: "use POST /rules/<Name> or /queries/<Name>" });
    const isQuery = m[1] === "queries";
    const handler = (isQuery ? app.queries : app.rules)[m[2]!];
    if (!handler) return send(404, { error: `no ${isQuery ? "query" : "rule"} named ${m[2]}` });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let args: Json[] = [];
    try { args = (JSON.parse(Buffer.concat(chunks).toString() || "{}").args ?? []) as Json[]; } catch { return send(400, { error: "bad JSON" }); }
    const caller = typeof req.headers["x-charter-caller"] === "string" && req.headers["x-charter-caller"] ? req.headers["x-charter-caller"] : null;
    const ctx: Ctx = { caller, system: req.headers["x-charter-system"] === "true", db, newId: () => randomBytes(8).toString("hex"), now: () => Date.now() };
    sql.exec("BEGIN IMMEDIATE");
    try {
      const value = handler(ctx, ...args);
      sql.exec(isQuery ? "ROLLBACK" : "COMMIT");
      return send(200, { outcome: "ok", value: value === undefined ? null : value });
    } catch (e) {
      sql.exec("ROLLBACK");
      if (e instanceof Reject) return send(statusOf(e.reason, isQuery), { outcome: "rejected", reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) });
      return send(500, { outcome: "fault", message: (e as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const a = server.address();
    resolve(typeof a === "object" && a ? a.port : port);
  }));
}
