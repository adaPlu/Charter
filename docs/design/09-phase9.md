# Phase 9: Roadmap and open problems

This phase sorts future work by how much is actually known, not by how exciting it is.

| Group | Meaning | Rough horizon |
|---|---|---|
| **Near-term engineering** | Known techniques. The work is building it, not discovering it. | Within about two years of the MVP |
| **Plausible research** | There is a credible approach, but nobody knows yet whether it works | Needs experiments before anyone commits to it |
| **Speculative** | No credible approach yet, or it depends on breakthroughs elsewhere | Not planned |

## 9.1 Near-term engineering

| Item | Why | Builds on |
|---|---|---|
| WebAssembly target, with full 64-bit `Int` restored | Reaches mobile, Android, browsers and edge servers through one backend | The Phase 4 target decision, and A4 |
| Postgres store with multi-writer concurrency | Removes the single-writer ceiling. Postgres `SERIALIZABLE` isolation keeps the same step semantics. | Phase 4. The serializability claim must be revalidated with the differential tests. |
| `tick` rules and per-match partitioned state | Lets Charter own real-time simulation, not just progression | Example 5's list of gaps |
| More loop idioms in the verifier, plus cvc5 as a cross-checking solver | Recovers proofs that currently fall back to runtime checks | Phase 5, example 5 |
| User-defined capabilities as library modules | New effects without changing the language | Phase 2's out-of-scope list |
| Multi-currency Money | Real commerce needs it | Phase 2 |
| A package registry addressed by content hash, with signed packages | Reproducible dependencies | The lockfile from Phase 2 |
| **Capability attenuation for packages** | An imported package gets only the capabilities the app explicitly passes to it, which blocks a whole class of supply-chain attacks | The capability manifest from Phase 4 |
| Importers from existing database schemas and OpenAPI files | Lets existing systems adopt Charter gradually, instead of only new projects | The graph operations from Phase 3 |
| Automatic merging of non-overlapping change sets | See 9.2 | The transitive hashes from Phase 3 |

## 9.2 The long-term topics

### Multi-agent programming

**What Charter already provides.** AI agents use the same interface as humans:
- typed operations;
- change sets with `base` hashes;
- impact reports;
- roles.

Agents propose and never approve (Phase 6).

| Group | Item |
|---|---|
| Near-term | **Specialized agents** for requirements, test generation, proof repair and performance. Each one is just another proposer of change sets. |
| Near-term | **Provable merging.** Two change sets commute when neither one's changed set overlaps the other's affected set. The transitive hashes can check that deterministically, so such pairs merge with no human conflict resolution. |
| Plausible research | **Agents proposing merges** for overlapping change sets, with the merged result going to a human |
| Plausible research | **Agent review as a signal.** Can a second agent's review measurably lower human miss rates in the fatigue study? Agent reviews never count as approvals. |
| Speculative | Self-organizing teams of agents that divide up a whole application with no human planning |

**A hazard to design against: agents agreeing with each other.** Several agents built on similar models can share the same blind spot. Agent approvals therefore count as zero. Only a human approval, or a deterministic check, ever counts.

### Agents exchanging executable specifications

A Charter module already bundles a specification with its evidence:
- requirements;
- asserts and invariants;
- a capability manifest;
- proof results;
- a list of what it assumes.

| Group | Item |
|---|---|
| Near-term | **Never trust, always recheck.** An agent receiving a module reruns the verifier itself, instead of trusting the sender's proof claims. The "Assumed" items in a dependency flow up into the consumer's build report automatically. |
| Near-term | **Foreign text is data.** Requirement text from another agent, or from any outside source, may contain instructions aimed at the receiving model. The intent layer quotes such text as data and never feeds it to an LLM as instructions. |
| Plausible research | **Interfaces without implementations.** One agent publishes types, asserts and invariants. Another supplies the rules. The verifier checks that the implementation refines the interface, including its permissions and effects. Refinement checking is well known, but doing it for permission and effect semantics across modules is not. |
| Speculative | Open marketplaces where agents trade specifications, with incentives and reputation in place of trust |

### Self-optimization under explicit constraints

| Group | Item |
|---|---|
| Near-term | **Optimizing the compilation, not the program.** Index choices, partitioning and query plans can be tuned automatically from production traces. The program and its semantics stay untouched. |
| Near-term | **Automatic refactors that are proven equivalent.** An agent may apply a performance rewrite without a human only if all of these hold: equivalence is **proven**, not just tested; nothing changes in permissions, effects or schema; all tests pass; and the measured gain clears a threshold. Each one is still a logged change set that can be rolled back. |
| Plausible research | **Declared relaxations.** For example, "reads may be up to 30 seconds stale" stated as a requirement. Optimizers could then use that freedom, and the verifier would check the bound. It needs a precise language for relaxations. |
| Speculative | Programs that renegotiate their own constraints at runtime |

**What stays excluded: programs that rewrite their own requirements.** Requirements change only through humans. That holds at every level of autonomy in 9.3.

### AI-generated libraries

| Group | Item |
|---|---|
| Near-term | Registry rules: a package must ship conformance tests, a capability manifest and a build report. Its "Assumed" items propagate to everything that uses it. |
| Plausible research | **Trustworthy adapters.** Adapters are the weakest link, as Phases 4 and 5 found. One route is generating adapters plus conformance suites, then differential-testing them against the provider's sandbox. |
| Plausible research | **Verified extern functions,** written in a verification language such as Dafny or Lean and compiled to the target. That would shrink the "Assumed" section. |
| Speculative | A standard library that grows and improves itself with no human curation |

### Whole-application specification

| Group | Item |
|---|---|
| Near-term | Cross-platform clients generated from the same rule and query signatures, through the Wasm target and the typed client |
| Plausible research | **The user interface as a projection.** Screens could be derived from queries and rules, as in The Elm Architecture, so the UI can never offer an action the user's permissions don't allow. Accessibility rules could be checked the same way. |
| Plausible research | **Systems of many services.** Several Charter modules communicating through events, with end-to-end invariants such as "no order is both refunded and shipped". Composed event protocols could be checked with bounded model checking, as the P language does. Whole-system invariants across services are a hard research problem. |
| Speculative | A whole application, including its infrastructure, deployment topology and service-level objectives, specified and verified end to end |
| Speculative, and probably the wrong tool | **Operating systems.** Charter's model of bounded transactional steps is wrong for kernels and drivers. The capability ideas carry over. The language does not. |

## 9.3 A ladder for autonomy

"Autonomous AI software engineering" is not one switch. It is a ladder, and each rung must be earned with evidence of the kind gathered in Phase 7.

| Level | The AI may | A human must | Evidence needed to climb |
|---|---|---|---|
| 0 | Nothing | Write all of it | n/a |
| **1 (the MVP)** | Draft change sets | Approve every change set | n/a |
| 2 | Apply proven-equivalent, low-risk refactors by itself | Approve everything else, and audit the log | Very few problems found when auditing automatically applied refactors |
| 3 | Also apply additive changes that implement **confirmed** requirements, with full verification | Approve medium and high risk | Fatigue study miss rates low, and the entailment check's recall good enough |
| 4 | Work within a policy envelope: budgets, capability limits and approved areas of the program | Set the envelope and audit | A sustained record at level 3 |

**One thing no level permits: the AI confirming requirements.** Deciding what the software should do stays with people. Everything else on the ladder is about *how* the software does it.

## 9.4 The hardest unresolved problems

1. **The specification is the bottleneck.** Every proof in Charter is relative to its requirements. If the requirement is wrong, a verified program faithfully does the wrong thing. The gloss and the round-trip check help people notice, but checking that requirements match what someone really wants is unsolved, in Charter and everywhere else.
2. **Entailment can't be checked deterministically.** Whether a guard is justified by a requirement's text is a question about natural language. Phase 6 found the gap and added an advisory LLM check, which narrows it without closing it.
3. **Decidability fights expressiveness.** Every feature added to Charter pushes obligations outside the solver's fragment: sets, nonlinear arithmetic, loops, invariants over two states. As programs grow, the proven share may shrink. Nobody yet knows what that share looks like on real applications.
4. **The trusted base is large.** The parser, checker, SMT encoding, solver, compiler, runtime, SQLite and adapters are all unverified. Verified compilers such as CompCert and CakeML show it can be done, at great cost. Differential testing reduces the risk without eliminating it.
5. **Liveness depends on the outside world.** "Every order is eventually charged or refunded" depends on payment providers and operators. Monitoring stands in for proof, and probably always will.
6. **Edit locality may not scale.** H2 is measured on programs of up to about 50 rules. In large programs, hub entities like `User` sit in almost every dependency chain, which could make every affected set huge and every impact report useless. Field-level dependencies might fix that, at real cost in complexity.
7. **Novelty fights familiarity.** If H1 fails because models know TypeScript too well, Charter may need to become a TypeScript-shaped surface over its graph. At that point, how much of it is still a new language?
8. **Human review may not scale.** Whether people can meaningfully approve AI-written changes at high volume is a social problem as much as a technical one. Risk-scaled friction and witness sentences are hopeful designs, not solutions.
9. **Missed ambiguities are invisible.** The engine can only ask about ambiguities it notices. The hash test filters out pointless questions, but nothing detects the important question nobody thought to ask.
10. **Data lives longer than code.** Invariants added later can fail on years of old data. Phase 6's authentication example needed a two-step deployment with an operator action in between. General, safe data repair alongside migrations is unsolved.
11. **The intent layer is an attack surface.** Prompt injection can arrive through requirement text, shared chat channels, imported specifications or even data. "The LLM proposes, deterministic tools decide" limits the damage. It does not stop a successful injection from shaping what gets proposed.
12. **The thing being measured keeps moving.** Models change every few months. A result showing Charter beats TypeScript on 2026 models may not hold for 2027 models. Evaluations have to be repeated, not cited forever.

## 9.5 What is genuinely new, after nine phases

The semantics are almost entirely borrowed:
- Event-B's guarded events and invariants;
- Datalog's rules;
- Unison's content addressing;
- Cedar's deny-by-default permissions;
- Elm's managed effects;
- Dafny's built-in verification;
- the transactional outbox and saga patterns.

That is deliberate.

**The new parts are about how humans, AI and tools divide the work:**
1. **Requirement provenance enforced by the toolchain.** Confirmed, inferred and open are statuses the operation applier and release gate enforce, not labels.
2. **"Unrelated behavior" made computable.** Typed graph edits plus transitive hashes over behavioral dependencies turn "don't change anything else" into four mechanical conditions.
3. **The LLM proposes, deterministic tools decide.** Add the anti-weakening rule, and the AI can draft and repair without being able to quietly lower the bar.
4. **Review by witness.** Permission changes are shown as concrete people and situations taken from solver output, not as formulas.
5. **A language co-designed with constrained decoding.** The grammar and the operation schema are shaped so model output always parses.

Whether these five ideas improve AI software development is exactly what Phase 7 is built to find out.

## 9.6 Where the whole design stands

| Item | Status |
|---|---|
| Design across nine phases | Complete |
| Language amendments | A1 to A13 from the design, plus A14 to A20 from milestone 0. The frozen grammar has 74 syntactic rules (83 productions with lexical rules). |
| Code | Milestones 0 and 1: the toolchain checks, proves, runs and tests the pure part of Charter. Everything involving rules, entities and the store is still derived by hand. |
| First real evidence | Milestone 1, when the real solver proves the calculator's division safe |
| First go/no-go decision | The H1 pilot, about four months into the build |
| Biggest bets | H1, that models generate Charter more reliably than TypeScript, and H2, that edits stay local at scale |

## Final checkpoint

**Decisions:**
- Future work is sorted into near-term engineering, plausible research and speculation.
- Autonomy grows along a five-level ladder, each level gated by evidence. No level lets the AI confirm requirements.
- Imported specifications are always rechecked, never trusted, and their text is treated as data.
- Self-optimization is allowed automatically only for proven-equivalent changes.

**Open problems:** the twelve listed in 9.4. The most fundamental is the first. Verification can prove a program matches its requirements, but not that the requirements are right.

**Risks:** the risks from every earlier checkpoint still apply. The largest is concentrated in two places. The H1 pilot could end the project early, which is intended. Milestone 3 could show that much less is provable than the hand derivations suggested.
