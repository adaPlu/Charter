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
  CreateEvent(ctx: Ctx, title: Json, priceCents: Json, stock: Json) {
    admin(ctx);
    if(!text(title)||!integer(priceCents,1,100000)||!integer(stock,0,1000)) throw new Reject("ValidationError");
    const id=ctx.newId();ctx.db.put("Event",id,{title,priceCents,stock});return id;
  },
  Buy(ctx: Ctx, event: Json, quantity: Json) {
    if(!integer(quantity,1,10)) throw new Reject("ValidationError");
    const e=get(ctx,"Event",event),owner=person(ctx);
    if((e.stock as number)<quantity) throw new Reject("SoldOut");
    const id=ctx.newId();ctx.db.put("Purchase",id,{owner,event,quantity,totalCents:quantity*(e.priceCents as number),cancelled:false});
    ctx.db.put("Event",event as string,{...e,stock:(e.stock as number)-quantity});
    return id;
  },
  CancelPurchase(ctx: Ctx, purchase: Json) {
    const p=owned(ctx,"Purchase",purchase);
    if(p.cancelled) throw new Reject("AlreadyCancelled");
    const e=get(ctx,"Event",p.event);
    ctx.db.put("Purchase",purchase as string,{...p,cancelled:true});
    ctx.db.put("Event",p.event as string,{...e,stock:(e.stock as number)+(p.quantity as number)});
  }
}, queries: {
  Remaining(ctx: Ctx, event: Json) {return get(ctx,"Event",event).stock;},
  PurchaseTotal(ctx: Ctx, purchase: Json) {return owned(ctx,"Purchase",purchase).totalCents;}
} }; export default app;
