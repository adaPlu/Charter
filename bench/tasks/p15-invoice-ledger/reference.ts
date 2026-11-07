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
  Register: register,
  CreateInvoice(ctx: Ctx, customer: Json, totalCents: Json) {
    admin(ctx);if(!integer(totalCents,1,1000000)) throw new Reject("ValidationError");
    get(ctx,"Person",customer);
    const id=ctx.newId();ctx.db.put("Invoice",id,{owner:customer,total:totalCents,paid:0});return id;
  },
  PayInvoice(ctx: Ctx, invoice: Json, cents: Json) {
    if(!integer(cents,1,Number.MAX_SAFE_INTEGER)) throw new Reject("ValidationError");
    const rec=owned(ctx,"Invoice",invoice),remaining=(rec.total as number)-(rec.paid as number);
    if(cents>remaining) throw new Reject("Overpayment");
    const nextPaid=(rec.paid as number)+cents;
    ctx.db.put("Invoice",invoice as string,{...rec,paid:nextPaid});return (rec.total as number)-nextPaid;
  },
  Refund(ctx: Ctx, invoice: Json, cents: Json) {
    admin(ctx);if(!integer(cents,1,Number.MAX_SAFE_INTEGER)) throw new Reject("ValidationError");
    const rec=get(ctx,"Invoice",invoice);
    if(cents>(rec.paid as number)) throw new Reject("ExcessRefund");
    const nextPaid=(rec.paid as number)-cents;
    ctx.db.put("Invoice",invoice as string,{...rec,paid:nextPaid});return (rec.total as number)-nextPaid;
  }
}, queries: {
  Outstanding(ctx: Ctx, invoice: Json) {
    const rec=owned(ctx,"Invoice",invoice);return (rec.total as number)-(rec.paid as number);
  }
} }; export default app;
