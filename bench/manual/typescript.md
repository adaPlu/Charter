# The TypeScript app API

Write one file, `app.ts`, that default-exports an `App`. Reply with a single ```typescript code block and nothing else. The file is checked with `tsc --strict` and run with Node 22.

```typescript
import { Reject, type App, type Ctx, type Json } from "./runtime.ts";

const app: App = {
  rules: {
    // POST /rules/AddItem  {"args": [name, stock]}
    AddItem(ctx: Ctx, name: Json, stock: Json) {
      if (!ctx.caller) throw new Reject("Denied");
      if (typeof name !== "string" || name.trim() === "") throw new Reject("ValidationError", "name");
      const id = ctx.newId();
      ctx.db.put("Item", id, { owner: ctx.caller, name, stock: stock as number });
      return id;
    },
  },
  queries: {
    MyItems(ctx: Ctx) {
      return ctx.db.all("Item").filter((r) => r.record.owner === ctx.caller).map((r) => ({ id: r.id, name: r.record.name }));
    },
  },
};
export default app;
```

The runtime provides:

- `ctx.caller`: the caller's id, or `null` when nobody is signed in.
- `ctx.system`: `true` for an operator's system call.
- `ctx.db`: a record store. `get(table, id)`, `put(table, id, record)`, `delete(table, id)`, `all(table)` (ascending id). Records are plain JSON objects.
- `ctx.newId()`: a fresh id. `ctx.now()`: the time in milliseconds.
- `throw new Reject(reason, detail?)`: rejects the call. The reasons map to HTTP statuses: `ValidationError` 400, `Denied` 403, `NotFound` 404, anything else 409.

Every rule call runs in one transaction. Throwing anything rolls back all of its writes. Queries are read-only. Arguments arrive as JSON values in the order the contract lists them, so check their types yourself. Your code must enforce every rule in the task: validation, who may do what, and conditions that must always hold.
