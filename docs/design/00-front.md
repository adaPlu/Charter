# Charter: design document

**Charter** is a design for an AI-native programming language. Humans state intent, rules and constraints in natural language. An AI translates that intent into a formal, typed program. Deterministic tools check, prove what they can, compile and run that program, with no AI model involved at runtime.

This document collects the nine design phases in one place. It was produced from the master prompt in the appendix, one phase at a time.

## Status

| Item | Status |
|---|---|
| Design, Phases 1 to 9 | Complete |
| Milestone 0: repository, layer rule, frozen grammar | Done |
| Milestone 1: calculator end to end | Done. Parser, checker, Z3 proofs, interpreter and tests run for the pure part of the language. |
| Rules, entities and the store | Not built yet. Milestone 2 is next. |
| Evidence for the hypotheses | None yet. The first comes from the H1 pilot, after milestone 2. |

**Every program, IR listing, report and verification result in Phases 1 to 9 was written or derived by hand.** Milestone 1 has since checked some of them with real tools; the Errata section says where they held and where they did not. Code blocks carry status labels:

| Label | Meaning |
|---|---|
| `[SPEC]` | A normative definition |
| `[ILLUSTRATIVE]` | A hand-written sketch |
| `[GENERATED-UNTESTED]` | Plausible tool output that has never been run |
| `[EXECUTED]` | Actually run, with the output shown. Nothing in Phases 1 to 9 has this label. |

## How to read this document

- **The phases are kept as written.** Later phases amend earlier ones, and those amendments are listed rather than silently applied. Phase 2's grammar, for example, appears as it was designed. The normative version is `spec/charter.ebnf` in the repository.
- **The Errata section** lists what implementation found. Milestone 0 added grammar amendments A14 to A20. Milestone 1 added A21 and found one hand-derived proof in Phase 5 that does not hold.
- **The checkpoints** at the end of each phase record decisions, open questions and risks. Phase 8, section 8.6 assigns every open question to a milestone.
