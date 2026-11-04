# Phase 8: MVP implementation plan

This is a plan. Effort figures are rough estimates for a small team, meant for planning and sequencing, not commitments. Milestone 0 has since been completed; the repository README records what it delivered.

## 8.0 Ground rules for the build

1. **The MVP works with no AI model.** Every command except one runs without an LLM. A developer can write Charter by hand, then check, verify, test, run and build it.
2. **The lint config enforces principle 2.** No package below the intent layer may import the LLM package. A dependency-graph lint rule fails CI if anything does. "No LLM in the compiler or runtime" becomes a build failure, not a promise.
3. **Spec and code move together.** Every amendment, A1 through A13 and any later ones, lands with conformance cases in the same change.
4. **The grammar freezes before the pilot.** All open grammar questions must be settled by the end of milestone 2. After that the grammar is frozen for the Phase 7 study, as Phase 5 warned.

## 8.1 Implementation technology

| Choice | Decision | Why | Alternative considered |
|---|---|---|---|
| Implementation language | **TypeScript on Node.js 22 LTS** | One language for the compiler, interpreter, runtime and generated code. The runtime library is shared rather than duplicated. Z3 has an official JavaScript/Wasm build, so the verifier runs in-process. | **Rust.** It is faster and suits the later Wasm target. It was rejected for now because the solver, not the compiler, is the bottleneck, and the shared runtime matters more. Hot paths can move to Rust compiled to Wasm later. |
| Parser | Hand-written recursive descent | Better error messages, error recovery and incremental reparsing. The EBNF stays the single source for decoding grammars and conformance tests. | A parser generator, rejected for weaker error messages |
| SMT solver | Z3, through the `z3-solver` package, with deterministic resource limits (A5) | Mature, with good quantifier support and official bindings | cvc5, kept as an optional second solver later for cross-checking |
| Store | SQLite through `better-sqlite3` | Its synchronous API fits the single-writer design exactly | Postgres, a post-MVP target |
| Hashing | SHA-256, with a small hand-written canonical CBOR encoder | Writing the encoder ourselves keeps hashing deterministic and under our control | A general CBOR library, rejected because canonical-encoding edge cases matter here |
| Property testing | fast-check | Mature shrinking, and its generators can be driven from refinement types | Writing our own, which isn't worth it |
| HTTP | Fastify | Validates requests against a schema, and is fast | Express |
| Toolchain tests | Vitest | Fast, and native to TypeScript | Jest |
| Repository | pnpm workspaces in a monorepo | Strict package boundaries make the lint rule above possible | Separate repositories |
| Constrained decoding | Export the grammar to GBNF and the operations to JSON Schema. Use provider structured output, llama.cpp grammars or vLLM guided decoding. | Works across model providers | Tying the project to one provider |

## 8.2 Directory structure

```
charter/
├─ spec/
│  ├─ charter.ebnf            grammar, single source of truth
│  ├─ semantics.md            typing rules and step semantics (Phase 2)
│  └─ amendments.md           A1 onward, each linked to its conformance cases
├─ packages/
│  ├─ syntax/                 lexer, parser, canonical printer, diagnostics, source spans
│  ├─ graph/                  node schema, anchors, canonical CBOR, hashes, JSON form,
│  │                          anchor matching after text edits, operation applier
│  ├─ resolve/                name resolution, behavioral dependency graph (A1)
│  ├─ types/                  type and effect checker, narrowing, refinement obligations
│  ├─ verify/                 SMT encoding, Z3 bridge, frame reasoning, loop idioms,
│  │                          proof cache, witnesses
│  ├─ interp/                 reference interpreter, step log, replay
│  ├─ store/                  SQLite store, schema from entities, single-writer queue,
│  │                          snapshots, migration runner with dry run
│  ├─ effects/                capability registry, outbox, dispatcher, confirm and compensate,
│  │  └─ adapters/            payment (test twin and real), http, mail, log, conformance suites
│  ├─ cir/                    Charter IR, lowering, optimizer passes
│  ├─ codegen-ts/             TypeScript, SQL schema, HTTP layer, typed client
│  ├─ runtime-ts/             library used by generated apps: transactions, outbox, auth hook,
│  │                          kill switches, spending limits
│  ├─ testing/                test and property runner, refinement-driven generators,
│  │                          mutation engine, differential tester
│  ├─ impact/                 transitive hashes, impact report, permission and guard diffs,
│  │                          equivalence checks
│  ├─ explain/                deterministic gloss templates
│  ├─ intent/                 utterance log, requirement store, frames, lowering templates,
│  │                          clarification policy, repair loop, intent ledger
│  ├─ llm/                    provider-neutral adapter, grammar export, context slicer
│  ├─ cli/                    the `charter` command
│  ├─ lsp/                    language server (milestone 9)
│  └─ ide/                    web IDE (milestone 9)
├─ libs/identity/             the identity module and its service (Phase 5, example 3)
├─ conformance/               cases: input, expected diagnostics, proof results, test outcomes
├─ examples/                  calc, todo, projects, shop, progression (Phase 5)
└─ bench/                     public benchmark split, harness, pre-registered analysis code
```

**Dependency layers.** Each layer may import only from the layers below it.

```
// [ILLUSTRATIVE] enforced by a dependency lint rule in CI
 intent ─▶ llm                                   ← the only place an LLM appears
   │
   ▼
 explain · impact · cli
   │
   ▼
 codegen-ts ─▶ cir          testing ─▶ interp
   │                                     │
   ▼                                     ▼
 verify ─▶ types ─▶ resolve ─▶ graph ─▶ syntax      store · effects · runtime-ts
```

`cli` reaches `intent` only through the one command that needs a model, `charter ask`. That command is loaded lazily, so every other command runs on a machine with no model and no API key.

## 8.3 Core modules and their interfaces

```ts
// [ILLUSTRATIVE] main entry points, one per package
parse(text: string): { program: Program; diagnostics: Diagnostic[] }          // syntax
print(program: Program): string                                               // syntax, canonical
hashes(program: Program): Map<Anchor, { own: Hash; transitive: Hash }>        // graph + resolve
check(program: Program): { typed: TypedProgram; obligations: Obligation[];
                           diagnostics: Diagnostic[] }                        // types
verify(obligations: Obligation[], cache: ProofCache): ProofResult[]           // verify
step(typed: TypedProgram, store: Store, call: Call): Outcome                  // interp
applyChangeSet(p: Program, cs: ChangeSet, policy: Policy):
  { program: Program; diagnostics: Diagnostic[] }                             // graph
impact(before: Program, after: Program): ImpactReport                         // impact
gloss(typed: TypedProgram, anchor: Anchor): GlossSentence[]                   // explain
build(typed: TypedProgram, proofs: ProofResult[], target: "ts"): Artifact     // cir + codegen-ts
```

**Diagnostics are designed for the repair loop.** The repair loop is what H1's valid@repair measures, so error output matters as much as the checker:
- Every diagnostic has a stable code, a primary anchor and a span.
- It carries a **machine-readable fix hint** wherever one exists.
- Refuted proofs include their witness as data, not only as text.

```json
// [ILLUSTRATIVE]
{ "code": "CH0412", "severity": "error", "anchor": "n_emit_charge_amount",
  "message": "Cannot prove 'amount > 0' required by Payment.charge.",
  "known": ["price >= 0", "qty >= 1"],
  "witness": { "price": "0.00", "qty": 1, "amount": "0.00" },
  "fixes": [ { "kind": "add_guard", "expr": "amount > 0" },
             { "kind": "wrap_if", "cond": "amount > 0" } ] }
```

**The conformance corpus is the spec's test suite.** Each case pairs a Charter program with its expected results: diagnostic codes, proof results, test outcomes and printed output. Five kinds of check guard the core packages:

| Check | What it guards |
|---|---|
| Grammar coverage | Every grammar production appears in at least one passing case and one failing case |
| Grammar-based fuzzing | The parser accepts everything generated from the EBNF, and rejects mutated inputs gracefully |
| Round trip | `parse(print(G)) = G` up to anchors, on every corpus program |
| Hash fuzzing | Random edits change exactly the transitive hashes the dependency graph predicts. This is the Phase 3 risk to H2. |
| Differential testing | The interpreter and the generated TypeScript agree on outcomes and state hashes across random step sequences |

## 8.4 The command-line tool

Every command below except `ask` runs without an AI model.

| Command | Purpose | Milestone |
|---|---|---|
| `charter fmt` | Prints the canonical form | 1 |
| `charter check` | Types, effects and refinement obligations | 1 |
| `charter test` | Runs tests and properties on the interpreter | 1 |
| `charter run <Rule or Query> <args> --as <id>` | Runs one step or query | 1 |
| `charter serve` | Serves the program over HTTP through the interpreter, for development | 2 |
| `charter replay` | Rebuilds state from the step log and checks the state hash | 2 |
| `charter verify` | Full proofs, written to the proof cache | 3 |
| `charter ops` | Operator actions: `Unknown`, `Stuck`, kill switches | 4 |
| `charter build --target ts [--release]` | Compiles and packages, with the release gate on `--release` | 5 |
| `charter migrate --dry-run` | Migration dry run | 6 |
| `charter review <changeset>` | The impact report and review card in the terminal | 6 |
| `charter explain <name>` | Deterministic gloss | 7 |
| `charter ask "<request>"` | The natural-language pipeline. **Needs a model.** | 7 |

**The milestone 1 demo:**

```
// [ILLUSTRATIVE] expected terminal session at the end of milestone 1
$ charter check examples/calc/calc.charter
✓ parsed (1 module, 6 declarations)
✓ types and effects
✓ refinements: 1 proven (division in calculate), 2 runtime range checks (Mul, Div)
⚠ 3 requirements inferred: R-3, R-4, R-5

$ charter test examples/calc/calc.charter
✓ divide by zero gives an error
✓ 2.5 times 4 is 10
✓ too-large input is rejected
✓ property: adding then subtracting gives back the first number (1,000 cases)

$ charter run examples/calc/calc.charter Calculate 1 0 Div
Ok  Error(DivideByZero)
```

## 8.5 Milestones

The effort estimates assume four engineers and one researcher. A "week" means one week of that team's combined time.

| # | Milestone | Scope | Demo | Exit criteria | Rough effort |
|---|---|---|---|---|---|
| **0** | Foundations | Monorepo, the lint rule, the grammar file with A1 to A13 merged, corpus format, CI | CI fails on a planted LLM import below the intent layer | Grammar v0.1 written down. Production count recorded, about 65. | 2 weeks |
| **1** | **Calculator end to end** | Lexer, parser, printer, graph with anchors and hashes, name resolution, type checker with narrowing, Z3 for refinement obligations, interpreter for functions and queries, test and property runner, the first CLI commands | The session in 8.4 | Example 1 passes all its tests. Division proven by the real solver. Round trip passes on the corpus. Every production covered. | 6 weeks |
| **2** | **State, and readiness for the pilot** | Entities, rules, transactions, permissions, invariants as runtime checks, SQLite store, step log and replay, `charter serve`, grammar export to GBNF and JSON Schema, benchmark harness for arms A and D | Example 2 served over HTTP and passing black-box tests. Replay reproduces the state hash. | Open grammar questions settled and **the grammar frozen.** The 20 pilot tasks run in both arms. | 8 weeks |
| **Gate** | **H1 pilot (Phase 7)** | 20 tasks, 2 models, arms A and D, 3 samples each | Pilot report | **Kill criterion:** a valid@1 gain under 5 points *and* a lower semantic pass rate means stopping for a design review | 3 weeks |
| **3** | Verifier | Invariant preservation with frame reasoning, asserts, permission and guard diffs, witnesses, the bulk-delete idiom, proof cache with resource limits | `charter verify` on examples 2 to 4 | The hand-derived results from Phase 5 are reproduced, **or every difference is explained.** The hand derivations may be wrong, and finding that out is part of the milestone. | 10 weeks |
| **4** | Effects | Capabilities, outbox, dispatcher, `confirm` and `compensate`, delivery semantics (A6), adapters with test twins, operator commands | Example 4 with a payment test twin | Every row of example 4's failure table has an automated test that passes. The 50-parallel-orders test passes. | 6 weeks |
| **5** | Compiler | Charter IR, lowering, optimizer passes, TypeScript and SQL generation, HTTP layer, typed client, differential tester, reproducible builds | `charter build` on examples 1 to 4, with the same black-box tests passing | No divergence in 1,000,000 random steps. Identical bytes from builds on two different operating systems. Performance measured against the hand-written app, with the 2× target from Phase 7 reported either way. | 10 weeks |
| **6** | Change management | Operation applier, change sets, policies, impact reports, migrations with dry run, terminal review | The Phase 3 collaborator change set run for real | The tool's impact report matches the hand-derived one in Phase 3, or every difference is explained. Hash fuzzing passes. | 8 weeks |
| **7** | Language bridge and explanations | Utterance log, requirement store, frames, lowering templates, model-neutral adapter, constrained decoding, clarification policy, repair loop with the anti-weakening rule, test generation with the mutation filter, gloss, intent ledger | The five Phase 5 requests run end to end with a pinned model | Release gate behaves as specified. The anti-weakening rule blocks a planted weakening repair. The share of operations from deterministic lowering is measured. | 12 weeks |
| **8** | Full evaluation | The Phase 7 studies, run on a frozen toolchain | Published results, including negative ones | Matches the pre-registration | 10 weeks |
| **9** | Language server and web IDE | Three synchronized views, review card, coverage panel, operator console, deployment plans as tracked objects (Phase 6 risk) | The four Phase 6 interactions working | The review-fatigue study can run on the real IDE | 12 weeks |

**Milestones that can overlap.** Milestones 4 and 6 depend only on milestone 3 and can run in parallel. Milestone 9 can start once milestone 6 is done, alongside milestone 7.

**Rough calendar** with the planned overlap: about 14 months to the full evaluation, and about 16 months to a usable web IDE.

## 8.6 Where the open questions get settled

Every open question from earlier phases gets an owner milestone, so none is quietly dropped.

| Open question | From | Settled in | Must it change the grammar? |
|---|---|---|---|
| `result` comparable to outcomes in tests | Phase 5 | 2 | Yes, so before the freeze |
| Writes through a narrowed optional entity | Phase 5 | 2 | Possibly, so before the freeze |
| Two-state invariants with `old(…)` | Phase 5 | 2, deciding whether it goes in v0.1 | Yes, so before the freeze |
| Field-level read control | Phase 4 | 2. The leading option is requiring queries to return record types, which needs no new syntax. | Possibly |
| Money rounding: program-wide or per use | Phase 2 | 2 | Possibly |
| Size cap on loops over whole entity tables | Phase 2 | 3 | No, it's a checker limit |
| Which loop idioms the verifier summarizes | Phase 5 | 3 | No |
| Paranoid mode default | Phase 4 | 4 | No, it's configuration |
| Mutation operators for the test filter | Phase 3 | 7 | No |
| Deployment plans as tracked objects | Phase 6 | 9 | No |
| The two-person rule's default | Phase 6 | 9 | No |

## 8.7 A smaller path for one person

The plan above assumes a team. One person working part-time can still build something that tests the core idea, by cutting scope hard:

| Keep | Cut, for now |
|---|---|
| Parser, printer, graph with hashes | The verifier: invariants stay runtime-checked only. Refinements are checked at runtime too, with no Z3. |
| Type checker and narrowing | The compiler: the interpreter serves the app directly |
| The interpreter, with SQLite and the step log | Effects beyond a logging adapter |
| `charter serve` and the test runner | The language bridge: use any LLM by hand, with the grammar and manual pasted in |
| Examples 1 and 2 | The IDE |

That is roughly milestones 1 and 2 without the solver. It would probably take 3 to 5 months part-time. It is enough for an informal version of the H1 pilot: does a model write valid Charter more often than valid TypeScript for the same small tasks? It cannot test H3, because that depends on the verifier.

## Checkpoint

**Decisions:**
- The toolchain is TypeScript on Node.js 22, with Z3, SQLite, fast-check and Fastify, in a pnpm monorepo.
- A dependency lint rule keeps the LLM out of every package below the intent layer. Principle 2 is enforced by CI.
- Fourteen packages in strict layers, with a conformance corpus as the spec's test suite.
- Diagnostics have stable codes, fix hints and witnesses as data, because the repair loop depends on them.
- Ten milestones. Milestone 1 is the calculator end to end. The H1 pilot gates everything after milestone 2, with a stated kill criterion.
- The grammar freezes at the end of milestone 2. Every open question has an owner milestone.
- There is a cut-down path for a single builder.

**Open questions:**
- **Licensing and governance.** An open-source license makes outside replication of the Phase 7 study possible, which strengthens the results. It also exposes the benchmark's public split. The private split must stay private either way.
- **Funding the evaluation compute.** The pilot will give the first real cost estimate for the full study.
- **Whether Rust is needed for the hot paths** won't be known until milestone 3 measures solver and checker time on realistic programs.

**Risks:**
- **The verifier milestone is the riskiest.** Quantifiers over tables may time out more than the hand derivations assumed. If they do, much of H3's case moves from "Proven" to "Runtime-checked". The milestone 3 exit criterion makes this visible early instead of hiding it.
- **The pilot may kill the project at month 4.** That is intended. Finding out early is cheaper than finding out after the compiler and IDE are built.
- **Scope creep in milestone 7.** The natural-language bridge has the most moving parts and the fuzziest quality bar. Its exit criteria are tied to the five Phase 5 requests to keep it bounded.
- **Building the IDE is costly.** Doing it last means early users get only a command line. That is acceptable for developer users, but not for the non-programmers Charter is meant for. The H4 study must therefore wait for milestone 9, or use paper prototypes of the views.
