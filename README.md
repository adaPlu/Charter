# Charter

Charter is a design for an AI-native programming language. People describe what software should do in plain language. An AI turns that into a small, typed, formal program. Deterministic tools check that program, prove what they can about it, and run it. No AI model is involved at runtime.

The full design, all nine phases, is in [docs/charter-design.md](docs/charter-design.md).

## Status

| Milestone | State |
|---|---|
| 0. Foundations | Done. Repository, layer rule, frozen grammar, conformance corpus, CI. |
| **1. Calculator end to end** | **Done.** Parser, printer, hashes, name resolution, type checker, Z3 proofs, interpreter, tests and the `charter` command. |
| 2. State, and readiness for the H1 pilot | Next: entities, rules, transactions, the SQLite store, `charter serve` |
| Gate: H1 pilot | Planned. Can stop the project if Charter shows no advantage. |
| 3 to 9 | Planned. See the design doc, section 8.5. |

Milestone 1 fully checks, proves and runs the pure part of the language. That covers types, enums, functions, queries, and tests and properties that call queries. Rules, entities, permissions and invariants are parsed and resolved, and `charter check` lists them as checked from milestone 2. It never accepts them silently.

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

| Command | What it does |
|---|---|
| `charter check <file>` | Parse, check names and types, prove obligations with Z3 |
| `charter test <file> [--runs N]` | Run tests and properties on the reference interpreter |
| `charter run <file> <Query> [args]` | Call a query. Each argument is a Charter expression. |
| `charter fmt <file> [--check \| --write]` | Canonical form. `--write` refuses to delete comments unless you add `--force`. |
| `charter ask "<request>"` | Natural-language interface, planned for milestone 7. The only command that needs a model. |

## Checks

```bash
npm run ci
```

That runs the layer rule, the grammar freeze, the conformance corpus, the TypeScript type check and every test. CI runs the same steps on Linux and Windows.

| Item | Value |
|---|---|
| Grammar productions | 83, of which 74 are syntactic, all exercised by the corpus |
| Conformance cases | 15 |
| Tests | 62, including about 1,900 fuzzed programs and expressions per run |
| Amendments | A1 to A21. The 16 due by milestone 1 are covered by conformance cases. |

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
| `packages/` | The 17 toolchain packages. syntax, graph, resolve, types, verify, interp, testing and cli have code. The rest are empty until their milestone. |
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
node scripts/check-grammar.mjs --write-lock A22
```
