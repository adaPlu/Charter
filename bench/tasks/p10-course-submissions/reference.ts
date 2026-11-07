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
  CreateClass(ctx: Ctx, code: Json) {
    admin(ctx);if(!text(code)) throw new Reject("ValidationError");
    const id=ctx.newId();ctx.db.put("Class",id,{code,students:[]});return id;
  },
  Enroll(ctx: Ctx, course: Json) {
    const group=get(ctx,"Class",course),student=person(ctx),students=group.students as string[];
    if(students.includes(student)) throw new Reject("AlreadyEnrolled");
    ctx.db.put("Class",course as string,{...group,students:[...students,student]});
  },
  Submit(ctx: Ctx, course: Json, answer: Json) {
    if(!text(answer,200)) throw new Reject("ValidationError");
    const group=get(ctx,"Class",course),student=person(ctx);
    if(!has(group.students,student)) throw new Reject("Denied");
    if(ctx.db.all("Submission").some(x=>x.record.course===course && x.record.student===student)) throw new Reject("AlreadySubmitted");
    ctx.db.put("Submission",ctx.newId(),{course,student,answer});
  }
}, queries: {
  MyAnswer(ctx: Ctx, course: Json) {
    const group=get(ctx,"Class",course),student=person(ctx);
    if(!has(group.students,student)) throw new Reject("Denied");
    const result=ctx.db.all("Submission").find(x=>x.record.course===course && x.record.student===student);
    if(!result) throw new Reject("NotFound");
    return result.record.answer;
  },
  SubmissionCount(ctx: Ctx, course: Json) {
    admin(ctx);get(ctx,"Class",course);
    return ctx.db.all("Submission").filter(x=>x.record.course===course).length;
  }
} }; export default app;
