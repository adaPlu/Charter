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

const validDate=(x:Json):x is string=>typeof x==="string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
const app: App = { rules: {
  Register: register,
  CreateHabit(ctx: Ctx, title: Json) {
    if(!text(title,40)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();ctx.db.put("Habit",id,{owner,title,dates:[]});return id;
  },
  LogDay(ctx: Ctx, habit: Json, day: Json) {
    if(!validDate(day)) throw new Reject("ValidationError");
    const rec=owned(ctx,"Habit",habit),dates=rec.dates as string[];
    if(dates.includes(day)) throw new Reject("AlreadyLogged");
    const next=[...dates,day];ctx.db.put("Habit",habit as string,{...rec,dates:next});return next.length;
  },
  UnlogDay(ctx: Ctx, habit: Json, day: Json) {
    const rec=owned(ctx,"Habit",habit),dates=rec.dates as string[];
    if(!dates.includes(day as string)) throw new Reject("NotFound");
    const next=dates.filter(x=>x!==day);ctx.db.put("Habit",habit as string,{...rec,dates:next});return next.length;
  }
}, queries: {
  MyHabits(ctx: Ctx) {
    const owner=person(ctx);
    return ctx.db.all("Habit").filter(x=>x.record.owner===owner).sort((a,b)=>sortNames(a,b,"title"))
      .map(x=>({id:x.id,title:x.record.title,days:(x.record.dates as Json[]).length}));
  }
} }; export default app;
