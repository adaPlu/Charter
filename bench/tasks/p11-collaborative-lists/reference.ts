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
  CreateList(ctx: Ctx, name: Json) {
    if(!text(name)) throw new Reject("ValidationError");
    const owner=person(ctx),id=ctx.newId();ctx.db.put("List",id,{owner,name,members:[owner]});return id;
  },
  Invite(ctx: Ctx, list: Json, member: Json) {
    const group=get(ctx,"List",list);
    if(group.owner!==person(ctx)) throw new Reject("Denied");
    get(ctx,"Person",member);
    const members=group.members as string[];
    if(!members.includes(member as string)) ctx.db.put("List",list as string,{...group,members:[...members,member]});
  },
  AddItem(ctx: Ctx, list: Json, name: Json) {
    if(!text(name,60)) throw new Reject("ValidationError");
    const group=get(ctx,"List",list),author=person(ctx);
    if(!has(group.members,author)) throw new Reject("Denied");
    const id=ctx.newId();ctx.db.put("Item",id,{list,name,author});return id;
  },
  RemoveItem(ctx: Ctx, item: Json) {
    const rec=get(ctx,"Item",item),group=get(ctx,"List",rec.list),caller=person(ctx);
    if(rec.author!==caller && group.owner!==caller) throw new Reject("Denied");
    ctx.db.delete("Item",item as string);
  }
}, queries: {
  ListItems(ctx: Ctx, list: Json) {
    const group=get(ctx,"List",list),caller=person(ctx);
    if(!has(group.members,caller)) throw new Reject("Denied");
    return ctx.db.all("Item").filter(x=>x.record.list===list)
      .sort((a,b)=> {const x=a.record.name as string,y=b.record.name as string;return x<y?-1:x>y?1:a.id<b.id?-1:a.id>b.id?1:0;})
      .map(x=>({id:x.id,name:x.record.name}));
  }
} }; export default app;
