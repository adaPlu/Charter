# Errata from milestone 0

Milestone 0 checked the design with tools for the first time. It merged every grammar amendment into `spec/charter.ebnf`, checked the grammar for well-formedness, and parsed every Charter listing from Phases 2, 5 and 6 against it. This section records what that found. The phases above are kept as written; this list says where they were wrong or incomplete.

## Grammar amendments A14 to A20

Each one was needed because a listing in the design did not parse under the merged grammar, or parsed ambiguously. The register is `spec/amendments.md`, and each amendment is covered by at least one conformance case.

| ID | Problem found | Fix |
|---|---|---|
| A14 | `Id<idn.Account>` and `on idn.Registered` (Phase 5, examples 3 and 5) used qualified names where the grammar allowed only a plain identifier | Types and trigger event names accept qualified names |
| A15 | `import identity@^1.0` (Phase 5, example 3) failed, because version ranges required all three parts | Ranges may be `^1`, `^1.0` or `^1.0.0` |
| A16 | `type Input = … req R-5` (Phase 5, example 1) failed, because `type` and `enum` declarations took no `req` links | Both now take links |
| A17 | A `req` at the end of a rule could belong to the rule or to its last clause. The Phase 2 grammar allowed both readings. | Rule-level links come right after the signature. A trailing `req` belongs to the last clause. |
| A18 | `guard not exists …`, used throughout Phases 3, 5 and 6, did not parse: `not` could only precede a comparison | `not` applies to quantifiers. `count`, `sum` and `select` became primaries. A longest-match rule settles how far a trailing expression extends. |
| A19 | `Error(_)` (Phase 5, example 1) failed, because pattern binders had to be identifiers | Binders may be `_` |
| A20 | The lexical rules for integers, decimals, strings, durations, requirement ids and versions were never written down | They now are |

Two tests in `scripts/grammar.test.mjs` confirm that A18 and A19 are needed: with either one undone, the affected examples stop parsing.

## Other corrections

| Where | Correction |
|---|---|
| Phase 3, section 3.1 | The pipeline table pointed to 3.7 for the anti-weakening rule and to 3.5 for the impact report. The correct sections are 3.10 and 3.6. Fixed in this document. |
| Phases 1, 5 and 8 | The grammar was estimated at "about 60" and later "about 65" productions. Measured, the frozen grammar has 74 syntactic rules, or 83 productions including lexical rules. Most of the difference comes from splitting the clause rule into ten named sub-rules, which does not add syntax. Phase 1's informal target for constrained decoding was missed. That makes the H1 pilot more important, not less. |
| Phase 5, example 3 | The property `then (result == ok) == …` does not parse, as Phase 5 itself noted. It is now the negative conformance case `n003`, which flips to a passing case when milestone 2 settles outcome comparison. |
| Phase 5, example 3 | The test `then count x in Collaborator where x.project == p.id == 0` parses, and means `(count …) == 0`, because comparisons do not chain. This reading is now written into the grammar's disambiguation rule. |
| Phase 5, example 5 | Besides the five gaps listed there, the module used `idn.Account` without importing `identity`. The conformance case adds the import and a `rejects` declaration. |
| Phase 2, section 2.10 | Under amendment A17, the example's trailing `req R-1, R-2` links to the `emit` clause, not to the whole rule. The meaning is the same here, but the link sits on a different node. |

## What milestone 0 did not check

The recognizer in `scripts/grammar.mjs` checks that a program belongs to the grammar. It does not apply the longest-match rule, build a syntax tree, or check types. Every result in Phases 1 to 9 beyond "this parses" is still derived by hand. Type checking, proofs and test runs begin in milestone 1.
