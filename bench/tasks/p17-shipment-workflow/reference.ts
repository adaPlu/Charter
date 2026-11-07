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

const following:Record<string,string>={created:"packed",packed:"shipped",shipped:"delivered"};
const app: App = { rules: {
  Register: register,
  CreateShipment(ctx: Ctx, customer: Json) {
    admin(ctx);get(ctx,"Person",customer);
    const id=ctx.newId();ctx.db.put("Shipment",id,{owner:customer,status:"created"});return id;
  },
  Advance(ctx: Ctx, shipment: Json, next: Json) {
    admin(ctx);if(next!=="packed"&&next!=="shipped"&&next!=="delivered") throw new Reject("ValidationError");
    const rec=get(ctx,"Shipment",shipment);
    if(following[rec.status as string]!==next) throw new Reject("WrongState");
    ctx.db.put("Shipment",shipment as string,{...rec,status:next});
  },
  CancelShipment(ctx: Ctx, shipment: Json) {
    const rec=owned(ctx,"Shipment",shipment);
    if(rec.status!=="created" && rec.status!=="packed") throw new Reject("WrongState");
    ctx.db.put("Shipment",shipment as string,{...rec,status:"cancelled"});
  }
}, queries: {
  Track(ctx: Ctx, shipment: Json) {return owned(ctx,"Shipment",shipment).status;}
} }; export default app;
