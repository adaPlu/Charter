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
  Coverage(_ctx: Ctx, shifts: Json) {
    if (!Array.isArray(shifts) || shifts.length > 20) throw new Reject("ValidationError");
    const list = shifts.map((s) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) throw new Reject("ValidationError");
      const { start, end } = s as Rec;
      if (!integer(start, 0, 1439) || !integer(end, 1, 1440) || start >= end) throw new Reject("ValidationError");
      return { start, end };
    });
    const onDuty = new Array<number>(1440).fill(0);
    for (const s of list) for (let m = s.start; m < s.end; m++) onDuty[m]++;
    return { covered: onDuty.filter((n) => n > 0).length, peak: Math.max(0, ...onDuty) };
  }
} }; export default app;
