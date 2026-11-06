import { Reject, type App, type Ctx, type Json } from "./runtime.ts";

const isInt = (v: Json): v is number => typeof v === "number" && Number.isSafeInteger(v);

function me(ctx: Ctx): { [k: string]: Json } {
  const p = ctx.caller ? ctx.db.get("Person", ctx.caller) : undefined;
  if (!p) throw new Reject("Denied");
  return p;
}

const app: App = {
  rules: {
    Register(ctx: Ctx, name: Json) {
      if (!ctx.system) throw new Reject("Denied");
      if (typeof name !== "string") throw new Reject("ValidationError", "name");
      const id = ctx.newId();
      ctx.db.put("Person", id, { name, balance: 0 });
      return id;
    },
    TopUp(ctx: Ctx, amount: Json) {
      if (!isInt(amount) || amount < 1 || amount > 100000) throw new Reject("ValidationError", "amount");
      const p = me(ctx);
      const balance = (p.balance as number) + amount;
      ctx.db.put("Person", ctx.caller!, { ...p, balance });
      return balance;
    },
    Pay(ctx: Ctx, to: Json, amount: Json) {
      if (typeof to !== "string") throw new Reject("ValidationError", "to");
      const recipient = ctx.db.get("Person", to);
      if (!recipient) throw new Reject("NotFound", "to");
      if (!isInt(amount) || amount < 1) throw new Reject("ValidationError", "amount");
      const p = me(ctx);
      if (to === ctx.caller) throw new Reject("SelfPayment");
      if ((p.balance as number) < amount) throw new Reject("InsufficientFunds");
      const balance = (p.balance as number) - amount;
      ctx.db.put("Person", ctx.caller!, { ...p, balance });
      ctx.db.put("Person", to, { ...recipient, balance: (recipient.balance as number) + amount });
      return balance;
    },
  },
  queries: {
    Balance(ctx: Ctx) {
      return me(ctx).balance as number;
    },
  },
};
export default app;
