import { Reject, type App, type Ctx, type Json } from "./runtime.ts";
type Rec = { [key: string]: Json };
const fail = (why: string): never => { throw new Reject(why); };
const integer = (x: Json, lo: number, hi: number): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= lo && x <= hi;
const text = (x: Json, max = 10000): x is string => typeof x === "string" && x.trim().length > 0 && [...x].length <= max;
const admin = (ctx: Ctx): void => { if (!ctx.system) throw new Reject("Denied"); };
const person = (ctx: Ctx): string => { if (!ctx.caller || !ctx.db.get("Person", ctx.caller)) throw new Reject("Denied"); return ctx.caller; };
const get = (ctx: Ctx, tab: string, id: Json): Rec => { if (typeof id !== "string") throw new Reject("ValidationError"); const found = ctx.db.get(tab,id); if (!found) throw new Reject("NotFound"); return found; };
const owned = (ctx: Ctx, tab: string, id: Json): Rec => { const rec = get(ctx,tab,id); if(rec.owner !== person(ctx)) throw new Reject("Denied"); return rec; };
const register = (ctx: Ctx, name: Json): string => { admin(ctx); if(!text(name)) throw new Reject("ValidationError"); const id=ctx.newId();ctx.db.put("Person",id,{name});return id; };
const registerBalance = (ctx: Ctx, name: Json): string => { admin(ctx); if(!text(name)) throw new Reject("ValidationError"); const id=ctx.newId();ctx.db.put("Person",id,{name,balance:0});return id; };

const app: App = { rules: {
  Register: registerBalance,
  Grant(ctx: Ctx, customer: Json, cents: Json) {
    admin(ctx);if(!integer(cents,1,100000)) throw new Reject("ValidationError");
    const p=get(ctx,"Person",customer),next=(p.balance as number)+cents;
    ctx.db.put("Person",customer as string,{...p,balance:next});return next;
  },
  Spend(ctx: Ctx, cents: Json) {
    if(!integer(cents,1,Number.MAX_SAFE_INTEGER)) throw new Reject("ValidationError");
    const id=person(ctx),p=get(ctx,"Person",id);
    if((p.balance as number)<cents) throw new Reject("InsufficientCredit");
    const next=(p.balance as number)-cents;
    ctx.db.put("Person",id,{...p,balance:next});return next;
  }
}, queries: {
  Balance(ctx: Ctx) {return get(ctx,"Person",person(ctx)).balance;}
} }; export default app;
