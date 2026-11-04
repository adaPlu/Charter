# Phase 3: Intent layer and AI development engine

Nothing in this phase has been run. The JSON, the Charter code and the impact report numbers are all labeled. Report numbers are illustrative unless a block says otherwise.

## 3.0 Amendments to Phase 2

Designing the impact report exposed three gaps in Phase 2. They are fixed here so later phases can build on them.

| ID | Amendment | Why |
|---|---|---|
| A1 | The transitive hash covers **behavioral** dependencies, not just syntactic references. A rule depends on every invariant and assertion over entities it writes, on every rule its raised events trigger, and on the capabilities it uses. | A rule's behavior changes when an invariant checked at its commit changes, even though the rule never names that invariant. Without this edge, the impact report would miss real changes. |
| A2 | New declaration: `assert`. It is a static-only claim about when a rule may run. | Requirements like "only admins can delete projects" constrain permissions rather than state. They need a home that can be proven but never executes. |
| A3 | A compensation inherits the refinements of the parameters it captures. | Captured arguments are immutable values, so their refinements stay true. This closes the Phase 2 open question. `StockNonNegative` is now `Proven` for the compensation as well. If `stock + qty` overflows, the compensation faults and the effect becomes `Stuck`, as Phase 2 specified. |

```ebnf
(* [SPEC] Amendment A2: one production, added to decl *)
assert = "assert" ident ":" ident ( "permitted" | "succeeds" ) "implies" expr [ links ] ;
(* "R permitted implies e": for every state, caller and args, permit(R) ⟹ e
   "R succeeds  implies e": permit(R) ∧ every guard on the path ⟹ e
   e may mention R's parameters and caller. Checked by SMT only; never compiled. *)
```

## 3.1 Pipeline

The core design choice: **the LLM proposes, and deterministic tools decide.** Every LLM output is structured data that a deterministic stage accepts or rejects. No LLM output reaches the graph without passing the checker and a human.

| # | Stage | Input | Output | Done by |
|---|---|---|---|---|
| 1 | Record | Human message | Utterance with id and text, stored in an append-only log | Deterministic |
| 2 | Segment | Utterance | Atomic statements, each with a character span | LLM, with spans validated deterministically |
| 3 | Extract | Statements and the current requirement set | Requirement records and **intent frames** | LLM, constrained to a JSON schema |
| 4 | Classify | Records | `confirmed`, `inferred` or `open` | LLM proposes, deterministic rules enforce (3.2) |
| 5 | Detect linguistic ambiguity | Statements | Ambiguity flags by category | LLM |
| 6 | Lower | Frames | Graph operations, for frames that match a known template | Deterministic |
| 7 | Draft the rest | Frames with no template, plus a dependency slice of the graph | Graph operations | LLM, with constrained decoding |
| 8 | Detect formal contradictions | Draft change set | Unsatisfiable cores mapped back to requirement ids | Deterministic, using SMT |
| 9 | Clarify | Ambiguities, contradictions and open items | At most 5 ranked questions | LLM writes them, deterministic rules filter and rank them |
| 10 | Validate | Change set | Checker, verifier and test results | Deterministic |
| 11 | Repair | Diagnostics | A revised change set, at most 3 attempts | LLM, under the anti-weakening rule (3.10) |
| 12 | Generate tests | Requirements and the draft | Example tests and properties that survive a mutation filter | LLM proposes, deterministic filter |
| 13 | Analyze impact | Graph before and after | Impact report (3.6) | Deterministic |
| 14 | Explain | The graph after the change | Canonical gloss, plus an optional summary | Deterministic gloss, optional LLM summary |
| 15 | Approve | Change set and report | Commit to the graph store, or reject | Human |

**Intent frames** are a small structured layer between language and graph. They exist so that common patterns compile deterministically instead of being written by an LLM every time.

```ts
// [SPEC]
type Frame =
  | { kind: "Action"; actor: string; verb: string; object: string;
      params: Param[]; preconditions: string[]; effects: string[]; onFailure?: string }
  | { kind: "Constraint"; modality: "never" | "always" | "only"; subject: string; predicate: string }
  | { kind: "Permission"; actor: string; action: string; object: string; condition?: string }
  | { kind: "Effect"; trigger: string; capability: string; args: string[] }
  | { kind: "Entity"; name: string; fields: { name: string; type: string; note?: string }[] }
  | { kind: "NonFunctional"; text: string };          // never lowered; always shown to the human
// Every frame carries: reqIds: string[]
```

**Deterministic lowering templates in the MVP:**

| Frame | Lowers to |
|---|---|
| `Entity` | `add_decl` of an entity |
| `Constraint` with `never` or `always`, over state | `add_decl` of an **invariant**, never just a guard |
| `Constraint` with `only`, over who can act | `add_decl` of an **assert** |
| `Permission` | `add_decl` of a permission, or a change to a rule's permit |
| CRUD-shaped `Action` | A rule skeleton: permit, guards, then create, set or delete |

The second row prevents a common error. "Never let inventory go negative" must hold for every rule that touches stock, including ones written later. Only an invariant guarantees that.

## 3.2 Requirement records and provenance

```ts
// [SPEC]
type Requirement = {
  id: string;                         // "R-7", never reused
  text: string;                       // normalized single statement
  status: "confirmed" | "inferred" | "open";
  kind: "behavior" | "constraint" | "permission" | "effect" | "data" | "nonfunctional";
  source?: { utterance: string; start: number; end: number };   // required for confirmed
  rationale?: string;                 // required for inferred: why the AI assumed it
  question?: string;                  // required for open
  risk: "low" | "medium" | "high";    // assigned deterministically, see 3.4
  links: string[];                    // anchors that implement it (derived from the link table)
  supersedes?: string;                // the requirement this one replaces
  history: { at: string; by: "human" | "ai"; change: string }[];
};
```

**Status rules, enforced by the op applier rather than by the model:**
- **Confirmed needs a source.** A requirement can be `confirmed` only if `source` points to a real span in the utterance log, and the human approved the change set that added it.
- **The AI cannot confirm.** `set_status` to `confirmed` with `origin: "ai"` is rejected. Only a human can promote `inferred` or `open` to `confirmed`.
- **Inferred needs a reason.** An `inferred` requirement must carry a rationale. An `open` one must carry a question.
- **Nothing is orphaned.** Every AI operation that changes meaning must cite at least one requirement. If none fits, the operation must create an `inferred` one. An edit with no requirement behind it cannot exist, which is how principle 3, "no silent requirements", is enforced. (Phase 6 found that citing a requirement is not the same as being justified by it, and adds an entailment check.)
- **Chat is provenance, not truth.** The utterance log explains *why* a requirement exists. The graph alone defines *what* the program does.

## 3.3 Ambiguity and contradiction detection

**Linguistic ambiguity** is flagged by the LLM in stage 5. It is advisory. Taking the original prompt's web app request as input:

| Category | Example from the request | Flag |
|---|---|---|
| Unclear scope | "Administrators can access everything" | Read-only, or also edit and delete? Does "everything" include other users' accounts? |
| Vague verb | "manage their projects" | Create, rename, delete, archive? |
| Missing actor | Admins exist | Who makes someone an admin? |
| Missing failure behavior | "register" | What happens with a duplicate email? |
| Satisfied by construction | "Save all changes automatically" | Every committed Charter step is durable already. The engine records this as `confirmed`, links it to the runtime, and asks nothing. |

**Formal contradictions** are found deterministically in stage 8. This is the more valuable layer, because it catches conflicts no one noticed while reading.

| Check | SMT question | Finding |
|---|---|---|
| Dead rule | Can permit, the guards and all invariants be true together for some state and some arguments? | If not, the rule can never succeed. The unsatisfiable core names the requirements that conflict. |
| Assert violated | Is `permit(R) ∧ ¬e` satisfiable? | If so, the solver returns a concrete witness: a caller, arguments and a state. |
| Invariant conflict | Can all invariants hold together on a non-empty store? | If not, the conflicting invariants are reported. |
| Effect without capability | Does a frame need a capability that the module's `uses` list lacks? | Reported as an `open` item rather than added silently. |

**Example `[ILLUSTRATIVE]`.** Suppose a user says "Owners can delete their projects" and later says "Only admins can delete projects."

```
// [ILLUSTRATIVE]
permission CanDelete(u: User, p: Project) = p.owner == u.id or u.role == Admin   req R-4
assert OnlyAdminsDelete: DeleteProject permitted implies caller.role == Admin    req R-11

// Stage 8 result (hand-derived):
//   Refuted: OnlyAdminsDelete
//   Witness: caller = User{role: Member}, p = Project{owner: caller.id}
//   Conflicting requirements: R-4 "Owners can delete their projects" (confirmed)
//                             R-11 "Only admins can delete projects" (confirmed)
```

The engine does not pick a winner. Two confirmed requirements conflict, so the human must choose. The resulting question appears in 3.4.

## 3.4 Clarification policy

**Whether to ask** is decided by deterministic rules, not by the model's judgment:

1. **Skip questions that make no difference.** If two possible answers yield change sets with identical transitive hashes, the answer does not affect the program, and the question is dropped. This is checked by drafting both alternatives.
2. **Always ask about high-risk areas.** High risk covers permissions, money, deletion, new capabilities, removing schema fields, and anything touching personal data. The engine never picks a default silently in these areas. It asks, or it marks the item `open` and the release gate blocks shipping.
3. **Defaults are allowed for low-risk details.** Examples are text length limits and sort order. The engine picks a default, records it as `inferred` with a rationale, and lists it in the report.
4. **Contradictions between confirmed requirements always become questions.**
5. **At most 5 questions per round.** They are ranked by risk first, then by how many graph nodes the answer would change.

```ts
// [SPEC]
type Question = {
  id: string; about: string[];        // requirement ids
  text: string;
  options: { label: string; consequence: string; reqText: string }[];
  default?: number;                   // only allowed when risk is "low"
  risk: "low" | "medium" | "high";
};
```

```json
// [ILLUSTRATIVE] question generated from the 3.3 contradiction
{
  "id": "Q-3", "about": ["R-4", "R-11"], "risk": "high",
  "text": "You said owners can delete their projects, and also that only admins can delete projects. Which should apply?",
  "options": [
    { "label": "Only admins", "consequence": "Owners lose the ability to delete. 2 tests change.", "reqText": "Only admins can delete projects." },
    { "label": "Owners and admins", "consequence": "The 'only admins' rule is dropped.", "reqText": "Owners and admins can delete projects." },
    { "label": "Owners request, admins approve", "consequence": "Adds a deletion request and an approval rule.", "reqText": "Owners can request deletion; an admin must approve it." }
  ]
}
```

## 3.5 Graph edit operations `[SPEC]`

Every edit is an operation inside a change set. A change set is applied atomically, then the full checker runs. If any check fails, the whole change set is rejected.

```ts
// [SPEC] operation envelope
type Op = {
  op: OpName; args: object;
  origin: "human" | "ai";
  reqs: string[];                     // at least one for any meaning-changing op from the AI
  base?: string;                      // expected transitive hash of the target; mismatch rejects the op
  reason: string;                     // one sentence, shown in the review
};
type ChangeSet = { id: string; ops: Op[]; utterance?: string };
```

The `base` field is optimistic concurrency. If the target changed since the AI read it, the operation fails instead of silently overwriting someone else's edit. It also prepares the ground for multiple agents editing at once.

| Group | Operation | Meaning | Classed as |
|---|---|---|---|
| Declarations | `add_decl(kind, payload, after?)` | Adds any top-level declaration | Additive |
| | `remove_decl(anchor)` | Removes a declaration. Fails if anything still references it. | Removal |
| | `rename(anchor, name)` | References use anchors, so nothing breaks | Neutral |
| Schema | `add_field(entity, field)` | Requires a default or a paired migration | Schema |
| | `remove_field(anchor)` | Requires a migration and a major version bump | Schema, high risk |
| | `retype_field(anchor, type)` | Requires a migration | Schema |
| | `add_migration(from, to, ops)` | Adds a migration block | Schema |
| Rules | `insert_clause(rule, index, clause)` | Adds a clause | Depends on clause |
| | `remove_clause(anchor)` | Removes a clause | Removal |
| | `replace_clause(anchor, clause)` | Swaps one clause for another | Depends on clause |
| | `move_clause(anchor, index)` | Reorders clauses | Reorder |
| | `add_param(rule, param, index)` and `remove_param(anchor)` | Changes a rule's signature | Signature |
| Expressions | `replace_expr(anchor, expr)` | General replacement | Unclassified |
| | `tighten(anchor, expr)` | Replaces `e` with `e and expr` | Tightening |
| | `loosen(anchor, expr)` | Replaces `e` with `e or expr` | Loosening |
| | `set_refinement(anchor, pred)` and `clear_refinement(anchor)` | Adds or removes a refinement | Tightening or loosening |
| Effects | `add_uses(cap)` and `remove_uses(cap)` | Changes the module's capabilities | High risk when adding |
| | `set_compensation(emit, clauses)` | Sets what runs if an effect fails | Effect |
| Requirements | `add_requirement(record)` | Status rules from 3.2 apply | n/a |
| | `set_status(req, status)` | `confirmed` only with human origin | n/a |
| | `edit_requirement_text(req, text)` | Human origin only | n/a |
| | `link(anchor, req)` and `unlink(anchor, req)` | Edits the link table, which is excluded from hashes | Neutral |
| Tests | `add_test(payload)` | Adds a test or property | Additive |
| | `remove_test(anchor)` | Needs human approval if linked to a confirmed requirement | Weakening |
| Notes | `annotate(anchor, text)` | Non-semantic note | Neutral |

`tighten` and `loosen` exist even though `replace_expr` can do the same thing. Their purpose is to state intent. When the AI calls `tighten`, the impact analyzer *proves* the new predicate implies the old one, which is strictly fewer permissions. A `tighten` that is really a loosening is rejected.

## 3.6 Impact report and the definition of "unrelated"

**Inputs.** The analyzer takes the graph before and after a change. Using the behavioral dependency graph from A1, it computes a transitive hash for every declaration.

**Definitions `[SPEC]`:**
- **Changed set** `D`: declarations whose own content changed.
- **Affected set** `A`: declarations whose transitive hash changed. `A` always contains `D`.
- **Unaffected set** `U`: every other declaration.
- **Expected set** `X`: declarations linked to the requirements the change set cites, plus everything that depends on them.

**A change leaves unrelated behavior unchanged when all four conditions hold:**
1. **Hashes.** Every declaration in `U` has the same transitive hash as before. By construction its meaning is then identical.
2. **Tests.** Every test whose subjects all lie in `U` passes with the same outcome and the same final state hash. These tests are rerun anyway, since that is cheap and guards against a bug in the hash computation.
3. **Proofs.** Every proof obligation for rule and invariant pairs in `U` keeps its status.
4. **Scope.** `A` is contained in `X`. Anything in `A` but outside `X` is scope creep. It is listed by name, and approval requires an explicit human decision.

**What the report contains:**

| Section | Content | Determined by |
|---|---|---|
| Semantic diff | Changed declarations shown as canonical text diffs | Graph diff |
| Affected declarations | `A`, with the dependency path explaining why each one is in it | Transitive hashes |
| Requirements touched | Every requirement linked to a node in `A`, and whether it is confirmed | Link table |
| Permission diff | For each changed permit: is there a caller, arguments and state allowed **after** but not **before**? And the reverse? Each answer comes with a witness. | SMT |
| Guard diff | The same before-and-after analysis for guards | SMT |
| Effect diff | Capabilities added to or removed from each rule | Effect inference |
| Schema diff | Fields added, removed or retyped, and the migration required | Graph diff |
| Proof diff | Status changes for each rule and invariant pair. A drop from Proven to Unproven is a regression shown in red. | Verifier |
| Test diff | New, changed, removed, passing and failing tests | Test runner |
| Risk | The highest risk level across all of the above | Risk table in 3.4 |

**Refactors** such as "make this faster without changing behavior" add one more check. For each changed rule, the verifier asks whether the old and new versions produce the same state change, effects and outcome for every input. If the question is within the decidable fragment, the result is labeled `equivalent (proven)`. Otherwise the engine falls back to differential property testing on 10,000 generated inputs. The result is then labeled `equivalent (tested)`, never "proven".

## 3.7 A worked change request `[ILLUSTRATIVE]`

**Starting program.** A slice of the project app, taken ahead of its full treatment in Phase 5:

```
// [ILLUSTRATIVE]
principal User
enum Role { Member, Admin }
entity User    { email: Text, role: Role = Member }
entity Project { owner: Id<User>, name: Text }

requirement R-2 confirmed "Users can only modify projects they own."
requirement R-3 confirmed "Administrators can access everything."
requirement R-5 confirmed "Users can view their own projects."

permission CanEdit(u: User, p: Project) = p.owner == u.id or u.role == Admin   req R-2, R-3

query GetProject(p: Project): Project permit CanEdit(caller, p) = p             req R-5
rule  RenameProject(p: Project, name: Text) permit CanEdit(caller, p)
  set p.name = name                                                             req R-2
```

**The human says:** "Change the system so project owners can invite collaborators with read-only access."

**Extracted requirements:**

| ID | Status | Text | Basis |
|---|---|---|---|
| R-7 | confirmed | Project owners can invite collaborators with read-only access. | A span of the utterance |
| R-8 | inferred | Only existing users can be invited. Email invitations to new people are out of scope. | Rationale: no invitation flow was mentioned. Low risk, because this is the smaller feature. |
| R-9 | open | Can collaborators be removed, and by whom? | Question: removal is not mentioned, and it involves permissions, so the risk is high. |
| R-10 | open | Can admins invite collaborators to projects they don't own? | Question: R-3 says admins can access everything, but inviting is a new kind of action. |

**Questions sent to the human:** Q-1 asks about R-9 and Q-2 about R-10. No question is asked about the meaning of "read-only". The drafts for "can view the project" and "can view the project and its collaborator list" produce the same hashes, because collaborator lists can't be queried yet. Under rule 1 of 3.4, the question is dropped.

**The engine compares two designs:**

| Design | Schema change | Size of the affected set | Proof cost |
|---|---|---|---|
| Add a `collaborators: Set<Id<User>>` field to Project | Yes, with a migration | Every declaration that references Project: 4 here, and more in a real app | Needs set theory in the solver, the slow path flagged in Phase 2 |
| **New entity `Collaborator { project, user }`** | No. The change only adds. | GetProject, plus the new declarations | Equality and a quantifier over a table, which stays in the fast fragment |

The engine recommends the new entity. It leaves Project's hash untouched, so RenameProject and everything else built on CanEdit is provably unaffected. That is H2 in miniature.

**The change set:**

```json
// [ILLUSTRATIVE] change set CS-12 (abridged)
{ "id": "CS-12", "utterance": "U-31", "ops": [
  { "op": "add_requirement", "origin": "ai", "reqs": ["R-7"], "args": { "id": "R-7", "status": "confirmed",
    "source": { "utterance": "U-31", "start": 30, "end": 92 }, "kind": "permission",
    "text": "Project owners can invite collaborators with read-only access." },
    "reason": "Direct statement in the request." },
  { "op": "add_decl", "origin": "ai", "reqs": ["R-7"], "args": { "kind": "Entity",
    "src": "entity Collaborator { project: Id<Project>, user: Id<User> }" },
    "reason": "Stores collaborator links without changing Project." },
  { "op": "add_decl", "origin": "ai", "reqs": ["R-7"], "args": { "kind": "Permission",
    "src": "permission CanView(u: User, p: Project) = CanEdit(u, p) or exists c in Collaborator: c.project == p.id and c.user == u.id" },
    "reason": "Read access is edit access, plus collaborators." },
  { "op": "replace_expr", "origin": "ai", "reqs": ["R-7"], "base": "h:9f1c…", "args": {
    "anchor": "n_GetProject_permit", "expr": "CanView(caller, p)" },
    "reason": "Lets collaborators read. Edit rules still use CanEdit." },
  { "op": "add_decl", "origin": "ai", "reqs": ["R-7", "R-8"], "args": { "kind": "Rule",
    "src": "rule InviteCollaborator(p: Project, u: User) rejects InviteError\n  permit p.owner == caller.id\n  guard u.id != p.owner else reject IsOwner\n  guard not exists c in Collaborator: c.project == p.id and c.user == u.id else reject AlreadyInvited\n  create Collaborator { project = p.id, user = u.id }" },
    "reason": "Owners invite existing users. Duplicates and self-invites are rejected." },
  { "op": "add_test", "origin": "ai", "reqs": ["R-7"], "args": { "src": "test \"collaborator cannot rename\" { … when RenameProject(p, \"x\") as bob expect reject Denied }" },
    "reason": "Checks that read-only access really is read-only." }
]}
```

The `InviteError` enum declaration and three more tests are omitted here.

**Impact report:**

```
// [ILLUSTRATIVE] hand-derived, not computed
CHANGE SET CS-12                                   Risk: MEDIUM (access loosened)
Changed:     GetProject (permit)  + new: Collaborator, CanView, InviteCollaborator, InviteError
Affected:    GetProject           (its permit now calls CanView)
Unaffected:  CanEdit, RenameProject, User, Project, Role       transitive hashes identical
Requirements touched:
  R-5 "Users can view their own projects" (confirmed), via GetProject
      Preserved: CanEdit ⟹ CanView is valid (SMT, proven). No one who could view loses access.
Permission diff, GetProject:
  Loosened. Witness: caller = User{role: Member}, p = Project{owner ≠ caller},
                     Collaborator{project: p, user: caller} exists
  Tightened: none (proven)
Permission diff, RenameProject: unchanged (hash identical)
Effects: no change          Schema: additive only, no migration needed
Proofs: no status changes   Tests: 14 unaffected pass unchanged; 4 new pass
Scope:  A ⊆ X. GetProject was linked to R-7 by this change set, and it also implements R-5,
        so it is shown under "Requirements touched".
Open before release: R-9 (removing collaborators), R-10 (admin invites)
```

The scope check alone would pass trivially, since the change set links GetProject to R-7 itself. That is why touching any node linked to *another* confirmed requirement is always reported separately. R-5 is shown and proven preserved, not hidden.

## 3.8 Explaining programs back

**The canonical gloss** is produced deterministically. There is a template for each node kind, and every sentence cites the anchors and requirements it comes from. The gloss is stilted but faithful. It is the text shown in the Human view, and it is what H4 measures.

```
// [ILLUSTRATIVE] deterministic gloss of PlaceOrder (Phase 2 example)
PlaceOrder(p, qty)
• Who: an active customer [R-3, inferred].
• Input: a product and a quantity greater than zero.
• If the product's stock is less than qty: reject with OutOfStock. Nothing changes and nothing is charged [R-2].
• Otherwise: stock decreases by qty, then the change is saved.
• After saving: charge the customer price × qty [R-2].
  If the charge fails for good: stock increases by qty again [R-1].
• Always true afterwards: no product has negative stock (proven) [R-1].
```

**An optional LLM summary** may rephrase the gloss in friendlier language. It is labeled "summary, not verified" and is always shown next to the gloss, never instead of it.

**Round-trip check.** This is an advisory, automated check for H4. A separate LLM call extracts requirements from the gloss alone, without seeing the original chat. The engine compares them with the stored requirement records. Any requirement that is missing, extra, or different gets flagged as a possible misinterpretation for the human to look at.

## 3.9 Making the LLM stages auditable

LLM output cannot be made reproducible bit for bit. Pinned models at temperature 0 still vary across hardware and serving stacks. The design does not depend on reproducibility, because **the approved change set is the artifact, not the generation.** Regenerating can give a different draft, and that is fine. Only approved operations ever reach the graph.

**What the engine does instead:**
- **Intent ledger.** An append-only, hash-chained log records each LLM call. It stores the model id and version, the decoding settings, the exact context sent, the raw output, and the operations that resulted. An auditor can always answer "why does this node exist?"
- **Constrained decoding.** Operations are decoded against the operation JSON schema. Expressions inside them are decoded against the Charter expression grammar. Output therefore always parses, and failures are always about meaning.
- **Deterministic context slicing.** The model receives the canonical text of the declarations relevant to the change, found through the dependency graph, plus the requirement list. It never receives the whole chat history. Two runs on the same graph and the same request see identical context.
- **Model portability.** The operation schema does not depend on any particular model. Swapping models changes draft quality, never the semantics of what was approved.

## 3.10 Failure modes and mitigations

| Failure | Example | Mitigation |
|---|---|---|
| Invented requirement | The AI adds "orders over $500 need approval" | `confirmed` requires a real source span. Anything else is `inferred` and blocked by the release gate. |
| Over-literal translation | "Never negative" written as a single guard in PlaceOrder | Never and always statements lower to invariants (3.1). Properties are generated against them. |
| Wrong default | Money rounding, or a missing failure behavior | Defaults are allowed only for low-risk items. Every default is listed as `inferred` with its rationale. |
| Weakening while repairing | The repair loop "fixes" a refuted invariant by deleting it | **Anti-weakening rule.** During automatic repair, the AI may not remove, loosen or clear anything linked to a confirmed requirement. That covers invariants, asserts, guards, permits, refinements and tests. Such a fix goes to the human with the diagnostic. |
| Scope creep | A change request quietly retouches unrelated rules | The scope condition, plus the "requirements touched" section of the report |
| Stale edit | The AI edits a node someone else changed in the meantime | The `base` hash precondition rejects the operation |
| Vacuous tests | A test that passes whatever the code does | **Mutation filter.** A generated test is kept only if it fails against at least one mutant of the nodes it is linked to. Mutants include flipped comparisons, dropped guards and off-by-one constants. |
| Misleading explanation | A friendly summary hides an edge case | The deterministic gloss is the primary explanation, and the round-trip check runs on it |
| Endless clarification | Asking 20 questions | At most 5 per round, ranked, with irrelevant questions dropped by the hash test |
| Contradiction resolved silently | The model picks one of two conflicting requirements | Contradictions between confirmed requirements always become questions (3.4) |

## Checkpoint

**Decisions:**
- The LLM proposes structured data, and deterministic stages decide. The LLM appears in segmenting, extracting, drafting, repairing, writing questions, proposing tests and the optional summary. Everything else is deterministic.
- Intent frames, with deterministic lowering for common patterns. Never and always become invariants, and only becomes an assert.
- Requirement status is enforced by the op applier. Confirmed needs a source span and human approval. Every AI edit cites a requirement.
- About 30 typed graph operations, with `tighten` and `loosen` checked against their declared intent, and `base` hashes for concurrency.
- "Unrelated behavior is unchanged" is defined by four conditions: hashes, tests, proofs and scope. It uses transitive hashes over behavioral dependencies.
- The human view is a deterministic, cited gloss. LLM prose is always secondary.
- Amendments A1, A2 and A3 to Phase 2.

**Open questions:**
- **Which change can a human approve in bulk?** For example, could a 40-operation change set with only additive, low-risk operations be approved in one click? Phase 6 decides this.
- **Clarification fatigue against safety.** Is "always ask about high-risk items" too noisy in practice? Pilot users may need a per-project risk policy.
- **The size of the dependency slice.** For large programs the slice may exceed a model's useful context. A summarized slice is possible, but then the model edits against a summary.
- **Mutation operators.** Which mutants count is still a choice, and it controls how strict the vacuous-test filter is.

**Risks:**
- **The SMT checks carry most of the safety argument.** The permission diff, the contradiction check and equivalence for refactors all depend on staying inside the decidable fragment. Permissions with deep joins may time out, and an "unknown" result must never be presented as "safe".
- **Template coverage.** If few frames match a lowering template, most drafting falls back to the LLM, and the determinism advantage shrinks. Track the share of operations produced by lowering as a metric.
- **A hash bug would undermine H2.** If the behavioral dependency graph misses an edge, a real change would be reported as "unaffected". Mitigation: rerun unaffected tests anyway (condition 2), and fuzz the hash computation itself.
- **Approval fatigue.** Detailed reports protect only if humans read them. Phase 6 must make the risky parts impossible to miss.
