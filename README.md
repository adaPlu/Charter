# Charter

Charter is a design for an AI-native programming language. People describe what software should do in plain language. An AI turns that into a small, typed, formal program. Deterministic tools check that program, prove what they can about it, and run it. No AI model is involved at runtime.

The full design, all nine phases, is in [docs/charter-design.md](docs/charter-design.md).

## Status

| Milestone | State |
|---|---|
| 0. Foundations | Done. Repository, layer rule, frozen grammar, conformance corpus, CI. |
| 1. Calculator end to end | Done. Parser, printer, hashes, name resolution, type checker, Z3 proofs, interpreter, tests. |
| **2. State, and readiness for the H1 pilot** | **Done, except the pilot run.** Rules as transactions on SQLite, invariants at every commit, step log and replay, `charter serve`, the grammar frozen and exported for constrained decoding. |
| Gate: H1 pilot | **Harness built and tested; pilot not run.** Waiting on task authors, model access and a budget. See [bench/README.md](bench/README.md). |
| 3 to 9 | Planned. See the design doc, section 8.5. |

What runs now: types, functions, queries, entities, rules, permissions, invariants, events and triggers, and tests and properties with setups and callers. Effects are queued in the outbox but not yet dispatched (milestone 4). Invariants are checked at every commit; proving them arrives in milestone 3.

### What the H1 pilot needs

The pilot (design doc, 7.3) compares how often models write valid Charter against valid TypeScript for the same task. The harness in [bench/](bench/README.md) is built and tested: it prompts a model, checks the program with the language's real tool, repairs from diagnostics, and runs hidden black-box tests over HTTP against both languages. It can only compare free decoding for now: constrained decoding needs a llama.cpp server, and no TypeScript grammar exists. Running the pilot needs three decisions:

1. **Task authors.** Phase 7 requires tasks and hidden tests written independently of the design. The two tasks in `bench/tasks` test the harness and are excluded from results.
2. **Model access.** For example, an Anthropic API key for Claude Opus 5.5 and Claude Sonnet 5.5.
3. **A budget.** Estimated at $15 to $40 for both models; [bench/README.md](bench/README.md) has the details.

## Try it

You need Node 22.18 or later. The `charter` command runs TypeScript directly, with no build step.

```bash
npx pnpm@9.15.4 install
```

```bash
npm run charter -- check conformance/cases/c001-calculator/input.charter
```

Measured output, from the calculator in Phase 5, example 1:

```
✓ parsed (1 module, 15 declarations)
✓ names and types
✓ proof obligations: 1 proven, 4 kept as runtime checks
    proven         b is not zero  (line 20)
    runtime check  a + b stays within the Decimal range  (line 17)
    runtime check  a - b stays within the Decimal range  (line 18)
    runtime check  a * b stays within the Decimal range  (line 19)
    runtime check  a / b stays within the Decimal range  (line 20)
⚠ 3 requirement(s) not confirmed: R-3 (inferred), R-4 (inferred), R-5 (inferred). A release build is blocked until a person confirms them.
```

The design predicted two of those range checks would be proven. They aren't, because `calculate` takes plain `Decimal` parameters, so its inputs have no bounds. The [errata](docs/design/10-errata.md) record this and the other findings.

```bash
npm run charter -- test conformance/cases/c001-calculator/input.charter
```

```bash
npm run charter -- run conformance/cases/c001-calculator/input.charter Calculate 1 0 Div
```

Remove the divide-by-zero check and the verifier refuses the program, with a counterexample:

```bash
npm run charter -- check conformance/cases/n005-division-unproven/input.charter
```

```
…  error CH0401  cannot prove that b is not zero
    known: nothing
    counterexample: b = 0
    fix (add_guard): check the divisor first, for example: if b == 0 then … else …
```

The to-do app from Phase 5, example 2 runs as a web service. Register two users from the command line, then serve the same database:

```bash
npm run charter -- run examples/todo/todo.charter Register '"Ana"' --system --db todo.db
```

```bash
npm run charter -- serve examples/todo/todo.charter --db todo.db --port 8080
```

```bash
curl -s -X POST localhost:8080/rules/AddTask -H "x-charter-caller: <Ana's id>" -d '{"args": ["Buy milk", null]}'
```

Every step, rejections included, goes into the step log. Replaying it on an empty store must reproduce every outcome and the exact state:

```bash
npm run charter -- replay examples/todo/todo.charter --db todo.db
```

The caller header is for development only. Real sign-in belongs to the identity module.

| Command | What it does |
|---|---|
| `charter check <file>` | Parse, check names and types, prove obligations with Z3 |
| `charter test <file> [--runs N]` | Run tests and properties, each on a fresh in-memory store |
| `charter run <file> <Name> [args] [--db F] [--as ID] [--system]` | Call a rule or query. Each argument is a Charter expression. |
| `charter serve <file> [--db F] [--port N]` | Every rule and query over HTTP |
| `charter replay <file> --db F` | Re-run the step log on an empty store and compare the state hash |
| `charter fmt <file> [--check \| --write]` | Canonical form. `--write` refuses to delete comments unless you add `--force`. |
| `charter ask "<request>"` | Natural-language interface, planned for milestone 7. The only command that needs a model. |

## Checks

```bash
npm run ci
```

That runs the layer rule, the grammar freeze, the conformance corpus, the GBNF export check, the TypeScript type check and every test. CI runs the same steps on Linux and Windows.

| Item | Value |
|---|---|
| Grammar productions | 83, of which 74 are syntactic, all exercised by the corpus. Frozen for the pilot; reopened once, for A26, before any model run. |
| Conformance cases | 18 |
| Tests | 101, including about 1,900 fuzzed programs and expressions per run, and the to-do app tested over HTTP |
| Amendments | A1 to A27. The 23 due by milestone 2 are covered by conformance cases. |

## What milestone 1 delivered

- **Parser and canonical printer.** Recursive descent, one function per grammar production. Every program in the corpus, plus about 1,900 random programs and expressions generated from the EBNF, parses, prints and reparses to the same tree. The parser agrees with the grammar recognizer on every case.
- **Hashes.** Canonical CBOR (RFC 8949, section 4.2) and SHA-256. Hashes ignore layout, comments and requirement links. Transitive hashes change exactly when a declaration or something it depends on changes.
- **Name resolution.** One flat namespace, with no shadowing and requirement links checked.
- **Type checker.** Refinement types, narrowing through `if`, `and` and `or`, exhaustive `match`, the Money rules, and the standard library. It emits proof obligations for division by zero, refinements and numeric ranges.
- **Verifier.** Z3 through `z3-solver`, with a deterministic resource limit (A5) and a proof cache keyed by the exact query. Unproven division and refinement obligations are errors with counterexamples. Unproven range obligations stay as runtime checks.
- **Reference interpreter.** Exact decimals scaled by 10¹⁸ with half-to-even rounding, and range faults (A4, A13, A21).
- **Test runner.** Example tests, and properties driven by fast-check with inputs shaped by refinement types, seeded for repeatable runs.

## Layout

| Path | Contents |
|---|---|
| `spec/` | Grammar, grammar lock, amendments, pointers to the semantics |
| `packages/` | The 17 toolchain packages. syntax, graph, resolve, types, verify, store, interp, testing and cli have code. The rest are empty until their milestone. |
| `examples/` | Runnable programs, such as the to-do app for `charter serve` |
| `spec/charter.gbnf` | The grammar for constrained decoders, generated from `spec/charter.ebnf` |
| `conformance/cases/` | Programs with their expected parse, check, proof and test results |
| `scripts/` | Layer rule, grammar tools, corpus checker, generators |
| `docs/design/` | The design document, one file per phase |
| `docs/charter-design.md` | The combined design document, generated from `docs/design/` |

## Changing the grammar

The grammar is frozen, so a change takes three steps:

1. Add an amendment to `spec/amendments.json` and `spec/amendments.md`.
2. Add or update a conformance case that covers it.
3. Renew the lock with the amendment's id:

```bash
node scripts/check-grammar.mjs --write-lock A26
```
