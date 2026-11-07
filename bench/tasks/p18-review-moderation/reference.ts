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

const app: App = { rules: {
  Register: register,
  PostReview(ctx: Ctx, stars: Json, message: Json) {
    if(!integer(stars,1,5)||!text(message,200)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();
    ctx.db.put("Review",id,{owner,stars,message,status:"pending"});return id;
  },
  Moderate(ctx: Ctx, review: Json, approve: Json) {
    admin(ctx);if(typeof approve!=="boolean") throw new Reject("ValidationError");
    const rec=get(ctx,"Review",review);
    if(rec.status!=="pending") throw new Reject("WrongState");
    ctx.db.put("Review",review as string,{...rec,status:approve?"approved":"rejected"});
  },
  DeleteReview(ctx: Ctx, review: Json) {
    owned(ctx,"Review",review);ctx.db.delete("Review",review as string);
  }
}, queries: {
  PublicReviews(ctx: Ctx) {
    return ctx.db.all("Review").map(x=>x.record).filter(x=>x.status==="approved")
      .sort((a,b)=> {const diff=(b.stars as number)-(a.stars as number);if(diff) return diff;return (a.message as string)<(b.message as string)?-1:(a.message as string)>(b.message as string)?1:0;})
      .map(x=>({stars:x.stars,message:x.message}));
  }
} }; export default app;
