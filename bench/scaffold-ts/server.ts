// Starts a generated TypeScript app: node server.ts <app.ts> <db file> <port>
// Prints "serving on http://127.0.0.1:<port>" once listening, like charter serve.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { start, type App } from "./runtime.ts";

const [appFile, dbFile = ":memory:", port = "0"] = process.argv.slice(2);
if (!appFile) { console.error("usage: node server.ts <app.ts> [db] [port]"); process.exit(2); }
const mod = (await import(pathToFileURL(resolve(appFile)).href)) as { default: App };
const actual = await start(mod.default, dbFile, Number(port));
console.log(`serving on http://127.0.0.1:${actual}`);
