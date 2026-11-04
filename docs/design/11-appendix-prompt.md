# Appendix: the master prompt

This is the refined master prompt that produced the design, phase by phase. It is reproduced as it was used, including its own reference sketch.

## Master Prompt: Design and Prototype an AI-Native Programming Language

### 0. Non-negotiable principles (read first)

1. **Natural language is the input interface. The formal core language is the single source of truth.** Every behavior of the running program must be traceable to the formal source, never to a prompt or chat history.
2. **No LLM at runtime.** Parsing, checking, compiling, and executing the core language must be fully deterministic and work with no AI model installed.
3. **No silent requirements.** Every element of a formal program is tagged as `confirmed` (stated by the human), `inferred` (assumed by the AI, awaiting approval), or `open` (unresolved question). Inferred items never ship without approval.
4. **Claims need evidence.** "Better for AI" is a hypothesis, not a premise. Shorter or less human-readable is not automatically better. Every advantage you claim must name the experiment that would confirm or refute it.
5. **Honesty about status.** Label every code block as one of: `[SPEC]` normative definition, `[ILLUSTRATIVE]` sketch, `[GENERATED-UNTESTED]` plausible output never run, or `[EXECUTED]` actually run, with the output shown. If you cannot execute code in this conversation, most output will be `[GENERATED-UNTESTED]`. Say so.
6. **Smallest useful thing first.** Prefer a small, complete, precisely specified core over a broad, vague one. Defer anything speculative to the roadmap.

### 1. Mission

Design a new programming language and paradigm in which:

- humans state intent, rules, constraints, and desired outcomes in natural language;
- an AI translates that intent into a formal, typed, machine-oriented program;
- deterministic tools verify, compile, execute, and explain that program.

This is not an English-to-Python translator, an AI coding assistant, or a simplified syntax for an existing language. It may reuse established ideas, but you must say which ones and identify what is genuinely new.

### 2. Key hypotheses to test

State and refine these. Each later design decision should cite which hypothesis it serves.

- **H1 (Generation reliability).** LLMs produce syntactically and semantically valid programs more often in a small, regular, strongly typed, declarative core than in Python or TypeScript.
- **H2 (Edit locality).** Structured edits to a semantic graph cause fewer unintended behavior changes than text edits to conventional source.
- **H3 (Verifiability).** Expressing invariants, permissions, and effects as first-class constructs catches more requirement violations before runtime.
- **H4 (Fidelity).** Round-tripping NL to formal and back to NL lets humans detect misinterpretation faster than reading generated conventional code.

Address the obvious counter-hypothesis directly: **LLMs are trained mostly on human-written code, so a novel syntax may hurt generation quality.** Explain how the design mitigates this. Options include a familiar surface syntax over a novel semantic core, constrained decoding against the grammar, or a structured JSON or S-expression interchange form.

### 3. Prior art you must engage with

Compare against, and borrow from or reject explicitly: Python, TypeScript, Rust, SQL, Datalog, Prolog, Elm and The Elm Architecture, Dafny, TLA+, Alloy, Event-B, Lean, the P language, Unison (content-addressed code), Dark, Ballerina, MLIR and LLVM IR, WebAssembly, and policy languages such as Cedar or Rego. For each, give one or two sentences on what it gets right and where this design differs.

### 4. Work in phases

Deliver the work in the phases below. **End each phase with a short checkpoint**: decisions made, open questions, and risks. If the full output would be too long for one response, stop at a phase boundary and say which phase comes next. Do not compress later phases into summaries to fit everything in.

#### Phase 1: Foundations and architecture choice

1. Name and one-paragraph philosophy. No superlatives or marketing language.
2. Define "AI-native" in measurable terms, tied to H1 through H4.
3. Compare at least four candidate core architectures, for example:
   - typed semantic graph with a canonical text serialization;
   - declarative rules plus constraints plus state machines (relational, Datalog-style);
   - functional core with an algebraic effect system;
   - structured IR (SSA or dataflow) exposed directly.

   Score each on AI generation reliability, verifiability, compilability, edit locality, human explainability, and implementation cost. Use a table.
4. Choose one and justify it. Name what you give up.

#### Phase 2: Core language specification (MVP subset only)

Specify precisely enough that an independent engineer could build a parser and checker:

- Execution model: what a program *is*, how it runs, and what a "step" is.
- Program structure: `entity` and state, `rule` and action, `invariant`, `permission`, `effect`, `event`, `query`, `test`.
- Type system: primitives, records, enums and sum types, collections, refinement types for constraints (for example `Int where >= 0`), identity and references.
- Effect and capability system: which effects exist (database write, payment, network, time, randomness), how they are declared, and how unauthorized effects are rejected at compile time.
- Conditionals, iteration (bounded by default? say why), recursion policy, error handling, and transactions and atomicity.
- Scoping, modules, versioning, and dependencies.
- **Formal EBNF grammar** for the MVP subset.
- **Semantics**: typing rules and an operational semantics for rules, transactions, and invariant checking. Semi-formal notation is acceptable if precise.
- **Canonical AST or semantic-graph schema**, plus a deterministic text serialization and a JSON interchange form. Explain how node identity stays stable across edits.
- A list of what is explicitly **out of the MVP** and left to libraries or later versions.

#### Phase 3: Intent layer and AI development engine

- Pipeline: NL, then requirement extraction, then ambiguity and contradiction detection, then clarification questions, then formal draft, then validation, then NL explanation back to the human.
- Requirement records: each has an ID, source text, status (`confirmed`, `inferred`, or `open`), and links to the formal nodes that implement it.
- Change requests such as "let owners invite read-only collaborators" produce a **semantic diff** plus an **impact report** listing affected requirements, invariants, tests, and permissions. Define "unrelated behavior" operationally: for example, all tests and proofs not linked to the change must still pass unchanged.
- Mark which stages use an LLM and which are deterministic. Describe how to make the LLM stages reproducible enough to audit, for example with a pinned model, logged prompts, and constrained decoding to the grammar.
- Failure modes: hallucinated requirements, over-literal translation, and wrong defaults. Give a mitigation for each.

#### Phase 4: Compiler, runtime, verification, and safety

- Architecture: parser, checker, verifier, optimizer, IR, codegen, runtime.
- **Pick one MVP target** and justify it. TypeScript on Node or WebAssembly are likely candidates. Explain the trade-off against LLVM, native code, Python, the JVM, and Android.
- Runtime services: persistence, transactions, event dispatch, concurrency control, and effect handlers.
- Verification stack: static types, constraint checks, permission and effect checks, invariant preservation proofs for a decidable subset (for example via an SMT solver such as Z3), property-based tests, and reproducible builds.
- Safeguards for database mutations, money movement, access control, and external APIs. Include dry-run modes and human approval gates for high-risk changes.
- **Limits of verification**: what cannot be proven (external systems, timing, liveness in general, errors in the specification itself) and how the design surfaces those gaps rather than hiding them.

#### Phase 5: Worked examples

Build five examples of rising difficulty. **Do examples 1 through 4 in full. Example 4 is the core proof of the paradigm. Do example 5 at design depth** unless space allows more.

1. Calculator with input validation.
2. Task manager with persistence.
3. REST API with authentication and authorization. Owners modify their own projects and admins access everything. Then add read-only collaborators as a change request.
4. Inventory and ordering: "Whenever a customer orders an item, reduce inventory. Never allow inventory to become negative. If there isn't enough stock, reject the order without charging the customer." Show atomicity, payment effect ordering (reserve, charge, commit, or a saga with compensation), failure recovery, two concurrent orders for the last unit, and a proof or proof sketch that inventory cannot go negative.
5. Real-time multiplayer game with server-authoritative state, where players earn XP, level up, and unlock abilities. Show network events, the tick model, and conflict resolution.

For each example show:

- the original human request;
- extracted requirements tagged `confirmed`, `inferred`, or `open`, and the clarification questions the AI would ask;
- formal source in the new language;
- an IR excerpt;
- generated target code, or its key parts for large examples;
- tests generated from requirements, including at least one property-based test;
- verification results, labeled honestly by status;
- the NL explanation generated back from the formal source.

Do not skip the hard parts: concurrency, partial failure, permission edge cases, and schema migration on change.

#### Phase 6: IDE and human-AI collaboration

- Three synchronized views: **Human** (requirements), **Formal** (source and graph), and **Execution** (generated code, tests, state traces, logs).
- Say which views are editable and how edits propagate. Since the formal view is the source of truth, explain how a human edit in the Human view becomes a proposed formal diff for approval.
- Show the interaction for these requests: "Explain why this condition exists." "Make this faster without changing behavior." "Add authentication without changing the database schema." "Show which requirements are not yet implemented."

#### Phase 7: Evaluation

- Benchmarks: tokens per task, syntactic validity rate, semantic correctness against a hidden test suite, compile success, runtime performance, requirement fidelity rated by humans, reliability of AI-made modifications, defects caught before runtime, portability across models, and maintainability.
- A controlled experiment: the same task set implemented by the same models in Python or TypeScript versus the new language. Specify the task count, models, runs per task, metrics, statistical test, and what result would **falsify** each of H1 through H4.
- Threats to validity, such as training-data familiarity and benchmark leakage.

#### Phase 8: MVP implementation plan

- Implementation technology for the compiler, with justification (for example TypeScript or Rust).
- Directory structure and core modules: grammar and parser, AST and graph, checker, verifier, IR, codegen, runtime, test runner, NL bridge, explainer.
- The MVP must be usable **with no AI model** by developers who write the core language directly.
- Milestones with rough scope, each with a concrete demo and exit criteria. The first milestone should parse, check, and run the calculator.

#### Phase 9: Roadmap and open problems

Sort into three groups: **near-term engineering**, **plausible research**, and **speculative**. Cover multi-agent programming, agent-to-agent exchange of executable specifications, self-optimization under explicit constraints, AI-generated libraries, and whole-application specification. List the hardest unresolved research problems honestly.

### 5. Output format

- Use headings that match the phase numbers above.
- Use tables for comparisons and scoring.
- Put all code in fenced blocks, each carrying its status label from principle 5.
- After each phase, include the checkpoint: **Decisions / Open questions / Risks**.
- When choosing between approaches, give a recommendation and a one- or two-sentence reason. Do not list options without choosing.

### 6. Reference sketch (illustrative only, not binding)

```
entity Player {
    level: Int where >= 1 = 1
    xp:    Int where >= 0 = 0
}

rule GainXP(player: Player, amount: Int where > 0) {
    effect player.xp += amount
}

invariant Player.level >= 1
invariant Player.xp >= 0
```

You may change this syntax completely. Justify the final surface form against H1 and the training-data counter-hypothesis.

**Begin with Phase 1.**
