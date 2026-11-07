# Charter in one page

Charter is a small language for programs made of stored records, rules that change them, and conditions that must always hold. Write one module. Reply with a single ```charter code block and nothing else.

## Module layout

```charter
module shop@0.1.0
principal User                         // the type of the signed-in caller, if any

entity User { name: Text, role: Role = Member }
entity Item { owner: Id<User>, name: Text where len(trim(it)) >= 1, stock: Int where >= 0 }
enum Role { Member, Admin }
enum ItemError { OutOfStock, NotOwner }
type ItemView = { id: Id<Item>, name: Text, stock: Int }
```

- `entity` declares stored records. Every entity has an implicit `id`. Fields may have defaults (`= Member`).
- Types: `Int`, `Bool`, `Text`, `Decimal`, `Money`, `Time`, `Id<E>`, `List<T>`, `T?` (optional, value `none`), records `{ a: T, b: U }`, and enums. An `enum` variant may carry data: `Value(v: Int)`.
- A refinement restricts a type: `Int where >= 0`, `Int where it >= 1 and it <= 10`, `Text where len(it) <= 100`. On a field it must hold after every change. On a parameter, a call that breaks it is rejected with `ValidationError`.
- Names are unique in a module, including enum variants. Do not reuse a name in an inner scope.
- Reserved words cannot be names: for example `match`, `order`, `set`, `select`, `count`, `sum`, `result`, `system`, `type`, `test`, `query`, `rule`, `event`, `delete`, `create`, `old`, `on`, `to`, `by`, `in`, `it`, `now`, `ok`, `any`. Capitalized forms (`Order`, `Match`) are fine.

## Rules change state

```charter
rule AddItem(name: Text where len(trim(it)) >= 1, stock: Int where >= 0): Id<Item>
  permit anyone                                 // any signed-in caller
  create Item { owner = caller.id, name = name, stock = stock } as it2
  return it2.id

rule Take(i: Item, qty: Int where > 0) rejects ItemError
  permit i.owner == caller.id or caller.role == Admin
  guard i.stock >= qty else reject OutOfStock
  set i.stock = i.stock - qty
```

- The header is `rule Name(params) [: ReturnType] [rejects ErrorEnum]`, then exactly one `permit`, then clauses, one per line.
- `permit anyone` (signed in), `permit public` (anyone at all, signed in or not; `caller` cannot be used), `permit system` (operator only), or `permit <condition>`. A failed permit gives `Denied`.
- A parameter of entity type (`i: Item`) is passed as an id; if it does not exist the call gives `NotFound`.
- Clauses: `let x = e`, `guard c else reject Variant` (Variant from the rule's `rejects` enum), `set x.field = e`, `create E { f = e, ... } as x`, `delete x`, `for x in coll { clauses }`, `if c { clauses } else { clauses }`, `return e`.
- A rule is one transaction: if any guard fails, or any field refinement or invariant would be broken, nothing changes.
- `caller` is the signed-in principal record (`caller.id`, `caller.role`). It cannot be the target of `set` directly: bind it first, `let me = caller`, then `set me.balance = …`.

## Queries read

```charter
query MyItems(): List<ItemView> permit anyone =
  select { id = i.id, name = i.name, stock = i.stock } for i in Item where i.owner == caller.id order by i.name

query Count(): Int permit anyone = count i in Item where i.owner == caller.id
```

- `select <value> for x in E [where c] [order by e1, e2]` builds a list. `count x in E [where c]`, `sum <value> for x in E [where c]`, `exists x in E: c`, `forall x in E: c`.
- Return records (views), not whole entities.

## Invariants and permissions

```charter
invariant StockNonNegative: Item.stock >= 0
permission CanEdit(u: User, i: Item) = i.owner == u.id or u.role == Admin
```

A named `permission` can be used in a permit: `permit CanEdit(caller, i)`.

## Expressions

`+ - * / %`, `== != < <= > >=` (comparisons do not chain: write `a == b and b == c`), `and or not`, `x ?? default` for optionals, `if c then a else b`, `match e { A => x, B(v) => y, _ => z }`, field access `x.f`, `E[id]` gives an optional record, list literals `[a, b]`, records `{ a = 1 }`, text concatenation with `+`. Built-ins: `len`, `trim`, `lower`, `upper`, `contains`, `abs`, `min`, `max`.

Integer division by a value that could be zero is a compile error: guard it first, for example `guard n != 0 else reject DivideByZero`, or use `if n == 0 then … else … / n`.
