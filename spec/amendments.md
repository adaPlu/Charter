# Charter amendments

Every change to the language after the Phase 2 specification is listed here and in [amendments.json](amendments.json). Grammar amendments must have at least one conformance case before they land. Other amendments must have one by the milestone shown. `scripts/check-conformance.mjs` enforces both rules.

A1 to A13 came from the design phases. A14 to A20 came from milestone 0, while checking the Phase 5 examples against the merged grammar. A21 came from milestone 1, when the calculator's tests first ran. A22 to A25 settle the open questions that the design doc, section 8.6, assigned to milestone 2. With them the grammar is frozen for the H1 pilot. A26 reopened the freeze once, before any model run, because two draft pilot tasks showed that a program with users could not offer a public query. A27, also before any model run, allows general recursion in `fn`; it changes no grammar.

Two other milestone 2 questions were decided without an amendment. Invariants that compare two states, with `old(…)`, are deferred until after the MVP, and properties cover those cases meanwhile. Money rounding stays one program-wide rule, half to even, recorded as an `inferred` default that a person must confirm.

| ID | Kind | Due | Amendment |
|---|---|---|---|
| A1 | semantics | M6 | Transitive hashes cover behavioral dependencies. A rule depends on every invariant and assert over entities it writes, on rules its events trigger, and on the capabilities it uses. |
| A2 | grammar | M0 | `assert Name: Rule permitted implies e` and `… succeeds implies e`. Static only, checked by SMT, never compiled. |
| A3 | semantics | M3 | A compensation inherits the refinements of the parameters it captures. |
| A4 | semantics | M1 | In the MVP, `Int` is the range ±(2⁵³ − 1). Leaving it is an overflow fault. |
| A5 | tooling | M1 | The verifier uses Z3's deterministic resource limit, not a wall-clock timeout. Proof results are cached by obligation hash. |
| A6 | runtime | M4 | Capabilities declare `idempotent` or `at-most-once` delivery. An ambiguous result is `Unknown` and goes to an operator. |
| A7 | runtime | M4 | A `Disabled` outcome for rules an operator has switched off. |
| A8 | grammar | M0 | `select e for x in coll [where c] [order by e, …]` builds a list. `none` sorts last. |
| A9 | grammar | M0 | `permit system` for internal steps only. `principal User by account` links the caller to an identity account. |
| A10 | runtime | M2 | New ids derive from the step's random seed as well as the step id, so they replay exactly but cannot be guessed. |
| A11 | grammar | M0 | `emit … confirm { … }` runs as a system step when the effect succeeds. |
| A12 | grammar | M0 | Tests and properties may contain several `when … expect` acts. `effects` lists the effects queued by the last act. |
| A13 | semantics | M1 | `Decimal` magnitudes stay below 10³⁸. Narrowing applies inside expression-level `if`. Standard library: `len`, `trim`, `lower`, `upper`, `contains`, `abs`, `min`, `max`. |
| A14 | grammar | M0 | Qualified names are allowed in types (`Id<idn.Account>`) and in trigger event names (`on idn.Registered`). Needed by Phase 5, example 3. |
| A15 | grammar | M0 | Version ranges may be partial: `^1`, `^1.0` or `^1.0.0`. Phase 5's `import identity@^1.0` did not parse before. |
| A16 | grammar | M0 | `type` and `enum` declarations accept `req` links. Phase 5's `type Input = … req R-5` did not parse before. |
| A17 | grammar | M0 | Rule-level `req` links come right after the signature, before `permit`. A `req` at the end of a rule belongs to its last clause. The Phase 2 grammar allowed both readings. |
| A18 | grammar | M0 | `not` may be applied to quantifiers, so `guard not exists …` parses. In Phase 2 it did not, although Phases 3 and 5 used it often. `count`, `sum` and `select` are primaries. Expressions after `where`, `:`, `then`, `else`, `=>`, `implies` and `=` extend as far right as possible. |
| A19 | grammar | M0 | Pattern binders may be `_`, as in `Error(_)`, which Phase 5, example 1 used. |
| A20 | grammar | M0 | Lexical rules are written down: identifiers, integers, decimals, strings, durations (`30s`), requirement ids (`R-12`) and versions (`0.1.0`). |
| A21 | semantics | M1 | An integer literal takes its type from where it is used. Where a `Decimal` or `Money` is expected, any size is allowed. Where an `Int` is expected, it must be within ±(2⁵³ − 1). Found because the calculator's test passes `10000000000000000` to a `Decimal` parameter, and that literal is above the `Int` range from A4. |
| A22 | grammar | M2 | `{}` is an empty literal whose type comes from where it is used: an empty `Set`, `Map` or record. Before this, Charter had no way to write an empty set or map. |
| A23 | grammar | M2 | In a test's `then` clauses, `accepted` is `true` when the act's outcome was `ok`. Phase 5, example 3 needed `result == ok`, which could not be written. |
| A24 | semantics | M2 | After a check such as `if pl != none`, a binding of type `E?` narrows to `E`, and `set pl.f = …` is allowed. Phase 5, example 5 needed this. |
| A25 | semantics | M2 | A query whose result type is an entity, or contains one, gets a warning (`CH0230`). It returns every field, including ones the caller may not be meant to see. Return a view record instead. This settles field-level read control for the MVP without new syntax. |
| A26 | grammar | M2 | `permit public` admits every caller, including one who is not signed in. Under a `principal`, `permit anyone` means any signed-in caller, so before A26 a program with users could not offer a public page. `caller` is a type error inside a `permit public` declaration. Found by the H1 pilot draft tasks p13 and p18, before any model run. It adds one reserved word, `public`. |
| A27 | semantics | M2 | A `fn` may call itself without restriction. Section 2.2 asked for total functions with structural recursion, but the checker never enforced it, and reading inside `Text` needs recursion on a growing prefix (found by H1 pilot tasks p19 and p21). A step still always ends: nested `fn` calls are capped at 250, and the 251st is a `recursion` fault, at the same depth on every machine and every replay. The cap bounds depth, not total work; a function that calls itself twice per step can still run for a very long time. The rule that a `fn` does not read state is unchanged, though the checker does not enforce it yet. No grammar change. |
