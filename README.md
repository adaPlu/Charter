# Charter

Charter is a design for an AI-native programming language. People describe what software should do in plain language. An AI turns that into a small, typed, formal program. Deterministic tools check that program, prove what they can about it, and run it. No AI model is involved at runtime.

The full design, all nine phases, is in [docs/charter-design.md](docs/charter-design.md).

## Status

| Milestone | State |
|---|---|
| **0. Foundations** | **Done.** Repository, layer rule, frozen grammar, conformance corpus, CI. |
| 1. Calculator end to end | Next: parser, checker, interpreter and Z3 for refinements |
| 2. State, and readiness for the H1 pilot | Planned |
| Gate: H1 pilot | Planned. Can stop the project if Charter shows no advantage. |
| 3 to 9 | Planned. See the design doc, section 8.5. |

No compiler, verifier or runtime exists yet. Every program result in the design doc was derived by hand.

## What milestone 0 delivered

- **A layer rule that keeps AI models out of the toolchain.** [scripts/check-layers.mjs](scripts/check-layers.mjs) fails the build if any package below `@charter/intent` imports `@charter/llm` or a model SDK. It also catches computed import paths and relative paths into other packages. The one allowed route is a lazy import in `charter ask`.
- **A frozen grammar.** [spec/charter.ebnf](spec/charter.ebnf) merges every amendment so far. [spec/grammar.lock.json](spec/grammar.lock.json) records its hash. Any edit fails CI until it is recorded as a new amendment.
- **A conformance corpus.** The Phase 2, 5 and 6 examples, plus four negative cases, live in [conformance/cases](conformance/cases). CI parses each one against the grammar. Every grammar amendment must be covered by a passing case.
- **Seven grammar amendments, A14 to A20.** Checking the examples against the merged grammar showed they did not all parse. The [errata](docs/design/10-errata.md) explain each fix.
- **Package skeletons.** 17 packages are generated from one layer map, [scripts/layers.mjs](scripts/layers.mjs). CI checks that the manifests still match it.

Measured numbers:

| Item | Value |
|---|---|
| Grammar productions | 83, of which 74 are syntactic |
| Reserved words | 91 |
| Conformance cases | 11: 7 that must parse, 4 that must fail |
| Tests | 18 |

## Running the checks

There are no dependencies to install yet. Node 22 or later is enough.

```bash
npm run ci
```

That runs the layer rule, the grammar freeze, the conformance corpus and the tests. To rebuild the combined design document after editing a part in `docs/design/`:

```bash
npm run design:build
```

## Layout

| Path | Contents |
|---|---|
| `spec/` | Grammar, grammar lock, amendments, pointers to the semantics |
| `packages/` | The 17 toolchain packages, empty until their milestone |
| `conformance/cases/` | Programs with their expected results |
| `scripts/` | Milestone 0 tooling and its tests |
| `docs/design/` | The design document, one file per phase |
| `docs/charter-design.md` | The combined design document, generated from `docs/design/` |
| `libs/identity/` | Placeholder for the identity module, planned for milestone 2 |

## Changing the grammar

The grammar is frozen, so a change takes three steps:

1. Add an amendment to `spec/amendments.json` and `spec/amendments.md`.
2. Add or update a conformance case that covers it.
3. Renew the lock with the amendment's id:

```bash
node scripts/check-grammar.mjs --write-lock A21
```
