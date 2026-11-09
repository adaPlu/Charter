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
  CreateRoom(ctx: Ctx, name: Json, capacity: Json) {
    admin(ctx);if(!text(name)||!integer(capacity,1,100)) throw new Reject("ValidationError");
    const id=ctx.newId();ctx.db.put("Room",id,{name,capacity});return id;
  },
  Book(ctx: Ctx, room: Json, date: Json, slot: Json) {
    get(ctx,"Room",room);if(!validDate(date)||!(slot==="morning"||slot==="afternoon")) throw new Reject("ValidationError");
    const owner=person(ctx);
    if(ctx.db.all("Booking").some(x=>x.record.room===room&&x.record.date===date&&x.record.slot===slot)) throw new Reject("AlreadyBooked");
    const id=ctx.newId();ctx.db.put("Booking",id,{owner,room,date,slot});return id;
  },
  Cancel(ctx: Ctx, booking: Json) {
    owned(ctx,"Booking",booking);ctx.db.delete("Booking",booking as string);
  }
}, queries: {
  MyBookings(ctx: Ctx) {
    const owner=person(ctx);
    return ctx.db.all("Booking").filter(x=>x.record.owner===owner)
      .sort((a,b)=> {const da=(a.record.date as string),db=(b.record.date as string),sa=(a.record.slot==="morning"?0:1),sb=(b.record.slot==="morning"?0:1);return da<db?-1:da>db?1:sa<sb?-1:sa>sb?1:a.id<b.id?-1:a.id>b.id?1:0;})
      .map(x=>({id:x.id,room:x.record.room,date:x.record.date,slot:x.record.slot}));
  }
} }; export default app;
