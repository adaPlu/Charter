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
const sortNames=(a:{id:string;record:Rec},b:{id:string;record:Rec},field:string):number=> {
 const x=a.record[field] as string,y=b.record[field] as string; return x<y?-1:x>y?1:a.id<b.id?-1:a.id>b.id?1:0;
};

const app: App = { rules: {
  Register: register,
  AddItem(ctx: Ctx, name: Json, quantity: Json) {
    if(!text(name,50)||!integer(quantity,1,100)) throw new Reject("ValidationError");
    const owner=person(ctx);
    if(ctx.db.all("Item").some(x=>x.record.owner===owner && x.record.name===name)) throw new Reject("DuplicateName");
    const id=ctx.newId();ctx.db.put("Item",id,{owner,name,quantity});return id;
  },
  Restock(ctx: Ctx, item: Json, quantity: Json) {
    if(!integer(quantity,1,100)) throw new Reject("ValidationError");
    const rec=owned(ctx,"Item",item),next=(rec.quantity as number)+quantity;
    ctx.db.put("Item",item as string,{...rec,quantity:next});return next;
  },
  Consume(ctx: Ctx, item: Json, quantity: Json) {
    if(!integer(quantity,1,Number.MAX_SAFE_INTEGER)) throw new Reject("ValidationError");
    const rec=owned(ctx,"Item",item);
    if(quantity>(rec.quantity as number)) throw new Reject("InsufficientStock");
    const next=(rec.quantity as number)-quantity;
    ctx.db.put("Item",item as string,{...rec,quantity:next});return next;
  }
}, queries: {
  MyStock(ctx: Ctx) {
    const owner=person(ctx);
    return ctx.db.all("Item").filter(x=>x.record.owner===owner).sort((a,b)=>sortNames(a,b,"name"))
      .map(x=>({id:x.id,name:x.record.name,quantity:x.record.quantity}));
  }
} }; export default app;
