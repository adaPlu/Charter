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

const pending=(rec:Rec):void=>{if(rec.status!=="pending") throw new Reject("WrongState");};
const app: App = { rules: {
  Register: register,
  RequestLeave(ctx: Ctx, days: Json, reason: Json) {
    if(!integer(days,1,14)||!text(reason,200)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();
    ctx.db.put("Leave",id,{owner,days,reason,status:"pending"});return id;
  },
  Approve(ctx: Ctx, request: Json) {
    admin(ctx);const rec=get(ctx,"Leave",request);pending(rec);
    ctx.db.put("Leave",request as string,{...rec,status:"approved"});
  },
  RejectLeave(ctx: Ctx, request: Json) {
    admin(ctx);const rec=get(ctx,"Leave",request);pending(rec);
    ctx.db.put("Leave",request as string,{...rec,status:"rejected"});
  },
  Withdraw(ctx: Ctx, request: Json) {
    const rec=owned(ctx,"Leave",request);pending(rec);
    ctx.db.put("Leave",request as string,{...rec,status:"withdrawn"});
  }
}, queries: {
  LeaveStatus(ctx: Ctx, request: Json) {return owned(ctx,"Leave",request).status;}
} }; export default app;
