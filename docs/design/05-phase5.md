# Phase 5: Worked examples

When this phase was written, nothing in it had been compiled, run or proven by a tool, because Charter didn't exist as software. Here is what the labels mean in this phase:

| Label | Meaning here |
|---|---|
| `[SPEC]` | A normative change to the language |
| `[ILLUSTRATIVE]` | Charter source, IR and reports written by hand to the spec |
| `[GENERATED-UNTESTED]` | TypeScript and SQL showing what the compiler would emit |

Every "verification result" below was derived by hand. It shows what the verifier *should* report, not something it did report.

**Milestone 0 note.** Each Charter listing now has a conformance case that CI parses against the frozen grammar. Cases `c001` to `c005` correspond to examples 1 to 5. Two listings needed changes, which the Errata section records:
- **Example 3.** Its last property compares `result` with `ok`, which the grammar cannot express. That property is split out as the negative case `n003`.
- **Example 5.** The fixes from its own list of gaps were applied.

## 5.0 Amendments found while writing the examples

Writing real programs exposed gaps in the spec. That was the point of doing them.

| ID | Amendment | Found in |
|---|---|---|
| A8 | A `select` expression that builds a list, with an optional filter and sort order | Example 2: queries had no way to return a list |
| A9 | `permit system` for rules that only internal steps may call. `principal User by account` links the caller to an identity account. | Example 3: registration and operator actions |
| A10 | New ids are derived from the step's random seed as well as the step id. They stay replayable but cannot be guessed. | Example 3: sequential ids would let attackers enumerate projects |
| A11 | `emit` gets an optional `confirm { … }` block that runs as a system step when the effect succeeds | Example 4: an order could never become "Paid" |
| A12 | Tests may contain several `when … expect` acts in a row. A new `effects` value lists the effects the last act queued. | Example 4: concurrency and "no charge" tests |
| A13 | `Decimal` magnitudes must stay below 10³⁸. Exceeding that is a fault. Narrowing now also applies inside expression-level `if`. The minimal standard library is `len`, `trim`, `lower`, `upper`, `contains`, `abs`, `min` and `max`. | Example 1 |

```ebnf
(* [SPEC] grammar deltas; all other productions unchanged (now merged into spec/charter.ebnf) *)
expr       = … | "select" or_expr "for" ident "in" postfix [ "where" expr ]
                 [ "order" "by" expr { "," expr } ] ;                       (* A8, none sorts last *)
permit     = "permit" ( "anyone" | "system" | expr ) [ links ] ;            (* A9 *)
principal  = "principal" ident [ "by" ident ] ;                            (* A9 *)
clause     = … | "emit" capability "(" [ args ] ")"
                 [ "confirm" "{" { clause } "}" ] [ "compensate" "{" { clause } "}" ] ;  (* A11 *)
test       = "test" string "{" { given } act { act } "}" ;                 (* A12 *)
property   = "property" string "forall" params [ "where" expr ] "{" { given } act { act } "}" ;
primary    = … | "effects" ;                                               (* A12, tests only *)
```

**Rules for the new constructs:**
- `anyone` means any authenticated caller. `system` means internal steps only: triggers, confirms, compensations and operator commands.
- `confirm` blocks capture their arguments the same way compensations do, so A3 applies to them.

---

## Example 1: Calculator with validation

**The request:** "Build a calculator that adds, subtracts, multiplies and divides two numbers. If the input is invalid, show an error instead of crashing."

**Requirements:**

| ID | Status | Text |
|---|---|---|
| R-1 | confirmed | Add, subtract, multiply and divide two numbers. |
| R-2 | confirmed | Invalid input shows an error instead of crashing. |
| R-3 | inferred | Numbers are exact decimals with up to 18 digits after the point. |
| R-4 | inferred | Division rounds half to even at 18 digits. |
| R-5 | inferred | Inputs are limited to ±10¹⁵, so every result fits in the number range. |

**Questions asked:** none. Every gap is low-risk, so the engine uses defaults and marks them `inferred` under rule 3 of Phase 3. The release gate still requires the human to approve R-3 through R-5.

**Charter source** (conformance case `c001`):

```
// [ILLUSTRATIVE]
module calc@0.1.0

requirement R-1 confirmed "Add, subtract, multiply and divide two numbers."
requirement R-2 confirmed "Invalid input shows an error instead of crashing."
requirement R-3 inferred  "Numbers are exact decimals with up to 18 digits after the point."
requirement R-4 inferred  "Division rounds half to even at 18 digits."
requirement R-5 inferred  "Inputs are limited to plus or minus 10^15."

type Input = Decimal where it >= -1000000000000000 and it <= 1000000000000000   req R-5
enum Op { Add, Sub, Mul, Div }
enum CalcError { DivideByZero }
enum CalcResult { Value(v: Decimal), Error(e: CalcError) }

fn calculate(a: Decimal, b: Decimal, op: Op): CalcResult =
  match op {
    Add => Value(a + b),
    Sub => Value(a - b),
    Mul => Value(a * b),
    Div => if b == 0 then Error(DivideByZero) else Value(a / b)      // b narrowed to != 0
  }                                                                  req R-1, R-2, R-4

query Calculate(a: Input, b: Input, op: Op): CalcResult permit anyone = calculate(a, b, op)
  req R-1, R-2

test "divide by zero gives an error" { when Calculate(1, 0, Div) expect ok then result == Error(DivideByZero) }
test "2.5 times 4 is 10"             { when Calculate(2.5, 4, Mul) expect ok then result == Value(10) }
test "too-large input is rejected"   { when Calculate(10000000000000000, 1, Add) expect reject ValidationError }

property "adding then subtracting gives back the first number"
  forall a: Input, b: Input {
    when Calculate(a, b, Add) expect ok
    then match result { Value(s) => calculate(s, b, Sub) == Value(a), Error(_) => false }
  }
```

**IR excerpt:**

```
// [ILLUSTRATIVE]
fn calculate(a: Dec, b: Dec, op: Op) -> CalcResult
  switch op.tag
  Div: %z = eq_dec b, 0
       br %z, L_err, L_div
  L_err: return Error(DivideByZero)
  L_div: %q = div_dec a, b          // T-Div discharged by the branch fact b != 0
         %q2 = range_check_dec %q   // kept: range is Unproven (nonlinear)
         return Value(%q2)
```

**Generated code, key parts:**

```ts
// [GENERATED-UNTESTED]
const SCALE = 10n ** 18n;                       // Decimal = bigint scaled by 10^18
export function calculate(a: bigint, b: bigint, op: Op): CalcResult {
  switch (op.tag) {
    case "Add": return { tag: "Value", v: checkDec(a + b) };
    case "Sub": return { tag: "Value", v: checkDec(a - b) };
    case "Mul": return { tag: "Value", v: checkDec(divHalfEven(a * b, SCALE)) };
    case "Div": return b === 0n
      ? { tag: "Error", e: { tag: "DivideByZero" } }
      : { tag: "Value", v: checkDec(divHalfEven(a * SCALE, b)) };
  }
}
```

Malformed JSON such as `"abc"` never reaches `calculate`. The generated HTTP layer rejects it with `ValidationError` and a 400 status, which satisfies R-2.

**Verification, derived by hand:**

| Check | Result | Reason |
|---|---|---|
| Division by zero is impossible | Proven | The else branch carries the fact `b ≠ 0` (A13) |
| Match is exhaustive | Pass | All four `Op` variants are covered |
| Add and Sub stay in range | Proven | Linear: \|a ± b\| ≤ 2×10¹⁵ |
| Mul and Div stay in range | **Unproven** | Nonlinear, so outside the solver's fragment. The facts are true (at most 10³⁰ and 10³³), but the runtime range check stays in. |
| Release gate | Blocked | R-3, R-4 and R-5 are `inferred` |

**Gloss:** "Calculate takes two numbers between minus and plus one quadrillion, and an operation. Inputs outside that range are rejected [R-5, inferred]. Adding, subtracting and multiplying return the exact result. Dividing by zero returns the error DivideByZero. Any other division rounds half to even at 18 decimal places [R-2, R-4]."

---

## Example 2: Task manager with persistence

**The request:** "I need a to-do app. I can add tasks with a title and an optional due date, mark them done, and delete them. Tasks should still be there after I restart."

**Questions asked:**

| ID | Risk | Question | Answer used below |
|---|---|---|---|
| Q-1 | High (permissions) | Is this just for you, or will other people have their own lists? | "Other people too. Everyone sees only their own tasks." |

**Requirements:**

| ID | Status | Text |
|---|---|---|
| R-1 | confirmed | Add a task with a title and an optional due date. |
| R-2 | confirmed | Mark a task done. |
| R-3 | confirmed | Delete a task. |
| R-4 | confirmed | Tasks survive a restart. Satisfied by construction, since every committed step is durable. |
| R-5 | confirmed | Each person sees and changes only their own tasks. The source is the answer to Q-1. |
| R-6 | inferred | Titles are 1 to 200 characters and not blank. |
| R-7 | inferred | Done tasks cannot be reopened. This is the smaller feature, since reopening wasn't asked for. |
| R-8 | inferred | Tasks are listed by due date with undated tasks last, then by creation time. |

**Charter source** (conformance case `c002`, where rule-level links follow the signature under A17):

```
// [ILLUSTRATIVE]
module todo@0.1.0
principal User

entity User { name: Text }
type Title = Text where len(trim(it)) >= 1 and len(it) <= 200                      req R-6
entity Task { owner: Id<User>, title: Title, due: Time?, done: Bool = false, created: Time }
type TaskView = { id: Id<Task>, title: Text, due: Time?, done: Bool }
enum TaskError { AlreadyDone }

permission Owns(u: User, t: Task) = t.owner == u.id                                req R-5

rule AddTask(title: Title, due: Time?): Id<Task>
  permit anyone
  create Task { owner = caller.id, title = title, due = due, created = now } as t
  return t.id                                                                      req R-1

rule CompleteTask(t: Task) rejects TaskError
  permit Owns(caller, t)
  guard not t.done else reject AlreadyDone                                         req R-7
  set t.done = true                                                                req R-2

rule DeleteTask(t: Task)
  permit Owns(caller, t)
  delete t                                                                         req R-3

query MyTasks(): List<TaskView> permit anyone =
  select { id = t.id, title = t.title, due = t.due, done = t.done }
    for t in Task where t.owner == caller.id order by t.due, t.created             req R-5, R-8

assert OnlyOwnerChanges: CompleteTask permitted implies t.owner == caller.id       req R-5
assert OnlyOwnerDeletes: DeleteTask permitted implies t.owner == caller.id         req R-5

test "someone else cannot complete my task" {
  given a = create User { name = "Ana" }
  given b = create User { name = "Ben" }
  given t = create Task { owner = a.id, title = "Buy milk", created = now }
  when CompleteTask(t) as b expect reject Denied
}
test "completing twice is rejected" {
  given a = create User { name = "Ana" }
  given t = create Task { owner = a.id, title = "Buy milk", created = now }
  when CompleteTask(t) as a expect ok
  when CompleteTask(t) as a expect reject AlreadyDone
}
property "a list never shows another person's tasks"
  forall title: Title {
    given a = create User { name = "Ana" }
    given b = create User { name = "Ben" }
    given t = create Task { owner = a.id, title = title, created = now }
    when MyTasks() as b expect ok
    then forall v in result: exists x in Task: x.id == v.id and x.owner == b.id
  }
```

`MyTasks` returns an explicit view record, not the `Task` entity. That avoids the field-exposure warning from Phase 4.

**IR excerpt:**

```
// [ILLUSTRATIVE]
step CompleteTask(t_id) caller c
  %t = load Task t_id                 else NotFound
  %own = eq %t.owner, c
  check %own                          else Denied
  check not %t.done                   else reject AlreadyDone
  write Task t_id .done = true
  // title refinement × CompleteTask: Proven by frame (title not written)
  commit
query MyTasks() caller c
  sql "SELECT id, title, due, done FROM Task WHERE owner = ?1
       ORDER BY due IS NULL, due, created"  [c]
```

**Generated schema:**

```sql
-- [GENERATED-UNTESTED]
CREATE TABLE Task (
  id      TEXT PRIMARY KEY,
  owner   TEXT NOT NULL REFERENCES User(id),
  title   TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due     INTEGER,
  done    INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX Task_owner ON Task(owner);   -- inferred from the MyTasks predicate
```

The `CHECK` constraint covers length only. SQLite has no direct equivalent of Charter's `trim`, so the "not blank" half is enforced by the parameter refinement alone.

**Verification, derived by hand:**

| Check | Result |
|---|---|
| Title refinement for every rule | Proven. Only `AddTask` writes a title, and it comes from a refined parameter. Other rules leave it untouched (frame). |
| Referential integrity of `Task.owner` | Proven. No rule deletes users, and `AddTask` uses `caller.id`, which exists. |
| `OnlyOwnerChanges` and `OnlyOwnerDeletes` asserts | Proven, because each permit is exactly `Owns` |
| Persistence across restart (R-4) | Not proven by the program. It is covered by the runtime's replay and durability test suite, so the report lists it under **Assumed**. |

**A schema change.** The human later asks: "Add a priority to tasks: low, normal or high."

```
// [ILLUSTRATIVE] change set CS-3 (abridged)
enum Priority { Low, Normal, High }                                                req R-9
// add_field Task.priority: Priority = Normal
migration 0.1.0 -> 0.2.0 { add Task.priority: Priority = Normal }
```

**Impact report, derived by hand:**
- **Affected set.** The hash of `Task` changes, so every declaration that references it is affected: `Owns`, `AddTask`, `CompleteTask`, `DeleteTask` and `MyTasks`. Compare this with the Collaborator design from Phase 3, which avoided exactly this ripple.
- **Behavior check.** The analyzer runs the refactor-equivalence check from Phase 3, projected onto the old fields. Each affected rule gives the same outcome and the same writes to the old fields, so the result is `equivalent (proven)`.
- **Migration dry run.** The migration is additive and every existing row gets `Normal`. All invariants hold on the migrated copy. The version bump is minor.

**Gloss of CompleteTask:** "Only the task's owner may complete it [R-5]. If it is already done, the request is rejected with AlreadyDone and nothing changes [R-7, inferred]. Otherwise it is marked done [R-2]."

---

## Example 3: REST API with authentication and authorization

**The requests.** These come from the original prompt:
- **First request:** "Create a web application where users can register, log in, and manage their projects. Users can only modify projects they own. Administrators can access everything. Save all changes automatically."
- **Clarification:** "When a user creates a project, assign ownership to that user. If another user attempts to modify that project, deny the operation unless that user is an administrator."
- **Later change:** the collaborator request from Phase 3.

**A design decision first: Charter does not implement authentication itself.** Password hashing, sessions, login rate limits and account recovery are security-critical and well understood. They belong in a vetted, versioned library module plus a runtime service, not in code an AI generates for each app.

The `identity` module provides:
- `POST /auth/register` and `POST /auth/login`;
- passwords hashed with argon2id;
- `HttpOnly` session cookies;
- rate limits on login;
- an event, `identity.Registered(account, email)`.

The Charter program owns everything *after* "who is this?": users, roles, projects and permissions.

**Questions asked**, using the answers from Phase 3 and three new ones:

| ID | Question | Answer used |
|---|---|---|
| Q-1 | Does "manage" include create, rename and delete? | "Yes, all three." |
| Q-2 | Can admins only view everything, or also edit and delete? | "View, edit and delete any project." |
| Q-3 | Who makes someone an admin? | "Only the operator. There's no in-app promotion." |
| Q-4 (from Phase 3) | Can collaborators be removed, and by whom? | "Owners and admins can remove them." |
| Q-5 (from Phase 3) | Can admins invite collaborators? | "Yes." |

**Requirements:**

| ID | Status | Text |
|---|---|---|
| R-1, R-2 | confirmed | Users can register and log in. Handled by `identity`. |
| R-3 | confirmed | Users can create, rename and delete their projects. |
| R-4 | confirmed | When a user creates a project, they become its owner. |
| R-5 | confirmed | Only the owner or an admin may modify or delete a project. Anyone else is denied. |
| R-6 | confirmed | Admins can view, edit and delete any project. |
| R-7 | confirmed | Changes are saved automatically. Satisfied by construction. |
| R-8 | confirmed | Only the operator can make someone an admin. |
| R-10 | confirmed | Owners and admins can invite collaborators with read-only access. |
| R-12 | confirmed | Owners and admins can remove collaborators. |
| R-13 | inferred | Project names are 1 to 100 characters and not blank. |
| R-14 | inferred | A request for a project you can't see returns 404, not 403, so the project's existence isn't revealed. |

**Charter source** (conformance case `c003`):

```
// [ILLUSTRATIVE]
module projects@1.0.0
import identity@^1.0 as idn
principal User by account                                   // caller = the User whose account matches the session

enum Role { Member, Admin }
entity User { account: Id<idn.Account>, email: Text, role: Role = Member }
type Name = Text where len(trim(it)) >= 1 and len(it) <= 100                        req R-13
entity Project { owner: Id<User>, name: Name }
entity Collaborator { project: Id<Project>, user: Id<User> }
type ProjectView = { id: Id<Project>, name: Text, owner: Id<User> }
enum InviteError { IsOwner, AlreadyInvited, NotInvited }

permission CanEdit(u: User, p: Project) = p.owner == u.id or u.role == Admin       req R-5, R-6
permission CanView(u: User, p: Project) =
  CanEdit(u, p) or exists c in Collaborator: c.project == p.id and c.user == u.id   req R-10

on idn.Registered(acct, email) do CreateUser(acct, email) as system                req R-1
rule CreateUser(acct: Id<idn.Account>, email: Text): Id<User>
  permit system
  create User { account = acct, email = email } as u
  return u.id

rule PromoteToAdmin(u: User) permit system  set u.role = Admin                     req R-8

rule CreateProject(name: Name): Id<Project>
  permit anyone
  create Project { owner = caller.id, name = name } as p                           req R-4
  return p.id

rule RenameProject(p: Project, name: Name)
  permit CanEdit(caller, p)
  set p.name = name                                                                req R-3, R-5

rule DeleteProject(p: Project)
  permit CanEdit(caller, p)
  for k in (select c for c in Collaborator where c.project == p.id) { delete k }
  delete p                                                                         req R-3, R-5

rule InviteCollaborator(p: Project, u: User) rejects InviteError
  permit CanEdit(caller, p)
  guard u.id != p.owner else reject IsOwner
  guard not exists c in Collaborator: c.project == p.id and c.user == u.id else reject AlreadyInvited
  create Collaborator { project = p.id, user = u.id }                              req R-10

rule RemoveCollaborator(p: Project, u: User) rejects InviteError
  permit CanEdit(caller, p)
  guard exists c in Collaborator: c.project == p.id and c.user == u.id else reject NotInvited
  for k in (select c for c in Collaborator where c.project == p.id and c.user == u.id) { delete k }
  req R-12

query GetProject(p: Project): ProjectView permit CanView(caller, p) =
  { id = p.id, name = p.name, owner = p.owner }                                    req R-10
query MyProjects(): List<ProjectView> permit anyone =
  select { id = p.id, name = p.name, owner = p.owner } for p in Project
    where CanView(caller, p) order by p.name                                       req R-3, R-6

assert WritesNeedEdit:  RenameProject permitted implies p.owner == caller.id or caller.role == Admin   req R-5
assert DeletesNeedEdit: DeleteProject permitted implies p.owner == caller.id or caller.role == Admin   req R-5
```

The two asserts look redundant today. Their job is to guard the future. If a later change set loosened `RenameProject` to `CanView`, the asserts would be refuted with a witness, a collaborator renaming the project, and the change would be blocked.

**What the verifier caught on the first draft, derived by hand.** The AI's first draft of `DeleteProject` was just `delete p`. The verifier reported:

```
// [ILLUSTRATIVE]
REFUTED  RefIntegrity(Collaborator.project) × DeleteProject
Witness: Project P1 with Collaborator {project: P1, user: U2}; caller = owner of P1
         After the step, Collaborator.project points to a deleted project.
```

The repair loop added the bulk delete of collaborators. That repair is allowed because it strengthens the rule rather than weakening anything. The fix then verified.

The verifier can only prove this kind of loop because it recognizes the idiom "delete everything a filter selects" and treats it as a single bulk operation. Loops that don't match a known idiom come back Unproven and keep runtime checks.

**IR excerpt:**

```
// [ILLUSTRATIVE]
step DeleteProject(p_id) caller c
  %p = load Project p_id                       else NotFound
  %u = load User c
  check or(eq %p.owner, c, eq %u.role, Admin)  else Denied
  bulk_delete Collaborator where project = p_id
  delete Project p_id
  // RefIntegrity(Collaborator.project): Proven (bulk-delete summary)
  commit
```

**Generated HTTP layer, key parts:**

```ts
// [GENERATED-UNTESTED]
app.use(async (req, res, next) => {
  const acct = await identity.sessionAccount(req);          // from the HttpOnly cookie
  if (!acct) return res.status(401).end();
  req.caller = rt.lookupPrincipal("User", "account", acct);  // A9: principal by account
  if (!req.caller) return res.status(401).end();             // registered but CreateUser not yet run
  next();
});
app.post("/rules/DeleteProject", async (req, res) =>
  send(res, step_DeleteProject(rt, req.caller, parse(DeleteProjectArgs, req.body))));
// Outcome → status: Ok 200 · reject 409 · ValidationError 400 · NotFound 404
//                   Denied 403 for rules, 404 for queries (R-14)
```

**Tests:**

```
// [ILLUSTRATIVE]
test "collaborator cannot rename" {
  given o = create User { account = "a1", email = "o@x" }
  given b = create User { account = "a2", email = "b@x" }
  given p = create Project { owner = o.id, name = "Apollo" }
  when InviteCollaborator(p, b) as o expect ok
  when RenameProject(p, "Hijacked") as b expect reject Denied
  then p.name == "Apollo"
}
test "admin can delete someone else's project, and collaborators go too" {
  given o = create User { account = "a1", email = "o@x" }
  given a = create User { account = "a3", email = "a@x", role = Admin }
  given p = create Project { owner = o.id, name = "Apollo" }
  given c = create Collaborator { project = p.id, user = a.id }
  when DeleteProject(p) as a expect ok
  then count x in Collaborator where x.project == p.id == 0
}
property "rename succeeds exactly for owners and admins"
  forall r: Role, isOwner: Bool, invited: Bool {
    given o = create User { account = "a1", email = "o@x" }
    given u = create User { account = "a2", email = "u@x", role = r }
    given p = create Project { owner = if isOwner then u.id else o.id, name = "Apollo" }
    when RenameProject(p, "New") as u expect any
    then (result == ok) == (isOwner or r == Admin)
  }
```

**Notes on the tests:**
- **The `invited` input** in the property is generated but never used to set anything up. That is deliberate. The property must hold whether or not a collaborator record exists, so invitations must not affect renaming.
- **`result == ok` is not valid under the current grammar.** The grammar has no way to compare `result` with an outcome. This is the first open question in the checkpoint below. Milestone 0 recorded it as the negative conformance case `n003`.

**Verification, derived by hand:**

| Check | Result |
|---|---|
| `WritesNeedEdit` and `DeletesNeedEdit` | Proven |
| Referential integrity for every rule | Proven. `DeleteProject` relies on the bulk-delete summary. |
| `CanEdit` implies `CanView`, so nobody loses read access | Proven |
| Every rule and query has a permit | Pass |
| Field exposure | No warning, because every query returns a view record |
| Login security | **Assumed.** It belongs to the `identity` module, which has its own tests and is listed in the build report. |

**Gloss of DeleteProject:** "The project's owner or any admin may delete it. Anyone else is denied [R-5, R-6]. Deleting a project first removes all its collaborators, then the project [R-3]."

---

## Example 4: Inventory and ordering with concurrency protection

This is the core proof of the paradigm.

**The request:** "Whenever a customer orders an item, reduce inventory. Never allow inventory to become negative. If there isn't enough stock, reject the order without charging the customer."

**Questions asked.** Money is involved, so every gap counts as high risk and is asked about:

| ID | Question | Answer used |
|---|---|---|
| Q-1 | If the payment fails after stock is reserved, should the order be cancelled and the stock returned? | "Yes." |
| Q-2 | Can one order contain several units? | "Yes, from 1 to 10 units." |
| Q-3 | If the price changes between ordering and charging, which price applies? | "The price when the customer ordered." |

**Requirements:**

| ID | Status | Text |
|---|---|---|
| R-1 | confirmed | Ordering an item reduces inventory by the quantity ordered. |
| R-2 | confirmed | Inventory never becomes negative. |
| R-3 | confirmed | If there isn't enough stock, reject the order without charging. |
| R-4 | confirmed | If payment fails, cancel the order and return the stock. |
| R-5 | confirmed | An order has 1 to 10 units of one product. |
| R-6 | confirmed | The charge uses the price at the time of ordering. |
| R-7 | inferred | Only active customers can order. Carried over from Phase 2. |
| R-8 | inferred | Free items, where the amount is 0, are marked paid without a charge. **The verifier found this one.** It is explained below. |

**Charter source** (conformance case `c004`):

```
// [ILLUSTRATIVE]
module shop@0.2.0
uses Payment.charge                 // adapter signature: charge(c: Id<Customer>, amount: Money where > 0, ref: Id<Order>), idempotent
principal Customer

entity Customer { name: Text, active: Bool = true }
entity Product  { name: Text, price: Money where >= 0, stock: Int where >= 0 }
enum   OrderStatus { Pending, Paid, Failed }
type   Qty = Int where it >= 1 and it <= 10                                         req R-5
entity Order { customer: Id<Customer>, product: Id<Product>, qty: Qty,
               amount: Money where >= 0, status: OrderStatus = Pending, placed: Time }
enum   OrderError { OutOfStock }

rule PlaceOrder(p: Product, qty: Qty): Id<Order> rejects OrderError
  permit caller.active                                                             req R-7
  guard p.stock >= qty else reject OutOfStock                                      req R-3
  let amount = p.price * qty                                                       req R-6
  set p.stock = p.stock - qty                                                      req R-1
  create Order { customer = caller.id, product = p.id, qty = qty,
                 amount = amount, placed = now } as o
  if amount > 0 {
    emit Payment.charge(caller.id, amount, o.id)
      confirm    { set o.status = Paid }
      compensate { set o.status = Failed
                   set p.stock = p.stock + qty }                                   req R-4
  } else {
    set o.status = Paid                                                            req R-8
  }
  return o.id

rule Restock(p: Product, qty: Int where > 0) permit system  set p.stock = p.stock + qty

invariant StockNonNegative: Product.stock >= 0                                     req R-2
invariant PaidHasNoFailure: forall o in Order: o.status != Failed or o.amount > 0
```

**What the verifier caught on the first draft, derived by hand.** The first draft called `emit Payment.charge(caller.id, amount, o.id)` with no `if` around it. The verifier reported:

```
// [ILLUSTRATIVE]
ERROR  T-Sub at emit Payment.charge, argument 'amount'
       Needs: amount > 0      Known: price >= 0, qty >= 1      Cannot prove.
       Witness: price = 0.00, qty = 1  →  amount = 0.00
```

A free product would have sent a zero charge to the payment provider. That is a business question, not a coding error. The anti-weakening rule stops the AI from simply loosening the adapter's refinement. Instead, the engine proposed the `if amount > 0` branch and recorded its behavior as `inferred` requirement R-8, which the human must approve.

**How each part of the request is handled:**

| Concern | Mechanism |
|---|---|
| **Atomicity** | The guard, the stock decrement, creating the order and queuing the charge all happen in one serializable transaction. A step either commits all of them or none of them. |
| **No charge when rejected (R-3)** | Guaranteed by the semantics, not by program logic. A rejected step leaves the outbox unchanged, so no charge can exist. Test `effects` checks it as well. |
| **Payment ordering** | Reserve, then charge, then confirm or compensate. Stock is reserved inside the transaction, and the charge happens after commit. The alternative, charging before reserving, is impossible by design: effects never run inside a transaction. |
| **Price captured (R-6)** | `amount` is computed and stored on the order at commit time. A later price change does not affect it. |
| **Concurrent orders** | Steps are serialized by the single writer (4.4). The guard's read and the write happen inside the same exclusive transaction. |
| **Restocking** | `permit system` means only operators or internal steps can add stock. |

**Two concurrent orders for the last unit:**

| Time | Customer A: PlaceOrder(P, 1) | Customer B: PlaceOrder(P, 1) | Stock of P |
|---|---|---|---|
| t0 | Request arrives | Request arrives | 1 |
| t1 | Gets the writer lock, and the guard sees `1 ≥ 1` | Waits in the queue | 1 |
| t2 | Commits: stock to 0, order O-A pending, charge queued | Waiting | 0 |
| t3 | Done | Gets the lock, and the guard sees `0 ≥ 1`, which is false | 0 |
| t4 | | `reject OutOfStock`. Nothing written, nothing queued. | 0 |
| later | Charge succeeds, and confirm sets O-A to Paid | | 0 |

**Proof sketch: stock never goes negative.**

*Claim.* In every reachable state, every product has `stock ≥ 0`.

*Proof sketch.* The proof is by induction over committed steps.
1. **Initial state.** The store starts empty, so the claim holds trivially. A migrated store is checked against every invariant by the mandatory dry run (4.4) before it goes live.
2. **Which steps write `stock`.** Only `PlaceOrder`, its compensation, and `Restock`. The confirm block writes only `o.status`, so by frame reasoning it preserves the claim.
3. **`PlaceOrder`.** The guard gives `stock ≥ qty`, so the new value `stock − qty ≥ 0`. This is linear and in the fragment, so the verifier proves it.
4. **The compensation.** Before it runs, `stock ≥ 0` holds by the induction hypothesis. The captured value `qty ≥ 1` keeps its refinement under A3. So `stock + qty ≥ 0`. The compensation loads current state, so concurrent orders in between do not break the argument.
5. **`Restock`.** It adds a positive `qty` to a non-negative stock. Proven.
6. **Concurrency.** The runtime guarantees serializability, so every concurrent execution is equivalent to some serial order of committed steps. The induction over serial orders therefore covers all concurrent executions. ∎

*What the argument trusts:*
- The single-writer implementation really is serializable, which SQLite's `BEGIN IMMEDIATE` provides.
- The generated code matches the semantics, which is checked statistically by differential testing.
- Integer overflow faults rather than wrapping, under A4.

Two backstops cover those assumptions: the SQL `CHECK (stock >= 0)` constraint, and paranoid mode for this invariant, recommended in Phase 4 for anything linked to money.

**Failure recovery:**

| Failure | What happens | State afterwards |
|---|---|---|
| Crash before commit | The transaction rolls back | As if the order never happened |
| Crash after commit, before the charge is sent | The outbox row is durable, and the dispatcher resumes on restart | Charge sent late, exactly once thanks to the idempotency key |
| Transient payment error | Retried with the same key | Charged at most once |
| Card declined, a permanent failure | Compensation runs as a system step | Order Failed, stock restored (R-4) |
| Timeout after retries are exhausted | `Unknown`, under A6. Sent to an operator. | Order stays Pending. The stock stays reserved, so nothing is oversold. |
| Crash during confirm | Confirm commits in the same transaction that marks the outbox row done. Until then, the row is still pending. | Confirm reruns. It sets status to Paid again, which is idempotent. |
| The compensation can't load the product | Can't happen. Referential integrity prevents deleting a product that orders point to. | n/a |
| The compensation overflows `stock + qty` | The step faults, and the entry becomes `Stuck` | An operator alert. This only happens with absurd stock levels. |

**One trade-off the human should see.** Stock reserved by a pending order can make the product look sold out. If that order's payment then fails, the stock comes back. A customer might be turned away for a unit that later becomes available. This follows from the "reserve first" design, and the engine lists it in the gloss.

**IR excerpt:**

```
// [ILLUSTRATIVE]
step PlaceOrder(p_id, qty) caller c
  check_refine qty in [1,10]                     else ValidationError("qty")
  %p = load Product p_id                         else NotFound
  %c = load Customer c
  check %c.active                                else Denied
  check ge %p.stock, qty                         else reject OutOfStock
  %amt = mul_money %p.price, qty
  write Product p_id .stock = sub %p.stock, qty
  %o = create Order {customer: c, product: p_id, qty, amount: %amt, placed: $now}
  br gt %amt, 0, L_charge, L_free
  L_charge: emit Payment.charge(c, %amt, %o) key=(step,0) confirm=#c0 comp=#k0
            jump L_end
  L_free:   write Order %o .status = Paid
  L_end:    // StockNonNegative: Proven · PaidHasNoFailure: Proven (Failed set only in #k0 where amount > 0)
            // paranoid mode: runtime check of StockNonNegative kept
            commit returning %o
```

**Generated dispatcher, key part:**

```ts
// [GENERATED-UNTESTED]
async function dispatch(entry: OutboxRow) {
  const r = await adapters.Payment.charge(entry.args, entry.key);   // idempotent on key
  switch (r.kind) {
    case "Ok":        return rt.systemStep(entry.confirm, entry.captured, { markDone: entry.id });
    case "Transient": return rt.retryLater(entry, backoff(entry.attempts));
    case "Permanent": return rt.systemStep(entry.compensate, entry.captured, { markDone: entry.id });
    case "Unknown":   return rt.markUnknown(entry);                  // operator queue (A6)
  }
}
// markDone runs inside the same transaction as the confirm or compensation step,
// so "effect handled" and "its consequences" commit together.
```

**Tests:**

```
// [ILLUSTRATIVE]
test "two orders for the last unit: one wins, one is rejected and not charged" {
  given a = create Customer { name = "Ana" }
  given b = create Customer { name = "Ben" }
  given p = create Product { name = "Lamp", price = 40.00, stock = 1 }
  when PlaceOrder(p, 1) as a expect ok
  then len(effects) == 1
  when PlaceOrder(p, 1) as b expect reject OutOfStock
  then len(effects) == 0 and p.stock == 0
}
property "stock never goes negative across order sequences"
  forall q1: Qty, q2: Qty, q3: Qty {
    given c = create Customer { name = "Ana" }
    given p = create Product { name = "Lamp", price = 40.00, stock = 12 }
    when PlaceOrder(p, q1) as c expect any
    when PlaceOrder(p, q2) as c expect any
    when PlaceOrder(p, q3) as c expect any
    then p.stock >= 0 and p.stock == 12 - sum o.qty for o in Order where o.product == p.id
  }
```

Charter tests can't script how an adapter behaves, so failure injection and real parallelism are tested in the runtime's TypeScript suite:

```ts
// [GENERATED-UNTESTED] runtime tests with the payment adapter's test twin
test("50 parallel orders for 10 units", async () => {
  const p = await seedProduct({ price: "40.00", stock: 10 });
  const results = await Promise.all(range(50).map(i => http.post("/rules/PlaceOrder",
    { p, qty: 1 }, asCustomer(i))));
  expect(results.filter(isOk)).toHaveLength(10);
  expect(results.filter(r => r.body.reject === "OutOfStock")).toHaveLength(40);
  expect(await stockOf(p)).toBe(0);
  expect(paymentTwin.calls).toHaveLength(10);
});
test("declined card cancels the order and returns stock", async () => {
  paymentTwin.next("Permanent");
  const p = await seedProduct({ price: "40.00", stock: 3 });
  const o = await placeOrder(p, 2);
  await rt.drainOutbox();
  expect(await orderStatus(o)).toBe("Failed");
  expect(await stockOf(p)).toBe(3);
});
```

**Verification, derived by hand:**

| Check | Result |
|---|---|
| `StockNonNegative` for `PlaceOrder`, its compensation, its confirm and `Restock` | Proven, Proven (A3), Proven (frame), Proven |
| `PaidHasNoFailure` for all rules | Proven. `Failed` is set only in the compensation, which exists only on the `amount > 0` path. |
| Charge `amount > 0` | Proven after the R-8 branch was added |
| No charge on rejection (R-3) | Holds by the semantics, and checked by a test |
| Effect containment | Pass. The only capability used is `Payment.charge`, which is in `uses`. |
| Payment adapter idempotency | **Assumed**, covered by the adapter's conformance suite |
| Liveness: every pending order eventually ends Paid, Failed or with an operator | **Not covered.** A runtime monitor on outbox age stands in for a proof. |
| Release gate | Blocked until R-7 and R-8 are approved |

**Gloss of PlaceOrder:** "An active customer [R-7, inferred] orders 1 to 10 units of a product [R-5]. If stock is below the quantity, the order is rejected with OutOfStock. Nothing changes and nothing is charged [R-3]. Otherwise the stock drops by the quantity [R-1], and an order is saved at today's price [R-6]. If the total is above zero, the customer is charged after saving. When the charge succeeds the order becomes Paid. When it fails, the order becomes Failed and the stock comes back [R-4]. A free order becomes Paid without a charge [R-8, inferred]. Stock can never go below zero (proven) [R-2]. Note: while a payment is pending, its units are held, so the product may briefly look sold out."

---

## Example 5: Real-time multiplayer game (design depth)

**The request:** "Build a real-time multiplayer game where players earn XP, level up, and unlock abilities."

**Questions:**

| ID | Risk | Question | Handling |
|---|---|---|---|
| Q-1 | Medium | How do players earn XP: kills, objectives, match completion? | Must be asked. It decides which events exist. |
| Q-2 | Low | What XP does each level need? | Default: a 10-level table, marked `inferred` |
| Q-3 | Low | Can abilities ever be lost? | Default: no, marked `inferred` |
| Q-4 | High | Can clients report their own XP? | **Never by default.** The answer is fixed by the server-authority design, and the human is told so. |

**Architecture decision: split the game by timescale.** Charter's transactional step model suits durable progression. It does not suit a 20 to 60 Hz physics and combat loop. A single writer cannot run per-tick transactions for hundreds of players, and the outbox adds latency that real-time play cannot absorb.

```
// [ILLUSTRATIVE] architecture
 clients ──inputs (intents only)──▶  Simulation server (TypeScript, 20 Hz tick, in memory)
    ▲                                  │ validates inputs, runs physics and combat,
    └──── state snapshots ◀────────────┤ resolves conflicts by server authority
                                       │
                                       │ low-rate domain events, authenticated as system:
                                       ▼ MatchEnded(matchId, awards)
                             Charter progression module (transactional, verified)
                               Player XP · level · unlocks · match ledger
                                       │
                                       ▼ query PlayerProfile ──▶ clients (lobby, between matches)
```

| Concern | Owner | Mechanism |
|---|---|---|
| Movement, combat, hit detection | Simulation server | An authoritative tick loop. Clients send intents, never results. |
| Conflicts, such as two players grabbing one item | Simulation server | Inputs are ordered by server tick. The first input in tick order wins. Clients predict locally and reconcile to the server's snapshots. |
| Network events | Simulation server | WebSocket. Inputs are rate-limited and validated against the current simulation state. |
| XP, levels, unlocks | Charter | Rules callable only by `system`. Clients cannot call them at all. |
| Duplicate match reports | Charter | `RecordMatch` is idempotent on the external match id |
| Cheating on XP | Both | Clients have no path to progression rules. A compromised client can only send bad intents, which the simulation rejects. |

**Charter progression module** (conformance case `c005` holds a fixed version):

```
// [ILLUSTRATIVE]
module progression@0.1.0
principal Player by account
enum Ability { Dash, Shield, Blink }
entity Player { account: Id<idn.Account>, xp: Int where >= 0 = 0, level: Int where >= 1 = 1 }
entity Unlock { player: Id<Player>, ability: Ability }
entity Match  { ext: Text }
type Award = { player: Id<Player>, xp: Int where it >= 0 and it <= 1000 }

fn levelFor(xp: Int where >= 0): Int where >= 1 =                                   // Q-2 default, inferred
  if xp >= 4500 then 10 else if xp >= 3600 then 9 else if xp >= 2800 then 8
  else if xp >= 2100 then 7 else if xp >= 1500 then 6 else if xp >= 1000 then 5
  else if xp >= 600 then 4 else if xp >= 300 then 3 else if xp >= 100 then 2 else 1
fn unlockLevel(a: Ability): Int = match a { Dash => 2, Shield => 5, Blink => 8 }

rule RecordMatch(ext: Text, awards: List<Award>)
  permit system
  guard not exists m in Match: m.ext == ext else reject AlreadyRecorded            // idempotency
  create Match { ext = ext }
  for a in awards {
    let pl = Player[a.player]
    if pl != none {
      set pl.xp = pl.xp + a.xp
      set pl.level = levelFor(pl.xp)
      for ab in [Dash, Shield, Blink] {
        if unlockLevel(ab) <= pl.level and not exists u in Unlock: u.player == pl.id and u.ability == ab {
          create Unlock { player = pl.id, ability = ab }
        }
      }
    }
  }

invariant LevelMatchesXP: Player.level == levelFor(Player.xp)
invariant UnlocksEarned: forall u in Unlock: exists p in Player: p.id == u.player and unlockLevel(u.ability) <= p.level
```

**Problems this sketch exposes.** These are honest findings for the spec, not hidden flaws:

1. **`rejects` is missing.** `RecordMatch` rejects with `AlreadyRecorded`, but it declares no error enum. The checker would flag this. The fix is trivial.
2. **`set` through an optional binding is unspecified.** `let pl = Player[a.player]` gives a `Player?`. Writing through it after the `pl != none` check relies on narrowing turning an optional entity into an entity binding that `set` accepts. Phase 2 doesn't say whether that's allowed. It needs a rule.
3. **Reads inside a loop see earlier writes.** If one award list holds the same player twice, the second iteration sees the first one's update. That is consistent with the semantics, but it should be documented, or duplicate players should be rejected with a guard.
4. **Some properties span two states.** "Levels never decrease" compares a value before and after a step, and state invariants cannot express that. It needs either `old(…)` in invariants or a property test. Until then it is listed as **runtime-tested only**.
5. **Loop verification.** The nested `for` loops fall outside the bulk-operation idioms, so `LevelMatchesXP` and `UnlocksEarned` come back Unproven for `RecordMatch` and keep runtime checks. A verifier that summarized "for each, set" loops could recover them.

Milestone 0 found one more: the module uses `idn.Account` without importing `identity`. The conformance case adds the import.

**Throughput.** Matches end rarely compared with ticks. Suppose 1,000 concurrent matches each last 10 minutes. That is about 1.7 `RecordMatch` steps per second, well within a single SQLite writer's capacity. The single-writer limit from Phase 4 only bites if progression events become per-kill and real-time. The design deliberately keeps them per-match.

**What Charter would need in order to own the simulation itself.** These go on the Phase 9 roadmap:
- `tick` rules with an explicit time budget per tick;
- in-memory state with periodic snapshots;
- state partitioned per match, so writers don't contend;
- deterministic lockstep replay of inputs.

**Gloss of RecordMatch:** "Only the game server may record a match. Each match is recorded once. Repeats are rejected. Each award adds XP to the player. Their level is recalculated from total XP, and every ability whose level they've now reached is unlocked once. Levels always match XP (checked at runtime), and every unlock was earned (checked at runtime)."

---

## Summary across the five examples

| Example | What the verifier found | Proven | Runtime-checked or assumed | Spec amendments |
|---|---|---|---|---|
| 1. Calculator | Nothing wrong. Division by zero was ruled out statically. | Division safety, Add and Sub in range | Mul and Div range | A13 |
| 2. Task manager | Nothing wrong. Showed how a schema change ripples. | All asserts, title refinement, referential integrity | Persistence (runtime suite) | A8 |
| 3. REST API | **Dangling collaborators on delete** | All asserts, referential integrity | Login security (`identity` module) | A9, A10 |
| 4. Inventory | **Zero-amount charge**, turned into requirement R-8 | Stock never negative, under concurrency, by induction | Adapter idempotency, liveness | A11, A12 |
| 5. Multiplayer | Five gaps in the spec | Idempotency guard | Progression invariants, the whole simulation | Pending |

In both bug-finding cases, the verifier caught a real defect that a plausible first draft contained. In both cases the fix either strengthened the program or became a question for the human. Neither was resolved silently. That is the pattern H3 predicts, though five hand-derived examples are evidence for the design, not proof of it.

## Checkpoint

**Decisions:**
- Amendments A8 through A13: `select`, `permit system`, `principal … by`, ids that cannot be guessed, `confirm` blocks, tests with several acts plus `effects`, and the Decimal range with a minimal standard library.
- Authentication lives in a vetted `identity` module, not in generated code.
- Example 4's design is to reserve, then charge, then confirm or compensate. "No charge on rejection" holds by the semantics, and "stock never negative" has an inductive proof sketch that covers concurrency.
- Real-time games are split by timescale. Charter owns durable, verified progression, and a TypeScript simulation owns ticks.

**Open questions:**
- **Comparing outcomes in tests.** `result == ok` in example 3's property isn't valid under the grammar. The likely fix is an outcome-valued `result`.
- **Writing through narrowed optional entities.** This is gap 2 from example 5.
- **Two-state invariants** using `old(…)`, needed for "levels never decrease" and "order status only moves forward".
- **Loop summaries beyond bulk delete.** How many idioms should the verifier recognize before loops simply fall back to runtime checks?

**Risks:**
- **The amendment rate.** Six amendments came from five small examples. That is expected at this stage, but the grammar is now around 65 productions, above the target from Phase 1. Phase 8 must freeze a version before the H1 pilot, or the experiment will measure a moving target. (Milestone 0 measured the frozen grammar at 74 syntactic rules; see Errata.)
- **Hand derivation may be optimistic.** Real SMT encodings of quantifiers over tables, especially `CanView`, may time out where the hand derivations assume success. The first implementation milestone should check example 3's asserts with a real solver as early as possible.
- **Assumptions concentrate in adapters and the `identity` module.** The strongest guarantees in example 4 rest on the payment adapter's idempotency. The conformance suite for adapters is therefore as important as the verifier.
