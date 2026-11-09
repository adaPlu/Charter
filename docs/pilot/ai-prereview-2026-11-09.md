# AI pre-review of the H1 pilot tasks, November 7–9, 2026

**This is not the independent review that Phase 7 requires.** Every check here was done by AI models working for the people building Charter. It cleaned up the draft tasks before a person sees them. It does not replace that person, and nothing here counts as their verdict. The human verdicts go in `bench/review/verdicts.md`, which this work did not touch.

The human reviewer should read this page only **after** finishing their own verdicts, so it cannot steer them.

## Who did what

| Work | Done by | Saw solutions? |
|---|---|---|
| Drafting the 20 tasks and their TypeScript references (November 6) | An AI-assisted session; the author is recorded in each `task.json` as an AI-assisted draft | Wrote them |
| Writing a Charter reference for every task (November 6) | Four AI subagents (Claude Opus 5.5), one per five tasks | Yes |
| Check-order review of all 144 expected rejections (November 7) | Two AI subagents (Claude Opus 5.5) | Yes |
| Blind pre-review (November 9) | One AI subagent (Claude Opus 5.5) | **No.** It read only `bench/review/README.md` and `packet.md`, as the human reviewer will. |
| Deciding on every proposal, editing the tasks, re-running the references | Claude Opus 5.5 in Claude Code, the session that also designed and built Charter | Yes |

The person who decides on proposals here is not independent of Charter, which is exactly why a human review is still required.

## Results after the edits

| Check | Result |
|---|---|
| TypeScript references against every scenario | 20 of 20 tasks pass, 80 of 80 scenarios |
| Charter references against every scenario | 18 of 20 pass. p19 (no way to read inside text) and p20 (queries cannot reject with their own reason) fail by design; the project owner chose to keep both. |
| Packet given to the reviewer | `bench/review/packet.md`, frozen on November 9 as SHA-256 `5f4c785cba71…` (`bench/review/freeze.json`). CI fails if any task changes after the freeze. |

## Decisions on every proposal

### From the blind pre-review (November 9)

It found **no wrong expected values and no blockers**. It recomputed every expected value by hand.

| # | Task | Proposal | Decision |
|---|---|---|---|
| 1 | p02 | "Express local delivery is not free" could mean only the surcharge is charged. Reword; also fix the garbled validation line. | **Applied.** The one finding where a careful, correct program could fail. |
| 2 | p06 | "Sorted date, slot, id" does not say whether morning comes before afternoon. Clarify and test it. | **Applied:** morning before afternoon, with a test. **Both references failed the new test**, because they sorted slot names alphabetically; both were corrected. |
| 3 | p07 | The request says "names", the contract says `title`. 40-character limit untested. | **Applied.** |
| 4 | p08 | An author renaming their own page, re-adding a member, and nonblank team names untested or unstated. | **Applied.** |
| 5 | p09 | `Assign ["missing","unknown"]` has two failures (harmless, same status). Subject limit untested. | **Applied.** |
| 6 | p10 | Check the reasons: Denied at step 4, NotFound at step 7. | **Not applied at step 4:** two failures apply there (not enrolled, and no answer), so a reason would make the test depend on check order again; that was fixed on November 7. **Step 7: open decision**, see below. |
| 7 | p11 | An author removing their own item, sorting, and the item length limit untested. | **Applied.** |
| 8 | p13 | CreateEvent's limits, and buying from an event with no stock, untested. | **Applied.** |
| 9 | p16 | Withdrawing after approval untested. | **Applied.** |
| 10 | p17 | Cancelling after shipping untested. | **Applied.** |
| 11 | p18 | "A list of 2" would pass if the wrong review were deleted. | **Applied:** the exact list. |
| 12 | p19 | The 1000-character limit untested. | **Applied with a correction.** The pre-review expected 1 occurrence of "a" in 1,000 a's. That run is one word of 1,000 letters, and partial words do not count, so the answer is **0**. A non-ASCII "Kelvin sign" test was not added: too obscure for a pilot. |
| 13 | p20 | "To itself takes zero" tested only for a known town. | **Applied** (`Zed` to `Zed`). Whether whitespace-only names count as blank was not added: the request does not decide it. |
| 14 | p03, p04, p05 | Missing bound checks. | **Applied.** |
| 15 | All | No test has a non-operator call `Register`. | **Applied** in p04, p09 and p15. |
| 16 | All | No test uses an unregistered id as the caller. | **Not applied.** The request never says what a caller id that names nobody means; adding a test would need that decided first. Left for the human reviewer. |
| 17 | All | Contract types (`Text`, `Int`, `Bool`, `Record`, `List of`) may be Charter's own words, a familiar frame for one language. | **Partly applied.** They are Charter's type names. The contract preamble, shared by both languages, now says what each means in JSON. Whether to rename them entirely is **left for the human reviewer**. |
| 18 | p14 | Customers awarding themselves points is unrealistic. | **Not applied; for the human reviewer.** It changes what the task is, which is their call. |
| 19 | Set | Family F6 (outside Charter's domain) has only 2 tasks, which tilts the set towards Charter. | **Not applied; for the human reviewer and the project owner.** This is a real concern about the set's design, recorded rather than fixed by the designer. |
| 20 | Set | Near-duplicates (p08/p11, p12/p14, p16/p18, p04/p05/p07) and uniformly low-to-middling difficulty. | **Not applied; for the human reviewer.** |

### From the Charter references (November 6)

| Task | Note | Decision |
|---|---|---|
| p13, p18 | A public query in a program with signed-in users could not be written. | **Language changed** (amendment A26, `permit public`), chosen by the project owner. |
| p19, p20 | Cannot be passed in Charter. | **Kept**, by the project owner's choice. |
| p01 | Rounding wording could be read two ways. | **Applied** November 7. |
| p11 | The owner's membership was assumed, not stated. | **Applied** November 7. |
| All | Nothing told a model that a refused query answers 404. | **Applied** November 7, in both manuals. |
| p03 | No `min` for lists; the Charter solution is awkward. | No change: a fair difficulty, not a bias. |
| p06, p07 | The date shape can only be checked approximately in Charter. | No change: no test depends on it. |
| p15 | "No greater than what has already been paid" (net of refunds or not). | No change: both readings give the same answer in every test. |

### From the check-order review (November 7)

Six of 144 expected rejections broke two rules at once (p07, p10, p13, p15, p17, p20). **All six were fixed.** In every one, Charter's own check order gave the expected answer, so the tests had quietly favoured Charter.

## Open decisions for the project owner

1. **p10, step 7.** The request says an enrolled student with no answer gets `NotFound`. The test checks only the 404 status. Charter cannot reject a query with `NotFound` on its own condition, so its reference answers `Denied` with the same status and passes. **The test is lenient in a way that favours Charter.** Checking the reason would make p10 fail in Charter, the same limit as p20. Either check it and accept the failure, or change the language as with A26.
2. **Family balance (proposal 19).** Whether F6 should have more tasks.

## After the pre-review: the owner's decisions (November 9)

Both open decisions above were settled by the project owner before the packet went to the reviewer:

1. **p10, step 7 now checks the reason** `NotFound`. The Charter reference answers `Denied` and fails that scenario; it is marked `// BLOCKED:`.
2. **Two F6 tasks added:** p21-release-versions and p22-shift-coverage. One AI subagent (Claude Opus 5.5) drafted the requests, tests and TypeScript references **without reading anything about Charter**, and another wrote the Charter references afterwards. Neither task has been through the blind pre-review; the human reviewer sees them for the first time.

Results after these changes: TypeScript 22 of 22 tasks, 88 of 88 scenarios; Charter 19 of 22 (p10, p19 and p20 fail). The packet was re-frozen as SHA-256 `c37897d3afa7…`.

Writing p21's Charter reference also found that Text can be read character by character. At the owner's request p19's Charter reference was rewritten that way: it now passes all 4 scenarios, so Charter passes 20 of 22, but it only knows the characters written out in its source and miscounts passages with others, which no hidden test contains. Rewriting it also found a type-checker bug, now fixed. The model manual does not teach the technique. See the errata.

## Every changed file

`bench/tasks/p02…p20/task.json` (16 tasks), `bench/tasks/p06-room-booking/reference.ts` and `reference.charter`, `bench/harness/tasks.ts` (the contract's type line), `bench/review/packet.md` and `freeze.json`. The diff is in the commit that added this page.
