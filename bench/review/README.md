# Reviewing the H1 pilot tasks

Thank you for reviewing these. This page is everything you need. It should take two to four hours.

## What this is for

Charter is a new programming language. The H1 pilot asks one question: do AI models write working Charter programs more often than working TypeScript programs, for the same task? Each of the 22 tasks in [packet.md](packet.md) is given to models in both languages, and the tests decide whether each program works.

The tasks were drafted with AI help by the people building Charter. That is a problem: whoever designs a language can, without meaning to, pick tasks that suit it. Your review is the safeguard. **You should not have worked on Charter's design**, and you should not look at any solution before you finish.

## What not to read

- `bench/tasks/*/reference.ts` and `bench/tasks/*/reference.charter`: the solutions.
- `docs/`, `spec/` and `bench/manual/`: the language design and the model manuals.

Read only [packet.md](packet.md), which shows each task exactly as a model would see it, plus the hidden tests.

## What to check, for each task

1. **Is it realistic?** Would a small business or team plausibly ask for this? Is it the kind of thing its family claims to be?
2. **Does the request decide every test?** Read the request and contract as a programmer who has never seen the tests. For every hidden test step, could you have predicted the answer from the request alone? If a careful programmer could reasonably answer differently, the test measures luck. Typical traps: rounding, sort order, ties, whether "anyone" includes people who are not signed in, and which error wins.
3. **One failure at a time.** A step that expects a rejection should break exactly one rule. If a call is both unauthorized *and* invalid, a correct program could reject it for either reason.
4. **Is it fair to both languages?** The request should not use wording or structure that favours one language. Plain business words are fine even if a language reserves them.
5. **Are the tests enough?** Would an obviously wrong program still pass? Name the gap.
6. **Is the set balanced?** Across all 22: a spread of difficulty, nothing duplicated, and the six families each fairly represented.

Statuses are fixed for all tasks: ValidationError 400, Denied 403 (404 when a query is refused), NotFound 404, anything else 409.

## How to answer

Fill in [verdicts.md](verdicts.md). For each task write **Approve**, **Edit** (say exactly what to change), or **Replace** (write a new task, or say why it should go). Add anything about the set as a whole at the end.

You may also write new tasks of your own. The rules for task authors are in [../README.md](../README.md), under "Writing a task"; the most important is to write the request and tests before thinking about any solution.

Your name goes into each approved task's `authoredBy` field, and the pilot report says who reviewed the tasks and whether they had any part in Charter's design.

## About the AI pre-review

Before this packet was frozen, AI models checked it and the tasks were edited (`docs/pilot/ai-prereview-2026-11-09.md`). That was not a review by you and does not count as one. Please **do not read it until your verdicts are written**, so it cannot steer you. Afterwards, compare: anything it missed or decided badly is worth saying.

The packet you received is frozen (`freeze.json`). If anything in the tasks changes after you start, you will be told exactly what.

## Status

On November 9, 2026 the project owner reviewed the frozen packet and approved all 22 tasks. Those verdicts are in [verdicts.md](verdicts.md), and the record is `docs/pilot/owner-review-2026-11-09.md`. The owner worked on Charter's design and has seen solutions, so that was not the independent review this page asks for. If you are an independent reviewer, everything above still applies: do not read the owner's verdicts first, and record yours in a new file, `verdicts-<your name>.md`, with the same columns.
