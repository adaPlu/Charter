# Phase 6: IDE and human-AI collaboration

Nothing here is built. The screen mockups and dialogues are `[ILLUSTRATIVE]`. Latency figures are design targets, not measurements.

## 6.0 Earlier questions settled here

| Question | Raised in | Decision |
|---|---|---|
| Can a large change set be approved in one click? | Phase 3 | Only if every operation is additive or neutral, and nothing loosens permissions, adds capabilities, touches money or regresses a proof. Otherwise each risky item must be acknowledged on its own (6.4). |
| Is "always ask about high-risk items" too noisy? | Phase 3 | Projects get a risk policy file. It can lower risk for named items, but floors apply: loosened permissions and money can never drop below medium (6.4). |
| Who resolves `Unknown` payments, and how? | Phase 4 | An operator console with three logged actions. Large amounts need two people (6.7). |
| A new gap, found while designing 6.6 | This phase | An AI operation can cite a confirmed requirement for behavior the requirement doesn't actually state. That passes the Phase 3 citation rule. The fix is an advisory entailment check, shown on the review card (6.6, first interaction). |

## 6.1 Design principles

1. **Every view is a projection of one graph.** No view holds state of its own. Each view shows the graph hash it is rendering, and a stale view says so.
2. **Every edit becomes a change set.** That applies whether it starts as a sentence, a text edit or a click. Nothing changes the graph without passing the checker and the review card.
3. **Risk is shown by layout, not by prose.** Risky items are expanded, colored and need acknowledging. Safe items are collapsed and counted.
4. **Concrete beats abstract.** A loosened permission is shown as a sentence about a specific person, taken from the solver's witness, not as a formula.
5. **Deterministic text first, AI text second.** The gloss, provenance and impact data come from tools. AI prose is labeled as a summary.

## 6.2 Layout

```
// [ILLUSTRATIVE]
┌─ projects@1.0.0 ─ graph h:4be2… ─ Release gate: BLOCKED (2 inferred, 1 open) ───────────────┐
│ HUMAN                       │ FORMAL                          │ EXECUTION                    │
│ ▸ Requirements (14)         │ rule DeleteProject(p: Project)  │ Tests 31 ✓  1 ✗              │
│   R-5 ● confirmed           │   permit CanEdit(caller, p)     │ Proofs 18 proven · 2 runtime │
│   "Only the owner or an     │   for k in (select c for c in   │ ─────────────────────────────│
│    admin may modify…"       │     Collaborator where …) {     │ Trace  step #8812            │
│   R-13 ◐ inferred  [Approve]│     delete k }                  │  DeleteProject(P1) by U7     │
│   R-15 ○ open      [Answer] │   delete p                      │  permit ✓ (owner)            │
│ ▸ Gloss: DeleteProject      │   req R-3, R-5                  │  bulk_delete 3 rows          │
│   "The project's owner or   │                                 │  commit 4.1 ms               │
│    any admin may delete…"   │ [Text] [Graph] [Ops]            │ ▸ Generated TS (read-only)   │
├─────────────────────────────┴─────────────────────────────────┴──────────────────────────────┤
│ ✎ Ask or instruct…                                    Pending change sets: CS-14 (medium) ▸   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Linked selection.** Selecting anything highlights everything connected to it:
- **A requirement** highlights its linked nodes in the Formal view, plus their tests, proofs and recent traces in the Execution view.
- **A node** highlights the requirement it implements and the gloss sentence that describes it.
- **A trace step** highlights the rule and clauses that ran.

Links use anchors, so they survive edits.

**Pending change sets appear in all three views at once.** The Human view shows a redline of requirements and a gloss diff. The Formal view shows a text diff. The Execution view shows the test diff and proof diff, from running the change set in a sandbox.

## 6.3 The three views

| View | Shows | Editable? | How an edit propagates |
|---|---|---|---|
| **Human** | Requirements with status chips, the gloss of each declaration, open questions, and the coverage panel (6.5) | Yes: requirement text, status promotion, answers to questions, free-text instructions | Every edit becomes an utterance that goes through the Phase 3 pipeline and comes back as a proposed change set |
| **Formal** | Canonical text, a graph view, and an operations log | Yes: a text editor, plus a structured editor with an operation palette | Text edits are parsed and anchors re-matched. Palette actions are operations. Either way they become a change set. The checker runs as you type. |
| **Execution** | Generated TypeScript (read-only), tests, proof status, step traces, a state inspector, logs and the effect queue | Only two actions: "turn this trace into a test", and editing state inside a sandbox | The first produces an `add_test` operation. Sandbox edits never reach the real store. |

**Editing a gloss sentence.** The gloss is a deterministic projection, so it can't be edited directly. Editing a sentence is treated as an instruction scoped to the anchors that sentence cites. For example, changing "Anyone else is denied" to "Collaborators may also delete" becomes an utterance aimed at `DeleteProject`'s permit. The pipeline drafts a change set, and that change set is a loosening, so it gets a medium-risk review card. The gloss changes only after the change set is approved and the projection is recomputed.

**Generated code can never be edited.** There is no "eject" option. If generated code really needs custom logic, the escape hatch is an `extern fn` with a declared contract. The build report then lists it as **Assumed**.

**Target latencies:**

| Operation | Target |
|---|---|
| Parse and type check, incrementally, after a keystroke | Under 200 ms |
| Refinement obligations, using the proof cache | Under 1 s for a typical edit |
| Full verification and tests in the sandbox | Runs in the background, with progress shown on the review card |

## 6.4 The review card

The review card is where safety either works or fails. Its layout is fixed, and the order never changes.

```
// [ILLUSTRATIVE] review card for the collaborator change set (Phase 3)
┌ CS-12 · Invite read-only collaborators ─────────────────────────── MEDIUM ┐
│ WHAT CHANGES FOR USERS (gloss diff)                                       │
│  + Owners and admins can invite an existing user to a project.           │
│  + Invited users can view the project. They cannot change it.            │
│                                                                           │
│ ⚠ NEEDS YOUR ACKNOWLEDGEMENT (2)                                          │
│  [ ] Viewing is loosened. Example: Bob, a member who doesn't own          │
│      "Apollo", can now view Apollo once he's invited.                     │
│      Nobody loses access they had (proven).                               │
│  [ ] Touches R-5 "Users can view their own projects" via GetProject.      │
│      R-5 still holds for owners and admins (proven).                      │
│                                                                           │
│ ◐ DECISIONS (2)   R-15 open: can collaborators be removed?   [Answer]     │
│                   R-16 open: can admins invite?              [Answer]     │
│ ⓘ AI ADDITIONS BEYOND THE REQUIREMENT TEXT (1)                            │
│      "An owner can't be invited to their own project." [Keep] [Remove]    │
│                                                                           │
│ ✓ UNCHANGED  5 declarations (hashes identical) · 14 tests pass · 0 proofs │
│ ▸ Formal diff   ▸ Tests   ▸ Proofs   ▸ Ledger (why the AI did this)       │
│                                    [Reject]  [Approve] (disabled: 2 left) │
└───────────────────────────────────────────────────────────────────────────┘
```

**How much friction each risk level gets:**

| Risk | Before Approve is enabled | Production extra |
|---|---|---|
| Low | Nothing extra. One click. | One approval |
| Medium | Every item in "Needs your acknowledgement" ticked, and every high-risk decision answered | A shadow-mode report attached (Phase 4) |
| High | The above, plus a dry-run report attached | A second approver with the matching role, plus a snapshot before deploying |

**What triggers acknowledgement items.** These come from the impact report and cannot be configured away:
- loosened permissions or guards;
- new capabilities;
- deletions, and removed or retyped fields;
- anything involving Money;
- a proof regressing from Proven to Unproven;
- scope creep;
- touching a node that implements another confirmed requirement;
- AI additions beyond the requirement text.

**The risk policy file:**

```yaml
# [ILLUSTRATIVE] charter.policy.yaml
lower:
  - capability: Http.post
    host: analytics.internal.example
    to: low                   # allowed: a named host the team owns
floors:                       # fixed by Charter; the file cannot lower these
  permission_loosening: medium
  money: medium
  field_removal: high
approvers:
  high: [role:security, role:lead]
```

**Countering approval fatigue:**
- **Friction scales with risk.** Low-risk work stays fast, so people don't learn to click through everything.
- **No more than about seven items are expanded by default.** Anything beyond that is grouped by requirement, with a count.
- **Witness sentences instead of formulas.** "Bob can now view Apollo" can be judged in seconds. `CanEdit ∨ ∃c…` cannot.
- **The audit log records** time spent on each card and on each acknowledgement. This is used in Phase 7 to study fatigue, not to police reviewers.

## 6.5 Requirements coverage panel

The coverage state of each requirement is computed deterministically from four sources:
- the link table;
- the test results;
- the mutation filter;
- the proof cache.

| State | Meaning |
|---|---|
| **Not implemented** | No graph node links to it |
| **Implemented** | Linked nodes exist, but no passing test kills a mutant of them |
| **Tested** | Linked tests pass and kill at least one mutant of the linked nodes |
| **Verified** | Tested, and every proof obligation for the linked nodes is Proven |
| **Runtime-checked** | Tested, but at least one linked obligation is Unproven and checked at runtime |
| **Assumed** | It depends on an adapter, an `extern fn`, or a library module such as `identity` |
| **Outside the language** | Non-functional, for example "pages load in under a second". The panel shows where it is covered instead, such as load tests. |

Status (`confirmed`, `inferred`, `open`) and coverage are separate columns. A requirement can be fully verified and still block the release because nobody has confirmed it.

## 6.6 The four example interactions

### "Explain why this condition exists."

The human selects `guard u.id != p.owner else reject IsOwner` in `InviteCollaborator`, from Example 3.

**What the engine does.** Steps 1 to 3 are deterministic, and step 4 uses the LLM:
1. **Provenance.** It looks up the link table and the intent ledger. That gives the cited requirement, the change set, the AI's stated reason and the approval record.
2. **Entailment check.** An advisory LLM call asks whether the cited requirement's text states this behavior.
3. **Removal analysis.** In a sandbox, it applies `remove_clause` to the guard, then reruns the checker, verifier and tests.
4. **Answer.** It writes the answer from the results above. Only the last suggestion uses LLM wording.

```
// [ILLUSTRATIVE]
This condition rejects an invitation when the invited person already owns the project.

• Requirement: R-10 "Owners and admins can invite collaborators with read-only access."
  R-10 does not state this directly (advisory check).
• Added by: the AI, in change set CS-12, with the reason "Duplicates and self-invites
  are rejected." You approved CS-12 on 4 Nov 2026.
• If removed: an owner could also be listed as a collaborator on their own project.
  No invariant or assert would fail. One test would fail: "owner cannot invite self".
  Access would not change, because owners can already view.

Suggestion: record this as its own requirement so it stays visible.
  [Make it a requirement: "An owner can't be invited to their own project."]  [Remove the condition]
```

**What this exposed.** The Phase 3 rule only checks that each AI operation *cites* a requirement. It cannot check that the requirement *says* what the operation does. The advisory entailment check now runs on every change set. Its findings appear on the review card under "AI additions beyond the requirement text". This mitigates the gap but does not close it, because the check is an LLM judgment. Phase 9 lists it as an open problem.

### "Make this faster without changing behavior."

The human points at `MyProjects` from Example 3. The Execution view's traces show it is the slowest query.

**Step 1: measure.** This is deterministic. The engine seeds a sandbox with generated data that respects every refinement: 10,000 projects and 50,000 collaborator records. It then profiles the query. With the current SQL pushdown, `CanView` becomes a correlated subquery that runs for every project row.

**Step 2: propose.** The LLM suggests candidates.

**Step 3: check each candidate.** This is deterministic. Equivalence is checked as in Phase 3, then performance is measured in the sandbox.

```
// [ILLUSTRATIVE] candidate A
query MyProjects(): List<ProjectView> permit anyone =
  if caller.role == Admin then
    select { id = p.id, name = p.name, owner = p.owner } for p in Project order by p.name
  else
    select { id = p.id, name = p.name, owner = p.owner } for p in Project
      where p.owner == caller.id
         or exists c in Collaborator: c.project == p.id and c.user == caller.id
      order by p.name
```

| Candidate | Equivalence | Sandbox p95 latency, illustrative |
|---|---|---|
| Current version | n/a | 180 ms for a member, 210 ms for an admin |
| **A. Split the admin case** | **Equivalent (proven).** The solver checks two cases. For admins, `CanView` is true for every project. For members, it reduces to "owner, or has a collaborator record". The ordering is identical. | 9 ms for a member, using the owner index and the inferred `Collaborator(user, project)` index. 40 ms for an admin, a plain scan. |
| B. Cache results for 30 seconds | **Not equivalent.** Witness: a collaborator who was removed still sees the project for up to 30 seconds. | Rejected as a behavior change. Offered as a separate decision: "Is a 30-second delay acceptable?" |

**Result.** Candidate A becomes a low-risk change set:
- every permit is unchanged;
- the proof says `equivalent (proven)`;
- all existing tests pass.

Candidate B is never applied silently. It turns into a question, because it changes behavior.

### "Add authentication, but don't change the existing database schema."

The starting point is a single-user version of Example 2. It has no `principal` and no `owner` field on `Task`. In a program with no principal, `anyone` admits every caller.

**Step 1: turn the constraint into a policy.** "Don't change the existing database schema" becomes a change-set policy that the operation applier enforces, not a note the AI tries to remember. The phrase has two readings, so the engine asks:

| ID | Risk | Question | Answer used |
|---|---|---|---|
| Q-1 | Medium | Does "don't change the schema" allow adding new tables, or must everything stay as it is? | "New tables are fine. Don't touch the existing ones." |
| Q-2 | High (permissions) | Existing tasks have no owner. Should they belong to one named user, or be visible to everyone? | "They belong to me, ana@example.com." |
| Q-3 | High (permissions) | Should each person see only their own tasks? | "Yes." |

The answer to Q-1 sets this policy:

```yaml
# [ILLUSTRATIVE] attached to the change sets below
freeze: existing-entities     # rejects add_field, remove_field, retype_field and remove_decl on Task
```

**Step 2: draft.** Ownership can't go on `Task`, so it goes in a new table. The work splits into two change sets, because existing tasks must be claimed before an "every task has an owner" invariant can hold (conformance case `c007`):

```
// [ILLUSTRATIVE] CS-A: authentication and ownership, with no invariant yet
import identity@^1.0 as idn
principal User by account
entity User { account: Id<idn.Account>, email: Text }
entity TaskOwner { task: Id<Task>, owner: Id<User> }
permission Owns(u: User, t: Task) = exists o in TaskOwner: o.task == t.id and o.owner == u.id
// AddTask: also creates TaskOwner { task = t.id, owner = caller.id }
// CompleteTask, DeleteTask: permit changed from 'anyone' to Owns(caller, t)
// DeleteTask: also deletes the task's TaskOwner rows (referential integrity)
// MyTasks: filter changed to Owns(caller, t)
rule ClaimExistingTasks(u: User) permit system
  for t in (select x for x in Task where not exists o in TaskOwner: o.task == x.id) {
    create TaskOwner { task = t.id, owner = u.id }
  }

// CS-B, applied after the operator runs ClaimExistingTasks for ana@example.com
invariant EveryTaskOwned: forall t in Task: exists o in TaskOwner: o.task == t.id
```

**Step 3: review.** The CS-A card shows these results:
- **Policy check: passed (deterministic).** The transitive hash of `Task` is unchanged, so the existing table is untouched. Two tables are added.
- **Permissions are tightened.** For example, a second user can no longer complete Ana's tasks. The card shows this as an intended tightening, linked to Q-3.
- **Tightenings get a card too.** A tightening is normally lower risk than a loosening. This card still has an item to acknowledge, because tasks become invisible until they are claimed.
- **Deployment order.** Deploy CS-A, then run `ClaimExistingTasks` from the operator console, then apply CS-B. CS-B's mandatory migration dry run proves `EveryTaskOwned` holds on the real data before it goes live.

### "Show which requirements are not yet implemented."

The project is the shop from Example 4. The human has also just said "email customers when their payment goes through", but nothing has been drafted for it yet.

```
// [ILLUSTRATIVE] coverage panel, filtered to "not done"
REQ   STATUS      COVERAGE           NOTE
R-9   confirmed   NOT IMPLEMENTED    "Email customers when payment succeeds." No linked nodes.
                                     Needs capability Mail.send, which is not in 'uses'.  [Draft it]
R-7   inferred    Verified           Waiting for your approval: active customers only.   [Approve]
R-8   inferred    Verified           Waiting for your approval: free orders skip charging. [Approve]
L-1   n/a         Assumed            Every pending order eventually ends Paid or Failed.
                                     Covered by an outbox-age monitor, not a proof.
NF-1  confirmed   Outside language   "Checkout responds in under 1 second." Load test: none yet.

Everything else (R-1 to R-6): Verified, or Runtime-checked under paranoid mode.
Release gate: BLOCKED by R-7, R-8 (inferred) and R-9 (not implemented).
```

The panel separates three different reasons something isn't done:
- **nothing has been built;**
- **something is built but not approved;**
- **something can't be built or proven in Charter at all.**

A coverage percentage would blur those three together.

## 6.7 Operator console

```
// [ILLUSTRATIVE]
EFFECT QUEUE · Unknown (1) · Stuck (0) · Held over limit (0)
┌ Payment.charge · order O-5521 · $80.00 · customer C-17 · step #9034 ────────┐
│ State: UNKNOWN after 5 retries (timeouts). Idempotency key s9034:0          │
│ Provider reference: O-5521 (look this up in the payment provider's dashboard)│
│ Order: Pending · Stock: 2 units held                                         │
│                                                                              │
│ [Mark succeeded → runs confirm: order Paid]                                  │
│ [Mark failed → runs compensation: order Failed, 2 units returned]            │
│ [Retry with the same key]  (allowed: adapter is idempotent)                  │
│ Reason (required): ____________________                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rules for operator actions:**
- **Every action is a system step.** It is logged with the operator's identity and the reason they gave, and it is checked against invariants like any other step.
- **Large amounts need two people.** An amount over the project's threshold needs a second operator to confirm.
- **Retry depends on delivery semantics.** "Retry" only appears for adapters that are idempotent (A6).
- **The same console holds the other controls:**
  - the kill switch for each rule (A7);
  - effects held because they exceeded a spending limit;
  - one-off system rules such as `ClaimExistingTasks`.

## 6.8 Working with several people and agents

- **Change sets are proposals.** Several can be pending at once, whether a human or an AI agent wrote them.
- **Conflicts use the `base` hashes from Phase 3.** When one change set lands first, the others rebase automatically if none of their target hashes changed. If a target did change, a conflict view shows both versions of that node side by side, each with its impact.
- **Roles map to risk.** Product owners own requirement text and confirmation. Security approves loosened permissions and new capabilities. Operators run the console. The policy file sets which role approves which risk category.
- **Comments attach to anchors**, so a comment on a guard stays with that guard through later edits. A comment can be turned into an instruction with one click, which sends it through the pipeline.
- **AI agents get exactly the same interface as humans.** They propose change sets and never approve them. This prepares for the multi-agent work in Phase 9.

## 6.9 What the IDE never does

- It never applies an AI change without a review card.
- It never lets anyone edit generated code.
- It never shows AI prose in place of the deterministic gloss.
- It never reports a solver timeout as "safe".
- It never lets a policy file lower permission loosening, money or field removal below their floors.

## Checkpoint

**Decisions:**
- Three views, all projections of one graph. Each view states the graph hash it renders.
- Every edit, from any view, becomes a change set and goes through one review card with a fixed layout.
- Friction scales with risk. Bulk approval is allowed only for fully additive, low-risk change sets.
- A risk policy file per project, with floors that cannot be lowered.
- Coverage has seven states, kept separate from requirement status.
- An advisory entailment check catches AI additions beyond the requirement text.
- An operator console handles `Unknown`, `Stuck` and held effects, with logged actions and a two-person rule for large amounts.
- Natural-language constraints such as "don't change the schema" become policies that the operation applier enforces.

**Open questions:**
- **Witnesses for complex permissions.** A witness sentence is easy for a single loosening. How should the card show permission changes involving three or more entities without overwhelming the reviewer?
- **Default for the two-person rule.** Should it be on by default for every high-risk production change, or only for money?
- **Gloss quality at scale.** A deterministic gloss of a 200-rule program is faithful but long. Requirements can be grouped by feature, but does the gloss need a summary layer that is still deterministic?
- **Sandbox data realism.** Data generated from refinement types can miss real-world skew. That matters for performance claims, like the ones in the second interaction.

**Risks:**
- **The entailment check is itself an LLM judgment.** It will miss some AI additions and flag some false ones. If reviewers learn to ignore it, the gap reopens.
- **Fatigue may still win.** Friction scaled to risk helps, but Phase 7 has to measure whether reviewers really read the witnesses.
- **Multi-step deployments are fragile.** The authentication interaction needed two change sets plus an operator action in between. A forgotten step leaves the system half-migrated. The deployment plan should become a first-class object that the IDE tracks, which is a likely Phase 8 item.
- **Building the IDE is costly.** Three synchronized views, sandboxes and a review card are much more work than the compiler. Phase 8 should ship a minimal version first: a command-line review, then the web IDE.
