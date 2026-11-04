# Phase 2: Core language specification (MVP subset)

Everything labeled `[SPEC]` was normative for Charter 0.1 when this phase was written. Later phases amend it, and the grammar in 2.7 is superseded by `spec/charter.ebnf` (see Errata). When this phase was written no parser existed, so the grammar's consistency had only been reviewed by hand. Milestone 0 later checked it with tools.

This phase also settles the four open questions from Phase 1:

| Phase 1 question | Decision |
|---|---|
| When are invariants checked? | Statically for each pair of rule and invariant. Runtime checks remain only for pairs the verifier could not prove. |
| Which isolation level? | Serializable. The MVP runtime gets it for free by using a single writer per database. |
| What if a compensation fails? | The effect is marked Stuck and the runtime raises a system event for an operator. Nothing further happens automatically. |
| Do node hashes cover requirement links? | No. Links live in a separate edge table, so re-linking a requirement never changes a node's identity. |

## 2.1 Execution model

A **program** is one module. It contains a state schema, made of entities and types, plus rules, permissions, invariants, events, triggers, queries, tests and requirements.

**State** maps each entity type to a finite table of records keyed by a system-assigned `Id<E>`. There are no global variables. All mutable state lives in entities.

A **step** is one call to one rule, by one caller, with arguments. A step is a serializable transaction that always terminates. Termination is guaranteed because all iteration is bounded and recursion is structural.

**What happens outside a step:**
- **Effects** run after commit. They go through a durable outbox, carry idempotency keys, and can declare compensations.
- **Events** raised during a step are queued on commit. Each triggered rule runs later as its own step. Nothing runs in the same transaction.
- **Queries** are read-only and run against a consistent snapshot.

**Determinism.** Each step reads `now` and a random seed exactly once, and both values are logged. Iteration order is by ascending `Id`, and map order is by key. New ids are derived from the step id and a counter. Replaying the step log from a snapshot therefore reproduces the state bit for bit.

## 2.2 Program structure

| Construct | Purpose | Can read state | Can change state | Can cause effects |
|---|---|---|---|---|
| `entity` | Declares a stored record type. `id` is implicit. | n/a | n/a | n/a |
| `type`, `enum` | Declares a value type or a sum type | n/a | n/a | n/a |
| `fn` | A pure, total function over values | No | No | No |
| `extern fn` | A pure function written in the host language, assumed total and unverified | No | No | No |
| `permission` | A named Boolean predicate over the caller, arguments and state | Yes | No | No |
| `rule` | The only way to change state | Yes | Yes | Yes, if declared |
| `invariant` | A predicate that must hold after every commit | Yes | No | No |
| `event`, `on … do` | An internal signal and the trigger that reacts to it | n/a | Via its rule | Via its rule |
| `query` | A read-only, permission-checked read | Yes | No | No |
| `test`, `property` | An example test and a generated test | Yes | Yes, in a sandbox | Effects are mocked |
| `requirement` | Requirement text with a status | n/a | n/a | n/a |
| `uses` | Declares which external capabilities the module may call | n/a | n/a | n/a |
| `migration` | Moves the schema from one version to the next | Yes | Yes | No |

## 2.3 Type system

**Primitives:**
- `Bool` is a true or false value.
- `Int` is a signed 64-bit integer. Overflow is a fault that aborts the step. (Amendment A4 later narrows this to the safe-integer range for the MVP.)
- `Decimal` is fixed-point with 18 fractional digits. Addition, subtraction and multiplication are exact. Division rounds half to even.
- `Money` is a `Decimal` with 2 fractional digits, in one currency set per program. Multiplying Money by a number rounds half to even. That rounding rule is a default, and the AI marks it `inferred` in every program that uses Money.
- `Text` is a Unicode string.
- `Time` is a UTC instant, and `Duration` is a span of time.

**Composite types:**
- `List<T>`, `Set<T>` and `Map<K,V>` are immutable values.
- Record types are written `{ f: T, … }`.
- `enum` declares a sum type whose variants may carry payloads.
- `T?` is an optional value. Its tools are `none`, the `??` default operator, and narrowing after a check against `none`.

**References.** `Id<E>` refers to an entity. Every field of type `Id<E>` carries an implicit referential-integrity invariant, which says the target exists. A field of type `Id<E>?` is exempt.

**Refinement types.** A refinement type is written `T where φ`. The short form `Int where >= 0` means `it >= 0`. Refinement predicates must fall in the decidable fragment of 2.8. Refinements behave in three ways:
- On a **parameter**, a refinement is a precondition checked at the call boundary. Failure rejects the call with `ValidationError`.
- On an **entity field**, a refinement is an invariant.
- **Inside expressions**, refinements flow by narrowing. After `guard b != 0`, the variable `b` has type `Int where != 0`.

**Deliberately absent:** user generics, higher-order functions, subclassing and floating point. Quantifiers and aggregates cover most of what lambdas would otherwise do. These cuts serve H1 and H3 together, since they leave fewer ways to write the same thing and keep proofs decidable.

## 2.4 Effects and capabilities

- **Capabilities** are named `Service.operation`, for example `Payment.charge`. The runtime supplies each one through an adapter bound in deployment config. The MVP ships `Payment.charge`, `Payment.refund`, `Http.post`, `Mail.send` and `Log.write`.
- **Declaration.** A module lists its allowed capabilities in a `uses` declaration.
- **Inference.** A rule's effect set is the set of capabilities it emits. It is inferred, not written by hand.
- **Compile-time rejection.** Every rule's effect set must be a subset of the module's `uses` list. Functions, permissions, invariants and queries must have no effects.
- **Ambient reads.** `now` and randomness are fixed per step and logged. They are allowed in rules only.
- **Compensations** may change state but may not emit effects. This keeps failure handling one level deep.
- **Runtime enforcement.** The runtime refuses any capability call that is not in the compiled manifest. This is defense in depth against a compiler bug.

## 2.5 Control flow, iteration, errors and transactions

**Control flow.** Rules have clause-level `if … { } else { }` and `guard c else reject E`. Expressions have `if … then … else` and exhaustive `match`.

**Iteration is always bounded.** `for x in coll` and the quantifiers `forall`, `exists`, `count` and `sum` range over finite collections or entity tables. There is no `while`. Bounded steps keep transactions short and make SMT encoding tractable. Long processes become chains of events instead.

**Recursion** is allowed only in `fn`. It must be structural: every recursive call takes a strict subterm of a pattern-bound parameter, and the checker enforces this.

**Every step ends in exactly one outcome:**

| Outcome | Cause | State change |
|---|---|---|
| `Ok(v)` | All checks pass | Committed |
| `reject E` | A guard fails, with a variant of the rule's declared `rejects` enum | None |
| `Denied` | The permit evaluates to false | None |
| `NotFound` | An entity argument does not exist | None |
| `ValidationError(param)` | A parameter refinement fails | None |
| `Conflict` | Retries were exhausted (unused under a single writer) | None |
| `InvariantViolated(name)` | A bug: an invariant failed at commit | None, and the step is logged as a defect |
| `Fault(kind)` | Overflow, or a failure inside an extern function | None |

Rejections are expected business outcomes and must be declared. Violations and faults are bugs. The checker tries to prove they cannot happen.

## 2.6 Scoping, modules and versioning

- **Scoping.** Each module has one flat namespace for top-level names across all kinds. `let` bindings scope from their own point to the end of the rule. **No shadowing anywhere.** Unique names make anchor matching reliable, as 2.9 explains, and remove a common source of AI confusion.
- **Immutability.** Values are immutable. Only entity fields change, and only through `set` inside rules.
- **Modules** are declared as `module shop@1.2.0`. Imports name a version range, as in `import billing@^1.0 as bill`. A lockfile pins each import's content hash.
- **Breaking changes are detected mechanically.** Removing or retyping a field, or tightening a refinement, requires a `migration` block and a new major version.

## 2.7 Formal grammar (EBNF)

> **Superseded.** This is the grammar as designed in Phase 2. The normative grammar is `spec/charter.ebnf` (version 0.1, frozen in milestone 0), which merges amendments A2, A8, A9, A11, A12 and A14 to A20. The Errata section lists what changed and why.

The grammar has about 60 productions and is LL(1) in context. The parser is recursive descent. Clause-level `if` and expression-level `if` are told apart by context, not by lookahead. Whitespace and `//` comments are ignored. All keywords used below are reserved.

```ebnf
(* [SPEC] Charter 0.1 grammar, Phase 2 version (superseded by spec/charter.ebnf) *)
program      = module_decl { import } { decl } ;
module_decl  = "module" qname "@" version ;
import       = "import" qname "@" verspec [ "as" ident ] ;
decl         = requirement | uses | principal | type_decl | enum_decl | entity
             | fn_decl | extern_fn | permission | rule | event | trigger
             | invariant | query | test | property | migration ;

requirement  = "requirement" req_id status string ;
status       = "confirmed" | "inferred" | "open" ;
uses         = "uses" capability { "," capability } ;
capability   = ident "." ident ;
principal    = "principal" ident ;                       (* names the caller's entity type *)

type_decl    = "type" ident "=" type ;
enum_decl    = "enum" ident "{" variant { "," variant } "}" ;
variant      = ident [ "(" field_list ")" ] ;
entity       = "entity" ident "{" field_list "}" [ links ] ;
field_list   = field { "," field } ;
field        = ident ":" type [ "=" expr ] ;

type         = base [ "?" ] [ "where" refinement ] ;
base         = "Bool" | "Int" | "Decimal" | "Money" | "Text" | "Time" | "Duration"
             | "Id" "<" ident ">" | "List" "<" type ">" | "Set" "<" type ">"
             | "Map" "<" type "," type ">" | "{" field_list "}" | ident ;
refinement   = cmp_op coalesce | expr ;                  (* expr form uses 'it' *)

fn_decl      = "fn" ident "(" [ params ] ")" ":" type "=" expr [ links ] ;
extern_fn    = "extern" "fn" ident "(" [ params ] ")" ":" type ;
params       = param { "," param } ;
param        = ident ":" type ;
permission   = "permission" ident "(" [ params ] ")" "=" expr [ links ] ;

rule         = "rule" ident "(" [ params ] ")" [ ":" type ] [ "rejects" ident ]
               permit { clause } [ links ] ;
permit       = "permit" ( "anyone" | expr ) [ links ] ;
clause       = ( "let" ident "=" expr
               | "guard" expr "else" "reject" ident
               | "set" lvalue "=" expr
               | "create" ident "{" [ assigns ] "}" [ "as" ident ]
               | "delete" expr
               | "for" ident "in" postfix "{" { clause } "}"
               | "if" expr "{" { clause } "}" [ "else" "{" { clause } "}" ]
               | "emit" capability "(" [ args ] ")" [ "compensate" "{" { clause } "}" ]
               | "raise" ident "(" [ args ] ")"
               | "return" expr ) [ links ] ;
lvalue       = ident "." ident { "." ident } ;

event        = "event" ident "(" [ params ] ")" ;
trigger      = "on" ident "(" [ ident { "," ident } ] ")" "do" ident "(" [ args ] ")"
               [ "as" "system" ] [ links ] ;
invariant    = "invariant" ident ":" expr [ links ] ;
query        = "query" ident "(" [ params ] ")" ":" type permit "=" expr [ links ] ;

test         = "test" string "{" { given } act "}" ;
property     = "property" string "forall" params [ "where" expr ] "{" { given } act "}" ;
given        = "given" ident "=" "create" ident "{" [ assigns ] "}" ;
act          = "when" ident "(" [ args ] ")" [ "as" expr ] "expect" outcome { "then" expr } ;
outcome      = "ok" | "reject" ident | "any" ;

migration    = "migration" version "->" version "{" { mig_op } "}" ;
mig_op       = "add" ident "." ident ":" type "=" expr
             | "rename" ident "." ident "to" ident
             | "drop" ident "." ident ;

links        = "req" req_id { "," req_id } ;

(* expressions, lowest to highest precedence *)
expr         = "if" expr "then" expr "else" expr
             | "match" expr "{" arm { "," arm } "}"
             | ( "forall" | "exists" ) ident "in" postfix ":" expr
             | "count" ident "in" postfix [ "where" expr ]
             | "sum" or_expr "for" ident "in" postfix [ "where" expr ]
             | or_expr ;
arm          = pattern "=>" expr ;
pattern      = "_" | ident [ "(" ident { "," ident } ")" ] ;
or_expr      = and_expr { "or" and_expr } ;
and_expr     = not_expr { "and" not_expr } ;
not_expr     = [ "not" ] cmp_expr ;
cmp_expr     = coalesce [ cmp_op coalesce ] ;            (* non-associative *)
cmp_op       = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ;
coalesce     = add_expr { "??" add_expr } ;
add_expr     = mul_expr { ( "+" | "-" ) mul_expr } ;
mul_expr     = unary { ( "*" | "/" | "%" ) unary } ;
unary        = [ "-" ] postfix ;
postfix      = primary { "." ident | "(" [ args ] ")" | "[" expr "]" } ;
primary      = literal | ident | "caller" | "now" | "it" | "result"
             | "old" "(" expr ")" | "(" expr ")" | "[" [ args ] "]" | "{" assigns "}" ;
args         = expr { "," expr } ;
assigns      = ident "=" expr { "," ident "=" expr } ;
literal      = int | decimal | string | duration | "true" | "false" | "none" ;

(* lexical *)
ident        = letter { letter | digit | "_" } ;
qname        = ident { "." ident } ;
req_id       = "R-" digit { digit } ;
version      = digit { digit } "." digit { digit } "." digit { digit } ;
verspec      = [ "^" | "~" ] version ;
```

**Desugaring rules:**
- **Short-form invariants.** In an invariant with no binder in scope, a path `E.f` where `E` names an entity type becomes `forall x in E: x.f`. Only one entity type may appear in a short-form invariant. Anything else must be written out in full.
- **Entity tables.** Inside contexts that can read state, a bare entity type name `E` stands for its current table. `E[id]` returns `E?`.
- **Entity parameters.** A parameter of type `p: Product` is passed as an id and loaded at the start of the step. A missing entity rejects the call with `NotFound`.
- **Restricted primaries.** `old(e)` and `result` may appear only in `then` clauses of tests and properties.

## 2.8 Semantics

### Static typing `[SPEC]`

A typing judgment has the form `Γ; Φ ⊢κ e : τ`. Here `Γ` is the type environment and `Φ` is the set of known facts. The context kind `κ` is one of `fn` (pure), `read` (permissions, invariants and queries) or `rule`.

```
[SPEC] Selected typing rules
(T-Field)  Γ;Φ ⊢κ e : E    f:τ ∈ fields(E)    κ ≠ fn          ⟹  Γ;Φ ⊢κ e.f : τ
(T-Arith)  Int⊕Int:Int   Decimal⊕Decimal:Decimal   Money±Money:Money
           Money*Int:Money   Money*Decimal:Money   (all other mixes: type error)
(T-Div)    Γ;Φ ⊢ a:N   Γ;Φ ⊢ b:N   Φ ⊨ b ≠ 0   N ∈ {Int, Decimal} ⟹  a / b : N
(T-Sub)    Γ;Φ ⊢ e:τ   Φ ⊨ φ[e/it]                             ⟹  e : τ where φ
(T-Forget) e : τ where φ                                        ⟹  e : τ
(T-Guard)  guard c else reject E  continues checking with  Φ ∧ c ;  E ∈ rejects(r)
(T-If)     then-branch checked under Φ ∧ c ; else-branch under Φ ∧ ¬c
(T-Set)    κ = rule   lvalue rooted at an entity binding   Γ;Φ ⊢ e : base(τ_f)
           ⟹ ok ; the refinement of f becomes an invariant obligation (2.8, verification)
(T-Emit)   cap ∈ uses(M)   args match sig(cap)   compensation has no emit
           ⟹ effects(r) ∪= {cap}
(T-Rule)   permit present ∧ all clauses ok ∧ effects(r) ⊆ uses(M)
(T-Rec)    each recursive call in fn passes a strict subterm of a pattern-bound parameter
```

**Checking `Φ ⊨ ψ`.** An SMT solver checks facts in the decidable fragment: linear arithmetic over integers and rationals, equality, and uninterpreted functions. The time limit is 2 seconds. (Amendment A5 later replaces this with a deterministic resource limit.)
- An **unproven `T-Div` or `T-Sub`** is a compile error. The error comes with a fix hint, usually "add a guard". This is the main mechanism behind H3.
- An **unproven invariant obligation** is a warning. The invariant falls back to a runtime check, and the build report lists it as such.

**Other static checks:**
- Every rule has a permit clause, so access is denied by default.
- Matches must be exhaustive.
- The trigger graph must be acyclic.
- Invariants, permissions and queries must be read-only.
- Every requirement link must resolve.
- **Release gate.** A build with `--release` fails if any linked requirement is still `inferred` or `open`. A development build only warns.

### Operational semantics of a step `[SPEC]`

The runtime configuration is `⟨S, O, Q, L⟩`. It holds the state, the effect outbox, the event queue and the step log.

```
[SPEC]
[STEP-OK]
  refine(params(r)) holds for args                ⟦permit(r)⟧(S, caller, args) = true
  ⟨clauses(r), S, [], []⟩ ⇓ ⟨W, F, V, ok v⟩          ∀ i ∈ Inv \ Proven(r) : ⟦i⟧(W) = true
  ────────────────────────────────────────────────────────────────────────────────────
  ⟨S,O,Q,L⟩ ──r(args) by caller──▶ ⟨W, O·keyed(F), Q·V, L·⟨r,args,caller,now,seed,Ok v⟩⟩

[STEP-REJECT]   any premise above fails, or clause evaluation yields reject E / fault k
  ⟨S,O,Q,L⟩ ──r(args)──▶ ⟨S, O, Q, L·⟨…, outcome⟩⟩            (state, outbox, queue unchanged)

Clause evaluation  ⟨c·cs, W, F, V⟩ ⇓ …   (W is a working copy; reads see the step's own writes)
  guard e else reject E  :  ⟦e⟧W = false ⟹ reject E ;  else continue
  set x.f = e            :  W := W[x.f ↦ ⟦e⟧W]
  create E{…} as x       :  fresh id = H(stepId, n) ; W := W ∪ {id ↦ record} ; bind x
  delete e               :  W := W \ {⟦e⟧W}   (referential-integrity invariants catch dangling refs)
  for x in e {cs}        :  iterate over ⟦e⟧ evaluated once at loop entry, in ascending Id order
  emit cap(a) compensate k :  F := F · ⟨cap, ⟦a⟧W, k, idx⟩
  raise Ev(a)            :  V := V · ⟨Ev, ⟦a⟧W⟩
  return e               :  stop and yield ok ⟦e⟧W
```

**Effect dispatch.** Dispatch is asynchronous and separate from steps. It processes outbox entries in commit order.

| Result | What happens |
|---|---|
| Success | The entry is marked done. |
| Transient failure | It retries with exponential backoff and the same idempotency key `(stepId, idx)`. |
| Retries run out, or a permanent failure | The compensation `k` runs as a new step under the system principal, against current state. The compensation is checked against invariants like any other step. |
| The compensation itself aborts | The entry is marked `Stuck`. The runtime raises `system.CompensationFailed`, which needs an operator. |

Compensations see current state, not the snapshot from the original step. Restoring stock with `p.stock + qty` is then correct even if other orders happened in between.

**Concurrency.** Steps are serializable. The MVP gets this from a single writer per program database, using SQLite in WAL mode. Optimistic concurrency with read-set validation is a post-MVP option that keeps the same semantics.

### Invariant verification `[SPEC]`

For each pair of rule `r` and invariant `I`, the verifier builds this proof obligation:

```
I(S) ∧ refine(args) ∧ permit(r) ∧ path-condition(r)  ⟹  I(W)
```

It does this for every path through the rule's clauses, and it encodes `W` as a symbolic update of `S`.

**Two kinds of invariant:**
- **Local invariants** have the form `forall x in E: φ(x)`, where `φ` reads only `x`'s fields. The verifier uses frame reasoning: only entities the rule writes can change, so it checks just those. This is the common case, including all field refinements.
- **Non-local invariants** involve aggregates, joins or other entities. The verifier tries them, and on a timeout they fall back to runtime checks.

Each pair ends in one of three results:

| Result | Meaning | Effect on the build |
|---|---|---|
| `Proven` | The solver proved the obligation | The runtime check is skipped |
| `Unproven` | Timeout or an unsupported fragment | The runtime check stays, with a warning |
| `Refuted` | The solver found a counterexample | Compile error, and the counterexample is shown as a concrete state and arguments |

## 2.9 Semantic graph, serialization and node identity `[SPEC]`

The graph is authoritative. The text form and the JSON form are both projections of it, and they convert to each other deterministically.

```ts
// [SPEC] stored as program.charter.json
type Program = {
  module: string; version: string;
  root: Anchor;
  nodes: Record<Anchor, Node>;
  requirements: { id: string; status: "confirmed" | "inferred" | "open"; text: string }[];
  links: [Anchor, string][];          // node → requirement; excluded from hashes
};
type Node = {
  anchor: Anchor;                     // stable identity: assigned at creation, never reused
  kind: NodeKind;                     // "Rule" | "Guard" | "Set" | "Emit" | "BinOp" | ...
  attrs: Record<string, string | number | boolean>;   // name, operator, literal
  children: Anchor[];                 // ordered
  hash: string;                       // semantic hash, defined below
};
```

**Node identity uses two keys:**
- **The anchor answers "is this the same node?"** It survives edits, so "this guard was tightened" stays a single, local change.
- **The hash answers "did its meaning change?"** The hash is SHA-256 over a deterministic CBOR encoding (RFC 8949, section 4.2) of the node's kind, its attributes, its children's hashes, and the hashes of every declaration it references. Because referenced declarations count, a change ripples into the hash of everything that depends on it, as in Unison.
- **Excluded from the hash:** anchors, requirement links, comments and source positions.

**This makes H2 testable.** A declaration is unaffected by a change exactly when its transitive hash did not change. Phase 3 builds the impact report on this rule.

**How the text form keeps anchors:**
- The text form is canonical, printed by a single formatter, and holds no anchors.
- `parse(print(G)) = G` up to anchors.
- When a human edits text, anchors are reassigned. Declarations match by name, which is reliable because shadowing is banned. Clauses and expressions match by a tree-diff algorithm in the style of GumTree.
- **AI edits never go through text.** They are typed graph operations that address anchors directly, such as `replace_expr(anchor, expr)`, `insert_clause(rule, index, clause)`, `rename(anchor, name)` and `link(anchor, req)`. After every operation the full checker runs again. Phase 3 defines the complete set.

## 2.10 Conformance example `[ILLUSTRATIVE]`

This example was written to the grammar above. Milestone 0 confirmed that it parses under the frozen grammar (conformance case `c006-phase2-shop`). Note two changes from the Phase 1 sketch. `caller` replaces the customer parameter, and invariants now have names.

```
// [ILLUSTRATIVE] parses under spec/charter.ebnf (conformance case c006)
module shop@0.1.0
uses Payment.charge
principal Customer

requirement R-1 confirmed "Never allow inventory to become negative."
requirement R-2 confirmed "If there isn't enough stock, reject the order without charging the customer."
requirement R-3 inferred  "Only active customers may place orders."

entity Customer { name: Text, active: Bool = true }
entity Product  { name: Text, price: Money where >= 0, stock: Int where >= 0 } req R-1
enum OrderError { OutOfStock }

rule PlaceOrder(p: Product, qty: Int where > 0) rejects OrderError
  permit caller.active req R-3
  guard p.stock >= qty else reject OutOfStock req R-2
  set p.stock = p.stock - qty
  emit Payment.charge(caller.id, p.price * qty)
    compensate { set p.stock = p.stock + qty }
  req R-1, R-2

invariant StockNonNegative: Product.stock >= 0 req R-1

property "stock drops by exactly qty or not at all"
  forall qty: Int where > 0 {
    given p = create Product { name = "Mug", price = 5.00, stock = 3 }
    when PlaceOrder(p, qty) expect any
    then p.stock == old(p.stock) - qty or p.stock == old(p.stock)
  }
```

What the checker would conclude, worked out by hand and not run:
- **`StockNonNegative` is `Proven` for `PlaceOrder`.** Under the guard, `p.stock ≥ qty` holds, so `p.stock - qty ≥ 0`.
- **It is `Unproven` for the compensation.** Adding a positive `qty` keeps stock non-negative, but proving it requires the parameter refinement `qty > 0` to carry into the compensation's context. Whether captured parameter refinements carry over is still an open question. (Amendment A3 in Phase 3 settles it, making this pair `Proven`.)
- **The release gate fails** until R-3 is confirmed, because R-3 is `inferred`. The rounding rule for Money is a second inferred default.

## 2.11 Out of the MVP

| Deferred | Why it waits | Workaround for now |
|---|---|---|
| User-defined effects and effect handlers | Too big a semantic surface | Use the fixed capability set |
| User generics, higher-order functions, traits | They make generation and checking harder | Use quantifiers, aggregates and built-in collections |
| Floating point | It defeats exact reasoning | Use `Decimal` |
| More than one currency | Needs currency in the type | Use one currency per program |
| Optimistic concurrency, sharding, transactions across databases | Not needed for correctness | Use a single writer |
| Scheduled and tick rules, real-time networking | Needed only for example 5 | Treated at design depth in Phase 5 |
| Triggers in the same transaction | Breaks the one-step, one-rule model | Use events |
| Regex, string formatting, time zones | Library-level features | Use `extern fn` |
| Formal proofs of `extern fn` | Out of scope | Report them as unverified |
| UI | Not part of the core language | Target code exposes an API |

## Checkpoint

**Decisions:**
- A step is a serializable transaction that always terminates. Effects go through a post-commit outbox with idempotency keys and compensations. Events start separate steps.
- The type system uses refinement types and narrowing through guards. Unprovable division and refinement obligations are compile errors.
- Invariant checks run per rule and per invariant: proven, unproven with a runtime check, or refuted with a counterexample.
- There is no shadowing and no `while`, and recursion must be structural.
- The graph is the source of truth. Anchors carry identity, and transitive semantic hashes detect change.
- AI edits are graph operations, never text rewrites.
- `--release` fails while any linked requirement is `inferred` or `open`.

**Open questions:**
- Should parameter refinements carry into compensation contexts? Yes looks safe because the values are captured, but the semantics need checking.
- Should Money's rounding be one program-wide setting or chosen at each use?
- Should `for` over a whole entity table have a size cap, to keep steps short?
- Do audit logs need a same-transaction escape hatch? `Log.write` through the outbox could lose ordering relative to the state change.

**Risks:**
- **The decidable fragment may be too narrow.** Real permission rules often use set membership, such as "user in project.collaborators". That needs array or set theories in the solver, which can be slower. Mitigation: measure on the examples in Phase 5.
- **Text-edit anchor matching can misattribute changes.** That would corrupt H2 measurements. Mitigation: measure H2 only on graph-operation edits, and treat text edits as a secondary interface.
- **A single writer caps throughput.** That is acceptable for the MVP and examples 1 through 4. It is not acceptable for example 5.
- **The grammar is already about 60 productions,** which is at the edge of what Phase 1 promised for constrained decoding. Mitigation: freeze it, and add features through the library rather than new syntax.
