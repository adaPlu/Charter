# Phase 1: Foundations and architecture choice

## 1.1 Name and philosophy

**Name: Charter.**

A Charter program is a charter in the plain sense of the word. It says what state exists, who may change it, which actions are allowed, which effects each action may cause, and what must always stay true. People describe that charter in natural language. An AI writes it down as a formal, typed graph. Deterministic tools check it, prove what they can, compile it and run it. Charter does not try to be good at everything. It aims at the large class of software that is mostly state, rules, permissions and side effects: business apps, APIs, workflows and game servers. In that class, most bugs are broken rules rather than broken algorithms. Code that needs heavy computation calls out to foreign functions, which must declare their contracts.

## 1.2 What "AI-native" means, in measurable terms

Charter only counts as AI-native if it beats a TypeScript baseline on these metrics. Both sides get the same models, the same tasks and the same prompting budget, and neither side gets fine-tuning. The thresholds are starting proposals that Phase 7 refines.

| Metric | Hypothesis | Definition | Proposed bar |
|---|---|---|---|
| Valid-on-first-try rate | H1 | Share of generated programs that parse and type-check with no repair loop | 15 points or more above TypeScript |
| Semantic pass rate | H1 | Share that pass a hidden test suite written from the requirements | Equal to or above TypeScript |
| Blast radius | H2 | For each change request, the share of unrelated tests, proofs and graph nodes whose behavior changed | At least 50% lower |
| Static catch rate | H3 | Share of seeded requirement violations caught before runtime | At least 2× TypeScript with strict mode and lint |
| Misread detection | H4 | Share of seeded misinterpretations a reviewer spots, and how long it takes | Higher rate and less time than reading the generated TypeScript |

The four hypotheses:

- **H1 (Generation reliability).** LLMs produce syntactically and semantically valid programs more often in a small, regular, strongly typed, declarative core than in Python or TypeScript.
- **H2 (Edit locality).** Structured edits to a semantic graph cause fewer unintended behavior changes than text edits to conventional source.
- **H3 (Verifiability).** Expressing invariants, permissions and effects as first-class constructs catches more requirement violations before runtime.
- **H4 (Fidelity).** Round-tripping natural language to formal and back to natural language lets humans detect misinterpretation faster than reading generated conventional code.

Charter fails as an AI-native language if H1 and H2 both fail, even if H3 passes. A language that is merely easy to verify would just be another Dafny.

## 1.3 Prior art: what Charter takes and where it differs

| System | What it gets right | Charter's stance |
|---|---|---|
| Python, TypeScript | Huge training corpus and familiar syntax | Charter borrows TypeScript-like tokens for its surface syntax. It rejects unchecked effects and implicit mutation. |
| Rust | Ownership makes resource safety static | Charter skips ownership. Its state lives in a transactional store, not in raw memory. |
| SQL | Declarative state and transactions | Charter borrows its transactions and constraints. It adds rules, permissions and effects as first-class constructs. |
| Datalog, Prolog | Rules as source code and clear semantics | Charter borrows rules as its unit of behavior. It rejects unrestricted backtracking and ambiguity about the closed world. |
| Elm and its architecture | Managed effects and no runtime exceptions | Charter borrows the idea that effects are data executed by the runtime. |
| Dafny | Verification built into the language | Charter borrows SMT-backed checking. Its proofs cover invariants, not whole programs. |
| TLA+, Alloy, Event-B | Modeling state plus invariants | Charter borrows Event-B's guarded events and invariant preservation. Unlike these, it is executable and compiled. |
| Lean | Full proofs | Charter rejects this as too costly for its users. Lean stays an optional future backend. |
| P language | State machines that communicate by events | Charter borrows its event model for the multiplayer example. |
| Unison | Code that is addressed by content and hash | Charter borrows hash identity for its graph nodes, which keeps edits local and stable. |
| Dark, Ballerina | Integration and networking built in | Charter borrows the idea that effects are declared. It rejects Dark's lock-in to a hosted platform. |
| MLIR, LLVM IR, WebAssembly | Proven compiler infrastructure | Charter uses these only as internal or target layers and never exposes them to authors. |
| Cedar, Rego | Policy kept separate from code and open to analysis | Charter borrows Cedar's model, where everything is denied unless a rule permits it, and its analyzable permission rules. |

**What is genuinely new.** Charter's semantics are almost entirely reused, and that is on purpose. Three things are new:

1. **Requirement provenance is part of the program.** Requirement records have a status of `confirmed`, `inferred` or `open`. The compiler links them to formal nodes and enforces them. For example, a release build fails if anything inferred is still unapproved.
2. **AI edits are typed operations on the graph.** An edit such as adding a rule or tightening a guard targets a node's identity and comes with an impact report. It is not a free-text rewrite.
3. **Grammar and IR are designed for constrained decoding.** The grammar is small and regular enough that a model's output can be held to it token by token.

**The counter-hypothesis.** LLMs are trained mostly on human-written code, so a novel syntax may hurt generation quality. Section 1.5 explains how the design answers this.

## 1.4 Candidate architectures

Scores run from 1 to 5, where higher is better. For implementation cost, higher means cheaper.

| Architecture | AI generation | Verifiability | Compilability | Edit locality | Explainability | Implementation cost | Total |
|---|---|---|---|---|---|---|---|
| **A.** Typed semantic graph with canonical text | 3 | 3 | 4 | 5 | 4 | 3 | 22 |
| **B.** Declarative rules, constraints and state machines | 4 | 5 | 3 | 4 | 5 | 3 | 24 |
| **C.** Functional core with algebraic effects | 3 | 4 | 5 | 3 | 2 | 3 | 20 |
| **D.** Exposed SSA or dataflow IR | 2 | 3 | 5 | 2 | 1 | 4 | 17 |
| **Chosen: B semantics stored as A, with C's pure expressions** | 4 | 5 | 4 | 5 | 5 | 2 | 25 |

**Why each scored as it did:**
- **A, the graph.** Stable node identities make edits very local. A graph is only a container, though. Its verifiability depends on what semantics sit on top of it. LLMs also emit raw graph IDs badly, so generation needs a text serialization in between.
- **B, rules and constraints.** Rules are short, independent and close to SQL in feel, which suits H1. State plus invariants is the most studied area of verification, as Alloy and Event-B show, which suits H3. The weakness is compiling ordinary computation: loops, string handling and algorithms feel awkward in pure rule form.
- **C, functional with effects.** It compiles cleanly and tracks effects precisely. Effect handlers are rare in training data, however, and invariants over shared state need machinery added on top. Its explainability to non-programmers is poor.
- **D, exposed IR.** It is excellent for compiler writers and poor for everyone else. An IR is the wrong level for capturing intent.

## 1.5 Decision

**Charter has Event-B-style guarded rules over a transactional state store. It is stored as a content-addressed, typed semantic graph. It has a small pure, total expression language for computation inside rules. Effects are declared capabilities that the runtime executes after commit. Architecture D survives only as the compiler's internal IR.**

**Execution model in one paragraph.** A program is a state schema, a set of rules and a set of invariants. Calling a rule is one **step**, and each step is a transaction. First the step checks the rule's permissions and guard against the current state. Then it computes a staged change to state and a staged list of effect requests, using pure expressions only. Next it checks every invariant against the new state. If anything fails, the step aborts with a typed error and nothing changes. Otherwise the state change commits atomically and the effect requests go into a durable outbox. The runtime executes them, and a failed effect triggers the rule's declared compensation. Phase 2 makes this formal.

**How Charter answers the training-data objection:**
- **Familiar surface syntax.** Keywords, operators and literals follow TypeScript and SQL conventions, so models reuse patterns they already know. The novelty is in the semantics, not the spelling.
- **Constrained decoding.** The MVP grammar is meant to stay under about 60 productions, so it can be compiled to a decoding grammar such as GBNF or a JSON schema. That makes syntax errors impossible by construction. H1 is then really about semantic validity.
- **Two equivalent forms.** There is a canonical text form for reading and generation, and a JSON form for structured tool-call edits. Both convert to each other deterministically.
- **A canonical formatter.** Each graph has exactly one text rendering, so diffs show meaning and never formatting noise.

**[ILLUSTRATIVE]**: the first Charter surface syntax, later revised in Phase 2:

```
entity Product { id: Id, stock: Int where >= 0 }

rule PlaceOrder(c: Customer, p: Product, qty: Int where > 0)
  permit c.active
  guard  p.stock >= qty            else reject OutOfStock
  set    p.stock = p.stock - qty
  emit   Payment.charge(c, p.price * qty)
         compensate { p.stock = p.stock + qty }
  req    R-12, R-13

invariant Product.stock >= 0
```

**What Charter gives up:**
- **General-purpose algorithms.** Rules allow only bounded iteration, and recursion is limited to structural recursion in pure functions. Heavy computation goes to foreign functions. Those declare contracts and effects but are not verified.
- **Threads and shared memory.** Concurrency means concurrent transactions plus events, and nothing else. Throughput comes from the store's isolation level and from partitioning.
- **Full effect handlers.** The MVP has a fixed set of effect kinds: database, payment, network, time, randomness and log. User-defined effects come later.
- **Low-level control.** There is no manual memory management and no layout control. Charter is the wrong tool for drivers, engines and kernels.
- **Cheap implementation.** The hybrid is the costliest option to build, at 2 out of 5. It needs a graph store, a text form, a JSON form and an SMT bridge all at once. Phase 8 has to sequence this carefully.

## Checkpoint

**Decisions:**
- The name is Charter.
- Charter uses guarded transactional rules stored as a content-addressed semantic graph.
- Computation inside rules uses pure, total expressions.
- Effects are declared capabilities that run after commit through an outbox, with compensations.
- Permissions deny by default, as in Cedar.
- The surface syntax looks like TypeScript and SQL, with constrained decoding and a JSON form for edits.
- AI-native is defined by the five metrics above, and H1 and H2 are mandatory.

**Open questions:**
- Should invariants be checked on every commit at runtime, only proven statically, or both? The current lean is both, with static proof allowing the runtime check to be skipped.
- What should the default isolation level be? Serializable is simplest to reason about but may cost throughput.
- Which effects can be compensated, and what happens when a compensation itself fails?
- Should node hashes cover requirement links? If they do, re-linking a requirement changes the node's identity.

**Risks:**
- Programs needing real algorithms could spill into foreign functions, which would quietly erode verification. Mitigation: report the share of code in foreign functions as a project health metric.
- H1 could fail because constrained decoding helps TypeScript just as much. That would undercut the language's main justification. Mitigation: run a small H1 pilot before Phase 8 milestone 2.
- SMT proofs of invariants may stop being decidable once arithmetic or collection operations grow too rich. Mitigation: restrict the provable subset, and fall back to runtime checks plus property-based tests.
