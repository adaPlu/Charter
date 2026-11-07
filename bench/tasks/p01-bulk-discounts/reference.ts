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
  Quote(_ctx: Ctx, quantity: Json, unitCents: Json, member: Json) {
    if (!integer(quantity, 1, 50) || !integer(unitCents, 1, 100000) || typeof member !== "boolean") throw new Reject("ValidationError");
    let total = quantity * unitCents;
    if (quantity >= 10) total -= Math.floor(total * 10 / 100);
    if (member) total -= Math.floor(total * 5 / 100);
    return total;
  }
} }; export default app;
