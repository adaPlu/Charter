// charter serve: every rule and query of a program, over HTTP, run by the reference
// interpreter on a SQLite database (design doc, section 8.4, milestone 2).
//
//   POST /rules/<Name>     body { "args": [...] }   runs one step
//   POST /queries/<Name>   body { "args": [...] }   reads
//   GET  /schema           the rules and queries, with parameter types
//
// Development only: the caller is taken from the X-Charter-Caller header, the id of a principal
// record. Real authentication is the identity module's job (Phase 5, example 3).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Program, Decl } from "@charter/syntax";
import type { CheckResult } from "@charter/types";
import { show } from "@charter/types";
import { toJson, fromJson, Fault, type Interpreter, type Outcome } from "@charter/interp";

/** HTTP status for each outcome (design doc, Phase 5, example 3). */
function statusOf(o: Outcome, isQuery: boolean): number {
  if (o.kind === "ok") return 200;
  if (o.kind === "fault") return 500;
  switch (o.name) {
    case "ValidationError": return 400;
    case "NotFound": return 404;
    case "Denied": return isQuery ? 404 : 403; // queries do not reveal what exists (R-14)
    case "InvariantViolated": return 500;     // a bug in the program, never a client mistake
    default: return 409;                      // a declared business rejection
  }
}

function body(o: Outcome): unknown {
  if (o.kind === "ok") return { outcome: "ok", value: toJson(o.value) };
  if (o.kind === "reject") return { outcome: "rejected", reason: o.name, ...(o.detail ? { detail: o.detail } : {}) };
  return { outcome: "fault", fault: o.fault, message: o.message };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

export function serve(p: Program, c: CheckResult, i: Interpreter, port: number, log: (s: string) => void) {
  const endpoints = p.decls.filter((d): d is Extract<Decl, { kind: "Rule" | "Query" }> => d.kind === "Rule" || d.kind === "Query");
  const schema = endpoints.map((d) => ({
    kind: d.kind.toLowerCase(),
    name: d.name,
    path: `/${d.kind === "Rule" ? "rules" : "queries"}/${d.name}`,
    params: d.params.map((prm) => ({ name: prm.name, type: show(c.resolveType(prm.type).ty) })),
  }));

  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data) + "\n");
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/schema") return send(res, 200, schema);
      const m = /^\/(rules|queries)\/([A-Za-z_][\w]*)$/.exec(url.pathname);
      if (req.method !== "POST" || !m) return send(res, 404, { error: "use POST /rules/<Name> or /queries/<Name>, or GET /schema" });
      const d = endpoints.find((x) => x.name === m[2] && (x.kind === "Rule") === (m[1] === "rules"));
      if (!d) return send(res, 404, { error: `no ${m[1] === "rules" ? "rule" : "query"} named ${m[2]}` });

      const payload = await readJson(req) as { args?: unknown[] };
      const raw = Array.isArray(payload.args) ? payload.args : [];
      if (raw.length !== d.params.length) {
        return send(res, 400, { outcome: "rejected", reason: "ValidationError", detail: `${d.name} takes ${d.params.length} argument(s), got ${raw.length}` });
      }
      const args = [];
      for (let k = 0; k < d.params.length; k++) {
        const prm = d.params[k]!;
        try { args.push(fromJson(raw[k], c.resolveType(prm.type).ty, c.resolution.decls)); }
        catch (e) { if (e instanceof Fault) return send(res, 400, { outcome: "rejected", reason: "ValidationError", detail: prm.name }); throw e; }
      }
      const header = req.headers["x-charter-caller"];
      const caller = typeof header === "string" && header ? { t: "text" as const, v: header } : null;
      const isQuery = d.kind === "Query";
      const o = isQuery ? i.callQuery(d.name, args, { caller }) : i.callRule(d.name, args, { caller }).outcome;
      log(`${req.method} ${url.pathname}  ${o.kind === "ok" ? "ok" : o.kind === "reject" ? `rejected ${o.name}` : `fault ${o.fault}`}`);
      return send(res, statusOf(o, isQuery), body(o));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });

  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, close: () => server.close() });
    });
  });
}
