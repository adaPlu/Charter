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
  AddBookmark(ctx: Ctx, title: Json, url: Json) {
    if(!text(title,80)||!text(url,200)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();ctx.db.put("Bookmark",id,{owner,title,url});return id;
  },
  RenameBookmark(ctx: Ctx, bookmark: Json, title: Json) {
    if(!text(title,80)) throw new Reject("ValidationError");
    const rec=owned(ctx,"Bookmark",bookmark);ctx.db.put("Bookmark",bookmark as string,{...rec,title});
  },
  DeleteBookmark(ctx: Ctx, bookmark: Json) {
    owned(ctx,"Bookmark",bookmark);ctx.db.delete("Bookmark",bookmark as string);
  }
}, queries: {
  MyBookmarks(ctx: Ctx) {
    const owner=person(ctx);
    return ctx.db.all("Bookmark").filter(x=>x.record.owner===owner).sort((a,b)=>sortNames(a,b,"title"))
      .map(x=>({id:x.id,title:x.record.title,url:x.record.url}));
  }
} }; export default app;
