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

const app: App = { rules: {
  AddRoad(ctx: Ctx, from: Json, to: Json, minutes: Json) {
    admin(ctx);
    if (!text(from) || !text(to) || !integer(minutes, 1, 10000)) throw new Reject("ValidationError");
    ctx.db.put("Road", ctx.newId(), { from, to, minutes });
  }
}, queries: {
  Shortest(ctx: Ctx, from: Json, to: Json) {
    if (!text(from) || !text(to)) throw new Reject("ValidationError");
    if (from === to) return 0;
    const edges = ctx.db.all("Road").map((x) => x.record);
    const distance = new Map<string, number>([[from, 0]]);
    const seen = new Set<string>();
    while (true) {
      let here: string | undefined, best = Infinity;
      for (const [node, cost] of distance) if (!seen.has(node) && cost < best) { here = node; best = cost; }
      if (here === undefined) break;
      if (here === to) return best;
      seen.add(here);
      for (const edge of edges) if (edge.from === here) {
        const target = edge.to as string;
        const candidate = best + (edge.minutes as number);
        if (candidate < (distance.get(target) ?? Infinity)) distance.set(target, candidate);
      }
    }
    throw new Reject("NoRoute");
  }
} }; export default app;
