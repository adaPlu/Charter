# Phase 4: Compiler, runtime, verification and safety

Nothing here has been compiled or run. Throughput numbers are estimates to be measured in Phase 8.

## 4.0 Amendments

| ID | Amendment | Why |
|---|---|---|
| A4 | In the MVP, `Int` covers the safe integer range of ±(2⁵³ − 1), not 64 bits. Leaving that range is an overflow fault. | The target is JavaScript, where numbers are exact only up to 2⁵³. Using bigint everywhere would be slow and would complicate the generated code. A full 64-bit `Int` can return with the Wasm target. |
| A5 | The verifier uses Z3's deterministic **resource limit** instead of the 2-second wall-clock timeout from Phase 2. Proof results are cached in the repository, keyed by the hash of each obligation. | Wall-clock timeouts differ between machines. A proof could pass on a laptop and time out in CI, and that would change the build output. Reproducible builds need verification results that do not depend on timing. |
| A6 | Each capability declares how it is delivered: `idempotent`, which allows retries, or `at-most-once`. A call that ends ambiguously, such as a timeout, gives the result `Unknown`. | A payment timeout is the dangerous case. Retrying might charge twice, and assuming failure might release goods without payment. `Unknown` sends the call to an operator instead of guessing. |
| A7 | A new step outcome, `Disabled`, is returned when an operator has switched off a rule at runtime. | This adds a kill switch for an incident without needing a new deployment. |

## 4.1 Compiler pipeline

Every stage is deterministic, and none of them uses an LLM.

| # | Stage | Input | Output | Fails on |
|---|---|---|---|---|
| 1 | Load | Graph JSON, or canonical text that is parsed | Semantic graph | Syntax errors, broken anchors |
| 2 | Resolve | Graph | Names bound to anchors, plus the behavioral dependency graph from A1 | Unknown names, shadowing, cycles in imports or triggers |
| 3 | Type and effect check | Resolved graph | Typed graph, effect sets, refinement obligations | Type errors, effects missing from `uses`, rules with no permit |
| 4 | Verify | Obligations | Proven, Unproven or Refuted for each obligation, plus a proof cache | Unproven division or refinement, refuted invariant or assert |
| 5 | Lower | Typed graph and proof results | Charter IR, abbreviated CIR | Nothing; this stage cannot fail if 1 through 4 passed |
| 6 | Optimize | CIR | Optimized CIR | Nothing |
| 7 | Generate code | CIR | TypeScript modules, SQL schema, an HTTP layer, a typed client | Nothing |
| 8 | Package | All of the above | Build artifact, capability manifest, build report, build hash | Release gate: anything still `inferred` or `open` |

**Charter IR.** Each rule lowers to one transaction body made of explicit steps. Expressions are flattened so every intermediate value has a name.

```
// [ILLUSTRATIVE] CIR for PlaceOrder (Phase 2 example), after optimization
step PlaceOrder(p_id: Id<Product>, qty: Int) caller c
  b0:  check_refine qty > 0                  else ValidationError("qty")
       %p   = load Product p_id              else NotFound
       %c   = load Customer c
       check %c.active                       else Denied          // permit, R-3
       %ok  = ge %p.stock, qty
       check %ok                             else reject OutOfStock   // R-2
       %ns  = sub %p.stock, qty               // fault on overflow (A4)
       write Product p_id .stock = %ns
       %amt = mul_money %p.price, qty
       emit Payment.charge(%c.id, %amt) key=(step, 0) comp=#k0
       // inv StockNonNegative: Proven for this rule, so no runtime check is emitted
       commit
comp #k0(p_id, qty)                            // runs later as a system step
       %p  = load Product p_id               else Stuck
       %ns = add %p.stock, qty
       write Product p_id .stock = %ns
       // inv StockNonNegative: Proven via A3
       commit
```

**Optimizations.** Each one must preserve the semantics of Phase 2.

| Optimization | What it does |
|---|---|
| Drop proven checks | Skips the runtime check for every rule and invariant pair the verifier proved |
| Frame-limited checks | Checks local invariants only on the entities this step actually wrote |
| SQL pushdown | Compiles `exists`, `count`, `sum` and `forall` over entity tables into SQL `WHERE` clauses and aggregates |
| Index inference | Adds an index for every equality predicate a quantifier or guard uses, such as `Collaborator(project, user)` |
| Constant folding and dead-branch removal | Uses facts already proven by the verifier |

**The reference interpreter is the oracle for the compiler.** It is a direct, unoptimized implementation of the Phase 2 operational semantics. Both the optimizer and the code generator are checked against it by differential testing, described in 4.5. The interpreter is also what tests run on during development, before any code is generated.

## 4.2 MVP target: TypeScript on Node.js with SQLite

| Target | Strengths | Weaknesses for the MVP | Verdict |
|---|---|---|---|
| **TypeScript on Node.js** | Readable generated code. A large HTTP ecosystem. Z3 has official JavaScript and Wasm bindings, so the compiler can verify in-process. SQLite in single-writer mode matches the semantics exactly. | Slower than native code. No built-in decimals, so Money and Decimal must be implemented as scaled integers. | **Chosen** |
| WebAssembly | Portable, sandboxed and fast. It could run steps embedded on mobile, at the edge or in browsers. | The host still has to provide the store, HTTP and adapters. Generated code is harder to debug. | **Second target.** Compile pure functions and step bodies to Wasm, with the store provided by the host. |
| LLVM or native code | Best raw performance | Too much effort for an app-shaped workload where database time dominates | Not before the language is stable |
| Python | Familiar, and good for data work | Slower, with a weaker type story for the generated code | Rejected |
| JVM | Mature runtime and concurrency | A heavier toolchain for little gain at MVP scale | Possible enterprise target later |
| Android | Reaches mobile devices | Should arrive through the Wasm target rather than as a separate backend | Via Wasm |

The chosen target also suits H4. When a human opens the Execution view, generated TypeScript is the target code they are most likely to read easily.

**How values are represented in generated code:**

| Charter type | TypeScript representation |
|---|---|
| `Int` | `number`, checked against the safe-integer range (A4) |
| `Decimal` | `bigint`, scaled by 10¹⁸ |
| `Money` | `bigint`, in the currency's smallest unit |
| `Text` | `string` |
| `Time`, `Duration` | Milliseconds as `number` |
| `Id<E>` | `string`, derived from the step id and a counter |
| Enums | Tagged unions |
| `T?` | `T \| null` |

## 4.3 Generated code shape

```ts
// [GENERATED-UNTESTED] key parts of generated code for PlaceOrder
export function step_PlaceOrder(rt: Runtime, caller: Id<"Customer">,
                                args: { p: Id<"Product">; qty: number }): Outcome<void, OrderError> {
  if (!(Number.isSafeInteger(args.qty) && args.qty > 0)) return validationError("qty");
  return rt.transaction("PlaceOrder", caller, args, (tx) => {     // BEGIN IMMEDIATE ... COMMIT
    const p = tx.load("Product", args.p);   if (!p) return notFound("p");
    const c = tx.load("Customer", caller);
    if (!c.active) return denied();                                // R-3
    if (!(p.stock >= args.qty)) return reject("OutOfStock");       // R-2
    tx.write("Product", args.p, { stock: checkedSub(p.stock, args.qty) });
    tx.emit("Payment.charge", [caller, mulMoney(p.price, args.qty)],
            { index: 0, compensation: "PlaceOrder#k0", captured: args });
    return ok(undefined);              // invariant StockNonNegative proven: no runtime check
  });
}
```

`rt.transaction` holds the step semantics in one place. It assigns the step id, fixes `now` and the random seed, writes the step log, inserts outbox rows in the same SQLite transaction, and rolls back on any non-Ok outcome.

**Generated around the rules:**
- **HTTP routes.** Each rule becomes a `POST /rules/<Name>` route, and each query becomes a `GET /queries/<Name>` route. JSON bodies are validated against parameter types and refinements.
- **Caller identity.** The caller comes only from an authenticator adapter. It never comes from request arguments, because `caller` is not a parameter and cannot be set.
- **A typed TypeScript client.** It is generated from the same signatures, so the front end and back end cannot drift apart.
- **SQL schema.** Each entity gets one table with one column per field. `CHECK` constraints are generated for local refinements, adding a database-level backstop.

## 4.4 Runtime services

| Service | Responsibility | Key design point |
|---|---|---|
| Store | SQLite in WAL mode. Entity tables plus system tables for steps, outbox, events, migrations and snapshots. | One writer connection. Steps are serialized through an in-process queue. Queries use separate read connections on a snapshot. |
| Step executor | Runs the Phase 2 semantics inside `BEGIN IMMEDIATE … COMMIT` | Runtime invariant checks run before `COMMIT`. Outbox rows commit in the same transaction, which is the transactional-outbox pattern. |
| Event dispatcher | Runs triggered rules as new steps after commit | Each triggered step records the id of the event it consumed in its own transaction, so each event changes state exactly once even when delivered more than once |
| Effect dispatcher | Executes outbox entries through adapters | It follows the dispatch table from Phase 2, plus A6. An idempotent capability is retried with the same key. An at-most-once capability is never retried after an ambiguous result. It becomes `Unknown` and goes to an operator. |
| Adapters | Payment, Http, Mail and Log | Contract: `invoke(args, key) → Ok \| Transient \| Permanent \| Unknown`. Every adapter has a test-mode twin that records calls. |
| Clock and randomness | Supplies `now` and a seed for each step | Both are written to the step log |
| Replay | Rebuilds state from a snapshot plus the step log | Compares the final state hash. A mismatch means non-determinism, which is treated as a bug in the compiler or runtime. |
| Migration runner | Applies `migration` blocks | **Always dry-runs on a copy first.** It migrates the copy, checks every invariant on every row, and reports. Only after that does it apply the migration for real, in one transaction with a schema version bump. |
| Operator controls | Kill switch per rule (A7), holds on the effect queue, and resolution of `Stuck` and `Unknown` entries | Every operator action is logged as a system step |
| Observability | One structured log line per step | Rule, caller, outcome, duration, runtime invariant checks executed, and effects queued |

**Concurrency in practice.** Two concurrent orders for the last unit are serialized by the single writer. The first commits with stock at 0. The second then reads stock 0, fails its guard, and is rejected with `OutOfStock`. Nothing is charged for it, because rejected steps queue no effects. Phase 5 turns this into a proof sketch.

**Throughput estimate, unmeasured.** A single SQLite writer on an SSD should handle roughly 1,000 to 10,000 small transactions per second. That is enough for examples 1 through 4. It is not enough for a busy multiplayer server, which Phase 5 addresses at design depth.

## 4.5 Verification stack

| # | Layer | Checks | When | Strength |
|---|---|---|---|---|
| 1 | Grammar | Syntax, with constrained decoding for AI output | Generation and load | Complete |
| 2 | Types and names | Types, no shadowing, exhaustive matches, structural recursion | Compile | Complete for the MVP type system |
| 3 | Refinements | Division by zero, parameter and field refinements | Compile, using SMT | Sound within the fragment. Anything unproven is a compile error. |
| 4 | Effects | Each rule's effects are within `uses`, and compensations emit nothing | Compile | Complete |
| 5 | Permissions | Every rule has a permit. Asserts are checked. Permission diffs on change. | Compile and change review, using SMT | Sound within the fragment |
| 6 | Invariants | Preservation for each rule and invariant pair, using frame reasoning | Compile, using SMT | Sound within the fragment. Unproven pairs become runtime checks. |
| 7 | Consistency | Dead rules and conflicting invariants | Change review | Sound within the fragment |
| 8 | Example tests | Expected outcomes, run on the interpreter and on generated code | Every build | Only as good as the tests |
| 9 | Property tests | Inputs generated from refinement types, with shrinking of failures | Every build | Statistical |
| 10 | Differential tests | Random sequences of steps run on the interpreter and on generated TypeScript must produce identical outcomes and state hashes | Every build | Statistical; this is the main defense against compiler bugs |
| 11 | Mutation filter | Generated tests must kill at least one mutant | When tests are added | Measures how strong the tests are |
| 12 | Runtime checks | Unproven invariants, parameter refinements, the capability manifest and SQL `CHECK` constraints | Every step | Catches violations at runtime and aborts the step |
| 13 | Reproducible builds | Same graph, same compiler version and same proof cache give byte-identical output | Every build | The build hash is recorded and checked in CI |

**How the SMT encoding works:**
- **Entity tables** become arrays from ids to records. Frame reasoning keeps symbolic only the ids a rule touches.
- **Integer arithmetic** is mathematical. This is sound because overflow faults the step, and faulted steps never commit.
- **Money and Decimal** are scaled integers. Multiplying two variables is nonlinear and leaves the decidable fragment, so such obligations come back Unproven.
- **Quantifiers over tables** use the solver's quantifier instantiation, which can be incomplete. An incomplete result falls back to Unproven, never to Proven.

**The trusted base.** A proof is a statement about Charter's semantics. The deployed program only matches it if these components are correct:
- the parser and checker;
- the SMT encoding and Z3 itself;
- the code generator and runtime;
- SQLite;
- the adapters.

Layers 10 and 12 exist because this base is large. **Paranoid mode** is a deployment setting that keeps runtime checks even for proven invariants. It is recommended for any invariant linked to a money requirement.

## 4.6 Safeguards for high-risk operations

**Database changes:**
- Rules are the only way to write. Generated apps contain no raw SQL path, and adapters cannot write to the store.
- A `delete` is classed as high risk in change review.
- A migration that drops data requires human approval. The runtime takes a snapshot automatically before applying it.
- Every migration dry-runs first and must pass all invariants on the migrated copy.

**Money:**
- The Money type is exact, and mixing Money with other numeric types is a type error.
- Charges happen only after commit, through the outbox, with idempotency keys. A rejected order can never be charged.
- An ambiguous payment result becomes `Unknown` for an operator to resolve. The runtime never retries it and never assumes it failed (A6).
- Adapter signatures carry refinements, for example `amount: Money where > 0`. The checker enforces them at every `emit`.
- **Spending limits.** Deployment config sets a maximum per step and a maximum per day for each payment capability. An effect over a limit is held in the queue for human approval.

**Access control:**
- Access is denied by default. Every rule and query must have a permit.
- The caller comes only from the authenticator.
- Asserts are proven, and every change shows a permission diff with witnesses.
- **Gap: there is no field-level read control in the MVP.** A query that returns a whole `User` also returns the email address. Until this is fixed, the checker warns when a query returns an entity type rather than an explicit record type. This is listed as an open question below.

**External APIs:**
- The capability manifest lists every capability a build may call, and the runtime refuses anything else.
- An egress allowlist in deployment config limits `Http.post` to named hosts.
- Secrets never appear in Charter source. Adapters read them from the environment or a secret store.

**Dry runs and gates:**
- **Dry-run mode** swaps every adapter for its recording twin and runs the requested steps on a copy of the store.
- **Shadow mode** runs a new version against copied traffic and compares its outcomes with the live version before switching over.
- **Deployment gates** follow the risk levels from Phase 3:

| Risk | Development | Production |
|---|---|---|
| Low | Deploys automatically | One approval |
| Medium | One approval | Approval plus a shadow-mode report |
| High | Approval plus a dry-run report | Approval, shadow mode, and a snapshot before deploying |

## 4.7 Limits of verification

Charter's verification proves specific properties of the program's own semantics. It does not prove that the software is correct. Every build report has four sections: **Proven**, **Runtime-checked**, **Assumed** and **Not covered**. Nothing is allowed to fall silently between them.

| Limit | Why it can't be proven | How it is surfaced |
|---|---|---|
| The specification itself is wrong | Proofs show the program matches its requirements, not that the requirements are what the business needs | The deterministic gloss, the round-trip check, and the requirement statuses. Only humans can close this gap. |
| External systems misbehave | A payment provider could ignore an idempotency key | Adapter assumptions are listed under **Assumed** |
| Liveness | "Every order is eventually charged or compensated" depends on adapters and operators, so it isn't provable in general | Runtime monitors alert on outbox age and on `Stuck` or `Unknown` counts |
| Performance and timing | Outside the semantics | Load tests. Never claimed. |
| Invariants outside the decidable fragment | Nonlinear arithmetic, or complex aggregates | Listed under **Runtime-checked** |
| `extern fn` correctness | Implemented in TypeScript | Listed under **Assumed**, with the share of code they make up |
| Bugs in the compiler or runtime | The trusted base is not verified | Differential testing, replay hash checks and paranoid mode |
| Field-level data exposure | Permits control who can call a query, not which fields it returns | A checker warning, and listed under **Not covered** |
| Denial of service, side channels | Outside the model | Listed under **Not covered** |

```
// [ILLUSTRATIVE] build report summary for shop@0.1.0, hand-derived
PROVEN            StockNonNegative × PlaceOrder, StockNonNegative × PlaceOrder#k0 (A3)
                  price refinement × all rules (no rule writes price)
RUNTIME-CHECKED   (none)
ASSUMED           Payment.charge: idempotent on key (adapter contract, A6)
NOT COVERED       Liveness of the charge after commit; field-level read exposure
RELEASE GATE      BLOCKED: R-3 inferred (active-customer rule); Money rounding inferred
```

## Checkpoint

**Decisions:**
- An eight-stage deterministic compiler. The step-level Charter IR is checked against a reference interpreter by differential testing.
- The MVP target is TypeScript on Node.js with a single SQLite writer. Wasm is the second target and the route to mobile.
- Amendments A4 through A7: the safe-integer range, deterministic solver limits with a proof cache, delivery semantics for capabilities with an `Unknown` result, and a kill switch per rule.
- The runtime uses the transactional-outbox pattern, events consumed exactly once, mandatory dry-runs for migrations, and replay with state-hash checks.
- Safeguards include post-commit charges, spending limits, deny-by-default access, an egress allowlist, and deployment gates by risk level.
- Every build report sorts properties into Proven, Runtime-checked, Assumed and Not covered.

**Open questions:**
- **Field-level read control.** Should entities mark fields as private, or should queries be required to return explicit record types? The second needs no new syntax but makes queries longer.
- **The paranoid mode default.** Should it be on for money invariants by default, or left as a choice?
- **Who resolves `Unknown` payments.** An operator user interface is needed, which belongs in Phase 6.
- **Where the reference interpreter runs.** Should it also run in production as a shadow for canary traffic, or only in CI?

**Risks:**
- **Differential testing is statistical.** A compiler bug that appears only on rare sequences of steps could slip through. Mitigation: coverage-guided generation of step sequences, and fuzzing the optimizer pass by pass.
- **The single writer limits scale.** Example 5 will push past it. Moving to optimistic concurrency later means re-checking the claim of serializability.
- **SQL pushdown can diverge from the semantics.** One example is `NULL` handling in aggregates. Every pushed-down query is differential-tested against the interpreter.
- **The adapter contracts are the weakest link for money.** A wrong idempotency claim on an adapter turns `Proven` into a false sense of safety. Payment adapters therefore need their own conformance test suite.
