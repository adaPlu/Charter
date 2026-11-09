# Errata and implementation findings

This section records where building Charter showed the design to be wrong or incomplete. The phases above are kept as written.

## The H1 pilot: harness built, pilot not run

The pilot harness (`bench/`) prompts a model, checks its program with the language's real tool, repairs from diagnostics, and runs hidden black-box tests over HTTP against both languages. Building it found:

| Finding | Detail | Resolution |
|---|---|---|
| **The planned arms cannot all run** | Phase 7 compares constrained Charter (A) with constrained TypeScript (D). Hosted APIs and Ollama cannot hold output to a GBNF grammar, and no TypeScript GBNF grammar exists. | The pilot compares free decoding, C against B. Arm A runs only on a llama.cpp server. The harness refuses arm D rather than faking it. |
| **No temperature-0 runs** | Phase 7 asks for one run per cell at temperature 0. Current Claude models reject sampling parameters. | Repeated samples only. |
| **Reserved words take natural names** | The wallet task's contract names a parameter `to`, which Charter reserves for migrations. My own reference solution broke on it. `by`, `set`, `order`, `result` and `open` are similar traps. | A real cost of the grammar, kept in the task so the pilot measures it. Contextual keywords are a candidate change after the pilot. |
| **`caller` cannot be written to** | `set caller.balance = …` is not allowed, because `caller` is a keyword, not a binding. The workaround is `let me = caller`. | Documented in the model manual. A candidate for a language change after the pilot. |
| **A harness bug that would have failed every TypeScript program** | The TypeScript work folder lacked `"type": "module"`, so `tsc` rejected the scaffold itself. The no-model dry run caught it before any model was called. | Fixed. A regression test runs the dry run in CI. |
| **Refusal fallbacks would contaminate results** | A fallback answers with a different model. | Off by default in the harness; a refusal is recorded as a failed run. |
| **Task authors must be independent** | The two tasks in `bench/tasks` were written by the design process. | They are marked validation-only and excluded from the analysis. The 20 pilot tasks need independent authors. |
| **Nested refinements were not enforced on inputs** | Writing a Charter reference for draft task p03 found that `List<Score>` accepted a score of 101: only a parameter's outermost refinement was checked, so refinements on list elements, record fields and optional named types were skipped. | Fixed: inputs are now checked through their whole type. A regression test covers each case. The checker still does not prove nested refinements when a program builds such a value itself; that is milestone 3 work. |
| **Four of the 20 draft tasks cannot be passed in Charter** | Charter references were written for all 20 drafts. 16 pass every scenario. p13 and p18 need a public query in a program with signed-in users: under a `principal`, `permit anyone` means any *signed-in* caller, and no form allows an anonymous one. p20 needs a query to reject with `NoRoute`, but queries have no `rejects` clause. p19 needs to read inside text, and Charter has no split, substring or character access. | p13 and p18 sit in the domain Charter targets, so the language changed rather than the tasks: amendment A26 adds `permit public`, under which `caller` is a type error. The grammar freeze was reopened for it once, before any model run, and the model manual says so. p19 and p20 were meant to lie outside Charter's design (family F6), and are kept unchanged: failing them is a legitimate result. **18 of 20 now pass.** |
| **Six tests depended on check order** | A review of all 144 expected rejections in the drafts found 6 where two failures applied at once (p07, p10, p13, p15, p17, p20), so the expected answer depended on which check a program ran first. | Fixed by changing the test's setup, or by saying in the request which failure wins. p01's rounding and p11's owner membership were also reworded, and both model manuals now state that a refused query answers 404. |
| **Smaller limits found by the references** | Dates such as YYYY-MM-DD can only be checked approximately (p06, p07). A query cannot reject `NotFound` on its own condition, only through an entity parameter (p10). Charter always checks missing entities, then input refinements, then permits; the TypeScript references sometimes use another order, which no test notices yet. A denied query answers 404, a convention the task requests do not mention. Dropping the lowest score needs an awkward `forall` because there is no `min` (p03). | Recorded for task review and for the post-pilot language review. |
| **p10 was lenient in Charter's favour** | The p10 request says an enrolled student with no answer gets `NotFound`, but the test checked only the 404 status. Charter answered `Denied`, also 404, and passed. | The project owner chose to check the reason and accept the failure (November 9), rather than change the language. p10 now fails in Charter for the same reason as p20. |
| **F6 had only 2 tasks** | The family meant to lie outside Charter's design was the smallest, which tilted the set towards Charter. | Two tasks added on November 9: p21 (comparing version numbers) and p22 (shift coverage). An AI subagent drafted them without reading anything about Charter. **Both Charter references pass**, so 19 of 22 tasks now pass in Charter. |
| **p19's "cannot read inside text" is probably wrong** | p21's Charter reference reads Text one character at a time: if `s` starts with `p`, its next character is `c` exactly when `p + c <= s and s < p + c'` (where `c'` is the character after `c`), and a recursive `fn` walks the string. The same trick should pass p19. **The model manual teaches none of it:** it never mentions `fn`, recursion, or that `<` orders Text, so a model that sees only the manual is unlikely to find this. | Open. Whether to retry p19's reference, and whether the manual should document `fn` and Text ordering, are decisions for the project owner before the pilot run. A built-in for reading text would be a language change. |

## Milestone 2: state, and readiness for the pilot

Milestone 2 built the SQLite store, rules as serializable transactions, permissions, invariants and referential integrity checked at every commit, events and triggers, the step log and replay, tests with setups and callers, `charter serve`, `charter replay`, and the GBNF export. It also settled the open grammar questions (A22 to A25) and froze the grammar for the pilot. These are its findings.

| Finding | Detail | Resolution |
|---|---|---|
| **Capabilities have no signatures** | Phase 5, example 4 relies on `Payment.charge` requiring `amount > 0`, written in a comment. The language has no way to declare that, so the checker cannot state the obligation that found the zero-charge defect. | Capability signatures must become part of the language with the effect runtime in milestone 4. Recorded in case `c006`. |
| **A soundness bug, caught before it shipped** | The first version checked `confirm` and `compensate` blocks with the step's own knowledge, and "proved" `p.stock + qty` cannot overflow inside a compensation. A compensation runs later, against the stock at that time (design doc, 2.8). | Those blocks are now checked with only what is captured: parameter refinements (A3) and fresh reads of stored fields. A regression test covers it. |
| **Field refinements are facts** | Proving `levelFor(pl.xp)` in example 5 needs `xp >= 0` (an entity field) and `Award.xp >= 0` (a record field). Invariants hold at the start of every step, so they are facts about stored values. After a write, a read means the written value; another binding of the same entity type becomes unknown, because it might be the same entity. | Implemented, with tests for each case. Example 5's call is now proven. |
| **Value ranges are facts** | Every `Int` is within ±(2⁵³ − 1) and every `Decimal` within ±10³⁸, because anything else faults (A4, A13). | The verifier assumes these bounds. `p.stock - qty` in example 4 is now proven; `p.stock + qty` in the compensation honestly is not. |
| **The invariant contained a broken guard** | With example 4's stock guard weakened, a large order would drive stock below zero. `StockNonNegative`, checked at commit, rejected the step and nothing changed. | Kept as a test: the runtime check does its job when a guard is wrong. |
| **Ids from imported modules** | Example 3's tests write `account = "a1"` for an `Id<idn.Account>`. No module can build such an id until modules are linked. | Text is accepted for ids of imported modules for now. |
| **The GBNF export approximates** | GBNF cannot exclude reserved words from identifiers, and cannot look ahead, so whitespace is required after every word-like token. | Documented in `scripts/export-gbnf.mjs`. The forced spacing (`caller .id`) is less natural for a model, a fairness question for H1 that the pilot report must state. |
| **Implementation choices** | The store uses Node's built-in `node:sqlite` instead of `better-sqlite3`: the same synchronous API with no native build. Records sit in one generic table; per-entity tables arrive with code generation. A whole step, reads included, runs inside `BEGIN IMMEDIATE`, so steps stay serializable across processes. | No effect on the semantics. |
| **Not done in milestone 2** | Effects are queued in the outbox but not dispatched, so `confirm` and `compensate` do not run yet (milestone 4). The JSON Schema for graph operations waits for the operations themselves (milestone 6). **The H1 pilot has not run.** | The pilot needs model access, a budget, and task authors independent of the design (Phase 7, 7.1). Those are decisions for a person. |

## Milestone 1: the calculator end to end

Milestone 1 built the parser, canonical printer, hashes, name resolution, type checker, Z3 bridge, reference interpreter, test runner and the `charter` command. These are its findings, in order of importance.

| Finding | Detail | Resolution |
|---|---|---|
| **A hand-derived proof in Phase 5 was wrong** | Phase 5 claimed the calculator's `a + b` and `a - b` are proven to stay in range. The real verifier keeps them as runtime checks. `calculate` takes plain `Decimal` parameters, not the bounded `Input` type, so its inputs have no bounds inside the function. | Recorded in conformance case `c001`. This is the kind of difference the milestone 3 exit criterion anticipated: hand derivations can be wrong. |
| **Large integer literals** | The calculator's test passes `10000000000000000`, which is above the `Int` range of A4, to a `Decimal` parameter. A literal's type depends on where it is used. | New amendment A21. |
| **No empty Set or Map literal** | `{}` does not parse, because a record literal needs a field. Nothing else denotes an empty set or map. | An open grammar question for milestone 2, recorded in case `c008`. |
| **The milestone 0 layer rule had false positives** | It read the parser's method named `import` as a dynamic import. | The rule now skips method definitions and member calls. Tests cover both, plus the ternary case that a naive fix would have let through. |
| **The Phase 8 demo output was optimistic** | Section 8.4 predicted "2 runtime range checks (Mul, Div)". The real run has 4, for the reason in the first row. | The demo output in the README is the measured one. |
| **Tooling deviation** | Phase 8 chose Vitest. Milestone 1 uses Node's built-in test runner, because it runs TypeScript directly with no extra dependency. | No effect on the design. |
| **Coverage criterion narrowed** | Phase 8 asked for every production in a passing and a failing case. Milestone 1 checks that every one of the 74 syntactic productions appears in a passing case. | Failing-case coverage per production is left for milestone 2. |

**What milestone 1 checks fully, and what it defers.** Types, enums, functions, queries, and tests and properties that call queries are fully checked, proven and run. Entities, rules, permissions, invariants, asserts, events, triggers and migrations are parsed and resolved. The checker reports them with an info message (`CH0901`) rather than accepting them silently. They are checked from milestone 2.

## Milestone 0: grammar and corpus

Milestone 0 checked the design with tools for the first time. It merged every grammar amendment into `spec/charter.ebnf`, checked the grammar for well-formedness, and parsed every Charter listing from Phases 2, 5 and 6 against it. This section records what that found. The phases above are kept as written; this list says where they were wrong or incomplete.

### Grammar amendments A14 to A20

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

### Other corrections

| Where | Correction |
|---|---|
| Phase 3, section 3.1 | The pipeline table pointed to 3.7 for the anti-weakening rule and to 3.5 for the impact report. The correct sections are 3.10 and 3.6. Fixed in this document. |
| Phases 1, 5 and 8 | The grammar was estimated at "about 60" and later "about 65" productions. Measured, the frozen grammar has 74 syntactic rules, or 83 productions including lexical rules. Most of the difference comes from splitting the clause rule into ten named sub-rules, which does not add syntax. Phase 1's informal target for constrained decoding was missed. That makes the H1 pilot more important, not less. |
| Phase 5, example 3 | The property `then (result == ok) == …` does not parse, as Phase 5 itself noted. It is now the negative conformance case `n003`, which flips to a passing case when milestone 2 settles outcome comparison. |
| Phase 5, example 3 | The test `then count x in Collaborator where x.project == p.id == 0` parses, and means `(count …) == 0`, because comparisons do not chain. This reading is now written into the grammar's disambiguation rule. |
| Phase 5, example 5 | Besides the five gaps listed there, the module used `idn.Account` without importing `identity`. The conformance case adds the import and a `rejects` declaration. |
| Phase 2, section 2.10 | Under amendment A17, the example's trailing `req R-1, R-2` links to the `emit` clause, not to the whole rule. The meaning is the same here, but the link sits on a different node. |

### What milestone 0 did not check

The recognizer in `scripts/grammar.mjs` checks that a program belongs to the grammar. It does not apply the longest-match rule, build a syntax tree, or check types. Milestone 1's real parser now agrees with the recognizer on every corpus case and on about 1,900 fuzzed inputs.
