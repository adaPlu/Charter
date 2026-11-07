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
const has=(members:Json,personId:string):boolean=>(members as string[]).includes(personId);

const app: App = { rules: {
  Register: register,
  OpenTicket(ctx: Ctx, subject: Json) {
    if(!text(subject,100)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();
    ctx.db.put("Ticket",id,{owner,subject,status:"open",agent:null});return id;
  },
  Assign(ctx: Ctx, ticket: Json, agent: Json) {
    admin(ctx);
    const rec=get(ctx,"Ticket",ticket);get(ctx,"Person",agent);
    ctx.db.put("Ticket",ticket as string,{...rec,agent});
  },
  Close(ctx: Ctx, ticket: Json) {
    const rec=get(ctx,"Ticket",ticket),caller=person(ctx);
    if(rec.agent!==caller) throw new Reject("Denied");
    if(rec.status==="closed") throw new Reject("AlreadyClosed");
    ctx.db.put("Ticket",ticket as string,{...rec,status:"closed"});
  }
}, queries: {
  ReadTicket(ctx: Ctx, ticket: Json) {
    const rec=get(ctx,"Ticket",ticket),caller=person(ctx);
    if(rec.owner!==caller && rec.agent!==caller) throw new Reject("Denied");
    return {subject:rec.subject,status:rec.status,agent:rec.agent};
  }
} }; export default app;
