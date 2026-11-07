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
  CreateTeam(ctx: Ctx, name: Json) {
    if(!text(name)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();ctx.db.put("Team",id,{owner,name,members:[owner]});return id;
  },
  AddMember(ctx: Ctx, team: Json, member: Json) {
    const group=get(ctx,"Team",team);
    if(group.owner!==person(ctx)) throw new Reject("Denied");
    get(ctx,"Person",member);
    const members=group.members as string[];
    if(!members.includes(member as string)) ctx.db.put("Team",team as string,{...group,members:[...members,member]});
  },
  CreatePage(ctx: Ctx, team: Json, title: Json) {
    if(!text(title,80)) throw new Reject("ValidationError");
    const group=get(ctx,"Team",team),author=person(ctx);
    if(!has(group.members,author)) throw new Reject("Denied");
    const id=ctx.newId();ctx.db.put("Page",id,{team,author,title});return id;
  },
  RenamePage(ctx: Ctx, page: Json, title: Json) {
    if(!text(title,80)) throw new Reject("ValidationError");
    const rec=get(ctx,"Page",page),caller=person(ctx),group=get(ctx,"Team",rec.team);
    if(rec.author!==caller && group.owner!==caller) throw new Reject("Denied");
    ctx.db.put("Page",page as string,{...rec,title});
  }
}, queries: {
  ReadPage(ctx: Ctx, page: Json) {
    const rec=get(ctx,"Page",page),group=get(ctx,"Team",rec.team);
    if(!has(group.members,person(ctx))) throw new Reject("Denied");
    return {title:rec.title,team:rec.team};
  }
} }; export default app;
