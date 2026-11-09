import { Reject, type App, type Ctx, type Json } from "./runtime.ts";
type Rec = { [key: string]: Json };
const fail = (why: string): never => { throw new Reject(why); };
const integer = (x: Json, lo: number, hi: number): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= lo && x <= hi;
const text = (x: Json, max = 10000): x is string => typeof x === "string" && x.trim().length > 0 && [...x].length <= max;
const admin = (ctx: Ctx): void => { if (!ctx.system) throw new Reject("Denied"); };
const person = (ctx: Ctx): string => { if (!ctx.caller || !ctx.db.get("Person", ctx.caller)) throw new Reject("Denied"); return ctx.caller; };
const get = (ctx: Ctx, tab: string, id: Json): Rec => {
  if (typeof id !== "string") throw new Reject("ValidationError");
  const found = ctx.db.get(tab, id);
  if (!found) throw new Reject("NotFound");
  return found;
};
const owned = (ctx: Ctx, tab: string, id: Json): Rec => {
  const rec = get(ctx, tab, id);
  if (rec.owner !== person(ctx)) throw new Reject("Denied");
  return rec;
};
const register = (ctx: Ctx, name: Json): string => {
  admin(ctx);
  if (!text(name)) throw new Reject("ValidationError");
  const id = ctx.newId(); ctx.db.put("Person", id, { name }); return id;
};

const app: App = { rules: {}, queries: {
  CompareVersions(_ctx: Ctx, first: Json, second: Json) {
    const parts = (v: Json): number[] => {
      if (typeof v !== "string" || !/^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$/.test(v)) throw new Reject("ValidationError");
      return v.split(".").map((p) => Number(p));
    };
    const a = parts(first), b = parts(second);
    for (let i = 0; i < 4; i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (x < y) return "older";
      if (x > y) return "newer";
    }
    return "same";
  }
} }; export default app;
