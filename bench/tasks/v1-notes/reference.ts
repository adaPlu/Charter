import { Reject, type App, type Ctx, type Json } from "./runtime.ts";

const app: App = {
  rules: {
    Register(ctx: Ctx, name: Json) {
      if (!ctx.system) throw new Reject("Denied");
      if (typeof name !== "string") throw new Reject("ValidationError", "name");
      const id = ctx.newId();
      ctx.db.put("Person", id, { name });
      return id;
    },
    AddNote(ctx: Ctx, title: Json) {
      if (typeof title !== "string" || title.trim().length < 1 || [...title].length > 100) throw new Reject("ValidationError", "title");
      if (!ctx.caller || !ctx.db.get("Person", ctx.caller)) throw new Reject("Denied");
      const id = ctx.newId();
      ctx.db.put("Note", id, { owner: ctx.caller, title });
      return id;
    },
    DeleteNote(ctx: Ctx, note: Json) {
      if (typeof note !== "string") throw new Reject("ValidationError", "note");
      const n = ctx.db.get("Note", note);
      if (!n) throw new Reject("NotFound", "note");
      if (n.owner !== ctx.caller) throw new Reject("Denied");
      ctx.db.delete("Note", note);
    },
  },
  queries: {
    MyNotes(ctx: Ctx) {
      if (!ctx.caller || !ctx.db.get("Person", ctx.caller)) throw new Reject("Denied");
      return ctx.db.all("Note")
        .filter((r) => r.record.owner === ctx.caller)
        .map((r) => ({ id: r.id, title: r.record.title as string }))
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    },
  },
};
export default app;
