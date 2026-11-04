# Phase 7: Evaluation

Nothing here has been run. The sample sizes are planning estimates, and the pilot will confirm them by simulation. Decision rules are stated in advance, so a result can't be reinterpreted after the fact.

## 7.0 What the evaluation must answer

Phase 1 set a bar for each hypothesis. It also said Charter fails as an AI-native language if H1 and H2 both fail, even when H3 passes. This phase turns those bars into experiments with pre-registered pass and fail rules.

| Hypothesis | Phase 1 bar | Primary experiment |
|---|---|---|
| H1, generation reliability | 15 points or more above TypeScript on valid-on-first-try, with semantic pass rate no worse | 7.3: building new programs |
| H2, edit locality | At least 50% fewer unintended behavior changes | 7.4: change requests |
| H3, verifiability | At least twice TypeScript's rate of catching seeded defects before runtime | 7.5: seeded defects |
| H4, fidelity | Higher detection of misreadings, in less time, than reading TypeScript | 7.6: human study |

Four supporting studies cover risks raised in earlier phases: review fatigue, the accuracy of the entailment check, runtime performance, and system health metrics.

## 7.1 The benchmark suite

**Task families:**

| Family | Example | Build tasks | Change requests | Seeded defects | Seeded misreadings |
|---|---|---|---|---|---|
| F1 Computation and validation | Pricing rules, form validation | 20 | 16 | 8 | 6 |
| F2 CRUD with persistence | To-do lists, inventories, bookings | 20 | 20 | 10 | 8 |
| F3 Authorization | Multi-tenant projects, role hierarchies | 20 | 24 | 16 | 10 |
| F4 Transactions and money | Orders, wallets, refunds | 20 | 24 | 16 | 10 |
| F5 Workflows with events and effects | Approvals, notifications, retries | 20 | 16 | 10 | 6 |
| **F6 Outside Charter's sweet spot** | Text parsing, graph search, scheduling algorithms | 20 | 0 | 0 | 0 |
| **Total** | | **120** | **100** | **60** | **40** |

**F6 exists to measure where Charter loses.** These tasks lean on general-purpose computation that Charter pushes into `extern fn`. A benchmark made only of Charter's strengths would be marketing, not evaluation. Results are always reported per family, never only as an aggregate.

The 100 change requests are applied to 25 base programs. Five of those programs are large, with more than 50 rules, so H2 isn't measured only on toy programs.

**Each task carries:**
- a request written in plain language, the way a non-programmer would write it;
- a frozen **HTTP contract**, giving routes, request bodies and response shapes;
- a **hidden test suite** run against the HTTP contract. It is black-box, so the same tests run unchanged against the Charter app and the TypeScript app;
- **labels** marking which hidden tests are "unrelated" for each change request, set before any implementation exists;
- a few **visible example tests**, the same for every arm.

```yaml
# [ILLUSTRATIVE] one task card
id: F4-07
request: >
  Customers can top up a wallet and pay for items from it. A wallet can never go below zero.
  If a payment fails halfway, nobody should lose money.
contract: openapi/F4-07.yaml
hidden_tests: 38          # including 6 concurrency tests and 4 failure-injection tests
visible_tests: 4
authors: [author-K, author-M]          # independent of the Charter design team
reviewed_by: [reviewer-P]
```

**Who writes the tasks.** Task authors are independent of the Charter design team. They write the request and the hidden tests before seeing any implementation in either language. A second reviewer checks every hidden test for ambiguity. When a test's expected behavior isn't determined by the request, it is removed. A test the request doesn't settle would measure luck, not capability.

**Protecting against contamination.** All tasks are new, written for this benchmark. Each task carries a canary string so leaks can be detected. A held-out split of 30% stays private and is rotated after each published round.

## 7.2 The arms of the experiment

The biggest confound is **decoding**. Under grammar-constrained decoding, Charter's syntax errors are impossible by construction, and TypeScript can be constrained the same way. A 2 × 2 design separates the effect of the language from the effect of the decoder.

| Arm | Language | Decoding | Feedback for repair |
|---|---|---|---|
| **A** | Charter | Constrained to the grammar and operation schema | Checker and verifier diagnostics |
| **B** | TypeScript | Free | `tsc --strict` and ESLint diagnostics |
| **C** | Charter | Free text, parsed afterwards | Same as A |
| **D** | TypeScript | Constrained to a TypeScript grammar, syntax only | Same as B |
| E, an ablation | Charter | Constrained JSON operations instead of text | Same as A |

**Making the comparison fair:**
- **Same budgets.** Every arm gets the same token budget, the same 3 repair attempts and the same visible tests.
- **Same app scaffold.** TypeScript gets a scaffold from experts: Node.js, SQLite, a validation library, and a project layout that already satisfies the HTTP contract. A weak baseline would inflate Charter's results.
- **Matched tuning effort.** A TypeScript expert team tunes the baseline prompts with the same number of hours the Charter team spends on its own prompts.
- **Charter pays for its manual.** Charter has no presence in training data, so its arms get the language manual in context. Those tokens count against Charter's budget and appear in every token metric.

**A secondary Python arm** with free decoding is included for H1 only. It is cheap to add and widens the comparison beyond one baseline language.

**Models.** Four pinned models are used:
- two frontier models from different providers;
- one large open-weights model;
- one small open-weights model, around 8 billion parameters.

The small model tests portability. If Charter only helps frontier models, that matters.

**Runs per task.** Each combination of task, arm and model gets 5 samples at the provider's default temperature, plus 1 run at temperature 0. That gives 120 tasks × 4 main arms × 4 models × 5 samples, or 9,600 sampled runs, for H1.

## 7.3 H1: building new programs

**Metrics:**

| Metric | Definition |
|---|---|
| **valid@1** | The first output passes the full static check with no repair. For Charter, that means types, refinement obligations and effect containment. For TypeScript, it means `tsc --strict` passes. |
| valid@repair | Valid within 3 repair attempts |
| **Semantic pass rate** | The share of hidden tests passed by the final program |
| Task success | Every hidden test passes |
| Tokens per task | All input and output tokens, including the Charter manual and every repair round |

Under constrained decoding, syntactic validity is 100% by construction. That is why valid@1 uses the full static check, not parsing alone.

**Analysis**, pre-registered:
- **The model.** Success is modeled as a function of language and decoding together, with task and model as random effects. This is a mixed-effects logistic regression.
- **The primary contrast** compares Charter and TypeScript under the **same** decoding, A against D. A against B is reported but is not the test, because it mixes the language effect with the decoder effect.
- **Semantic pass rate** uses a non-inferiority test with a margin of 3 points.

**Decision rule:**

| Outcome | Condition |
|---|---|
| **H1 supported** | The lower 95% confidence bound for the A − D difference in valid@1 is at least 15 points, **and** semantic pass rate is non-inferior |
| **H1 falsified** | The upper bound of the valid@1 difference is below 15 points, **or** semantic pass rate is worse than TypeScript by more than the margin |
| Inconclusive | Anything else. The result is reported as inconclusive, not as a partial win. |

**What the ablations add:**
- **C against A** shows how much of Charter's result comes from the decoder rather than the language.
- **E against A** shows whether JSON operations beat text as the form for AI output.

**The pilot runs first.** It is a go/no-go gate before Phase 8's second milestone, as Phase 1 promised. It uses 20 tasks, 2 models, arms A and D, and 3 samples each. **The kill criterion:** if the observed valid@1 gain is under 5 points **and** semantic pass rate is lower, development stops for a design review instead of continuing toward the full study.

## 7.4 H2: change requests

**Setup.** Each of the 25 base programs exists in both languages as a reference implementation written by hand. Both versions pass the same hidden tests. Each model then applies the 100 change requests.

**Metrics:**

| Metric | Definition |
|---|---|
| **Unintended change rate** | The share of change requests where any "unrelated" hidden test fails afterwards, **or** where differential testing finds divergence |
| Differential divergence | 1,000 random request sequences against unrelated endpoints, before and after the change, compared response by response |
| Change success | The hidden tests for the requested behavior pass |
| Edit size | Lines changed in TypeScript. Graph operations and changed nodes in Charter. |

**Two conditions, reported separately:**
1. **Language only.** The AI's raw change, with no gates. This isolates what the representation itself contributes.
2. **With tooling.** Charter's four conditions from Phase 3 reject changes and send them back for repair. The TypeScript analogue gets a git diff and a rerun of the visible tests, with the same repair budget.

**Analysis.** The rate ratio, Charter over TypeScript, is estimated with the same kind of mixed-effects model, with task and model as random effects.

| Outcome | Condition, in the language-only condition |
|---|---|
| **H2 supported** | The upper 95% bound of the rate ratio is at most 0.5 |
| **H2 falsified** | The lower bound is above 0.5, meaning the reduction is confidently smaller than half |
| Inconclusive | Anything else |

The language-only condition is primary. The tooling condition is the more practical number, but it partly measures the gates rather than the language.

## 7.5 H3: seeded defects

**Defect taxonomy.** Defects are drawn from external sources rather than invented by the designers: CWE categories for authorization, the OWASP Top 10, and published incident write-ups.

| Defect class | Example |
|---|---|
| Missing permission check | An edit route with no ownership check |
| Wrong comparison | `>` where `>=` was required |
| Race condition | Check-then-act across two transactions |
| Balance or stock goes negative | A missing guard |
| Missing compensation | A failed charge that leaves stock reserved |
| Dangling reference | Deleting a parent leaves children behind |
| Division by zero, overflow | Unvalidated input |
| Wrong rounding | Money rounded in the wrong direction |
| Information leak | Returning a whole user record with its email |

**Setup.** Each defect is seeded into equivalent spots in both language versions of the same program. A separate team does the seeding, independent of both the designers and the task authors.

**What counts as detection.** The TypeScript baseline is deliberately strong. It runs `tsc --strict`, ESLint with security plugins, and a commercial-grade static analyzer such as CodeQL.

| Category | Charter | TypeScript |
|---|---|---|
| **Caught statically** | Checker error, or verifier Refuted | Any of the baseline tools flags it |
| **Prevented by construction** | The defect cannot be written. One example is a race between two transactions, since every step is serializable. | Not applicable |
| Caught by generated tests | Fails a generated test | Fails a generated test |
| Missed | None of the above | None of the above |

**The primary metric is "caught or prevented before runtime", with the breakdown always shown.** Counting prevention could look generous, so both numbers are reported, and readers can apply the stricter one.

**False positives are measured too.** Both toolchains run on 60 correct programs. Any spurious error counts as a false positive. An Unproven result in Charter does not count, because it is a warning with a runtime check, not an error.

**Analysis.** Comparisons are paired by defect: the same defect, caught in one language and not the other. The detection ratio gets a bootstrap confidence interval.

| Outcome | Condition |
|---|---|
| **H3 supported** | The lower 95% bound of the ratio, Charter over TypeScript, for caught or prevented is at least 2, **and** the false-positive rate is no higher than TypeScript's |
| **H3 falsified** | The upper bound is below 2 |
| Inconclusive | Anything else |

## 7.6 H4: human study on detecting misreadings

**Participants:** 48 people.
- **24 domain experts with no programming background**, such as product managers and operations staff. These are Charter's intended users.
- **24 developers.**

**Materials.** There are 40 programs. Each one is correct except for one seeded misreading of its requirements. For example, "admins can view everything" might be implemented as "admins can edit everything".

**Conditions** are within-subject, with the order balanced across participants by a Latin square:

| Condition | What participants read |
|---|---|
| **G** | Charter's deterministic gloss |
| **S** | An LLM-written summary of the TypeScript code |
| T | The generated TypeScript (developers only) |
| F | Charter's formal source (developers only) |

**The primary comparison is G against S.** Asking an AI to explain TypeScript code is what people would do without Charter. If the gloss can't beat that, H4's practical claim fails, whatever it shows against raw code.

**What is measured:**
- whether each misreading was found, and how long it took;
- false alarms, meaning correct behavior reported as wrong;
- the participant's confidence.

**Analysis.** Detection uses a mixed-effects logistic model, with participant and program as random effects. Time to detection uses a mixed-effects survival model.

| Outcome | Condition |
|---|---|
| **H4 supported** | G finds more misreadings than S, with the 95% confidence interval excluding zero, and is no slower |
| **H4 falsified** | G's detection rate is not higher than S's, meaning the interval includes zero or favors S |
| Inconclusive | Anything else |

**Bias controls:**
- **Neutral labels.** Materials carry neutral labels such as "Format 1" and "Format 2". No Charter branding appears, to reduce novelty effects.
- **Equal training.** Participants get the same short training on every format.

**Sample size.** The estimate is about 80% power to detect a 12 to 15 point difference in detection rate, for example 60% against 75%. That assumes moderate correlation within participants and within programs. The pilot's simulation will confirm this before recruitment.

## 7.7 Supporting studies

**Review fatigue**, from Phase 6:
- **Setup.** Each of 30 participants reviews 30 change sets in one session. 10% of the change sets contain a planted risky item, such as an unrelated permission quietly loosened.
- **Conditions.** Charter's review card, compared with a standard pull-request diff plus an AI summary.
- **Measures.** How often planted items are missed, **and whether misses increase later in the session**, along with time per card.
- **Setting.** This runs only in a lab, never with planted changes in real projects.

**Accuracy of the entailment check.** People label 300 real AI operations as stated or not stated by the requirement they cite. The advisory check's precision and recall are measured against those labels. Phase 6 flagged this check as the weak point closing the citation gap, so its miss rate is reported prominently.

**Runtime performance.** This checks the Phase 4 throughput estimate:
- **Workload.** Example 4's `PlaceOrder` under contention.
- **Measures.** Throughput, plus p50 and p95 latency.
- **Comparison.** An idiomatic hand-written TypeScript app on the same SQLite stack.
- **Target.** The generated app is within 2× of the hand-written one. Missing that target doesn't falsify a hypothesis, but it is reported as a cost.

**System health metrics,** collected on every benchmark run:

| Metric | Why it matters |
|---|---|
| Share of operations produced by deterministic lowering | A Phase 3 risk: if this is low, determinism is mostly marketing |
| Distribution of Proven, Unproven and Refuted results | Shows how often verification really reaches proof |
| Solver time per obligation | Shows whether the decidable fragment stays fast on realistic programs |
| Questions asked per task, and how useful raters judged them | Measures over-asking and under-asking |
| Inferred requirements approved within 5 seconds | An early signal of rubber-stamping |
| Variance in success across models | Portability |
| Tokens per task, by phase | The cost of the manual and of repair loops |

## 7.8 Threats to validity

| Threat | Direction | Mitigation |
|---|---|---|
| **Training-data familiarity.** TypeScript is everywhere in training data, and Charter is absent. | Against Charter, so a Charter win is conservative | Report the cost of the manual in tokens. Rerun after models could have seen Charter, to separate the language's effect from familiarity. |
| **The designers chose the battlefield** | For Charter | Independent task authors, the F6 family outside the sweet spot, and per-family reporting |
| **Tests shaped by one paradigm** | Either way | Black-box HTTP tests, written before any implementation exists |
| **A weak baseline** | For Charter | Expert scaffold, matched tuning hours, strong static analysis for H3 |
| **Selection bias in seeded defects** | For Charter | Taxonomy from external sources, independent seeders |
| **Counting prevention as detection** | For Charter | Always report both numbers |
| **Novelty effect in the human study** | For Charter | Neutral labels, equal training, an AI-summary baseline |
| **Prototype bugs** | Against Charter | Infrastructure failures are logged and reported separately from model failures |
| **Benchmark leakage** | Either way | A private held-out split, canary strings, rotation |
| **Small programs** | For Charter, since its strengths may fade at scale | Five large base programs for H2, with results reported separately |
| **Model randomness** | Either way | Five samples per cell, with variance reported |
| **Construct validity.** valid@1 is not the same as usefulness. | Either way | The semantic pass rate and the human studies carry equal weight |

**Pre-registration.** The hypotheses, metrics, decision rules, exclusion criteria and analysis code are registered publicly before the full study runs. The Charter grammar version is frozen for the study, as Phase 5 warned. **Every result gets published, including the negative ones.** A failed H1 or H2 is a finding, not something to bury.

## 7.9 What each outcome would mean

| Result | Interpretation | Response |
|---|---|---|
| H1 and H2 supported | Charter's central claim holds | Continue to a public release |
| H1 fails, H2 holds | The language isn't easier to generate, but edits stay local | Keep the graph and operations. Consider putting a TypeScript-like surface over the same graph. |
| H1 holds, H2 fails | Generation is easier, but edits leak | Rework the identity and dependency design from Phases 2 and 3 |
| **H1 and H2 both fail** | **Charter fails as an AI-native language,** as Phase 1 defined | Salvage H3 and H4 as tools: a verifier and gloss for existing languages |
| Only the C against A ablation shows an effect | The gain comes from constrained decoding, not the language | Say so plainly. That is a result about decoders. |
| H4 fails against S but beats T | Gloss beats raw code but not AI summaries | The deterministic gloss stays for auditing, but the friendliness claim is dropped |

## Checkpoint

**Decisions:**
- A benchmark of 120 build tasks, 100 change requests, 60 seeded defects and 40 seeded misreadings. It includes a family outside Charter's sweet spot, and every test is black-box over HTTP.
- A 2 × 2 design of language against decoding, plus ablations, so the language's effect is separated from the decoder's.
- Four pinned models, including a small open-weights one. Five samples per cell.
- Pre-registered decision rules for H1 through H4, each with a supported, falsified and inconclusive outcome.
- The primary H4 comparison is the gloss against an AI summary of TypeScript, not against raw code.
- A pilot with a kill criterion, run before the second milestone of Phase 8.
- Supporting studies on review fatigue, the entailment check, runtime performance and system health.

**Open questions:**
- **Do the bars hold up?** The 15-point and 2× bars from Phase 1 were chosen before any data existed. The pilot may show they are unrealistic in either direction. Changing them after the pilot is allowed only before full pre-registration, and the change must be recorded.
- **Recruitment.** Domain experts with no programming background are harder to recruit than developers. A smaller expert sample would weaken H4's most important comparison.
- **Who pays for compute?** Roughly 10,000 sampled runs for H1, plus H2, means real API costs for frontier models. The pilot should produce a cost estimate.

**Risks:**
- **An inconclusive result is the likeliest outcome.** Effects may be real but smaller than the bars. The pre-registered "inconclusive" label prevents spinning that as success, but it may also stall funding.
- **The benchmark becomes the target.** Tuning Charter's prompts against the visible tasks can overfit. The private held-out split is the defense, and it must stay private.
- **Prototype quality may decide H1 more than language design does.** A buggy checker produces false errors that lower valid@1. Infrastructure failures are separated in reporting, but the risk remains.
