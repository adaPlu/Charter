# Owner review of the H1 pilot tasks, November 9, 2026

**This is not the independent review that Phase 7 requires.** The project owner reviewed the tasks and approved them. The owner worked on Charter's design and has seen solutions in both languages, so this review cannot rule out the bias that Phase 7's independence rule exists to prevent. A pilot run on these tasks must say so in its report.

## What was reviewed

| Item | Value |
|---|---|
| Reviewer | adaPlu, the project owner |
| Date | November 9, 2026 |
| Packet | `bench/review/packet.md`, frozen version `391e02e02a39…` (`bench/review/freeze.json`) |
| Tasks | All 22 pilot tasks, 88 test scenarios |
| Verdict | Approve, for every task. No edits and no replacements. |
| Verdict sheet | `bench/review/verdicts.md` |

## How the verdicts were recorded

The owner gave the verdicts in a chat session on November 9, 2026, as "Approve all 22", and asked the AI assistant (Claude) to enter them. The assistant typed them into `bench/review/verdicts.md`. It did not choose or change any verdict, and the sheet says who typed it.

The owner gave no per-task notes, so the sheet's notes column is empty. This record cannot say how each of the six checks in `bench/review/README.md` was applied to each task.

## How this differs from the AI pre-review

`docs/pilot/ai-prereview-2026-11-09.md` records checks done by AI models before the packet was frozen. Those checks led to edits. This review is a person's decision on the frozen packet and led to no edits. The two are separate records, and neither is an independent review.

## What changed in the repository

- `bench/review/verdicts.md`: filled in, with rows added for p21 and p22, which the sheet was missing.
- `bench/tasks/p*/task.json`: the `authoredBy` field of all 22 tasks now says the task is an AI-assisted draft approved by the project owner, and that the review was not independent. No request, contract or test changed, so the packet still matches its frozen version.

## Reference answers after the review

Both sets of reference answers were run again on November 9, 2026, with no model, to confirm that nothing had moved.

| Language | Tasks passing every scenario | Results |
|---|---|---|
| TypeScript | 22 of 22 | `bench/results/owner-review-B/runs.jsonl` |
| Charter | 19 of 22 | `bench/results/owner-review-C/runs.jsonl` |

The three Charter gaps are the known ones: p10, p19 and p20. `bench/README.md` and the errata explain each.

## What is still open

- **Independent review.** It is still worth having. A reviewer who has not worked on Charter can start at `bench/review/README.md` at any time and record verdicts in a sheet of their own. If that happens before the pilot runs, the pilot can report an independent review as well as this one.
- **The pilot itself.** It needs access to the AI models and a budget, both of which the owner must approve.
