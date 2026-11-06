# The H1 pilot

H1 asks whether models write valid Charter more often than valid TypeScript for the same task (design doc, 7.3). The pilot is the small first run that can stop the project: if Charter's valid-on-first-try gain is under 5 points **and** its programs pass fewer hidden tests, development stops for a design review.

## Status

| Part | State |
|---|---|
| Harness: prompt, check, repair, hidden tests, analysis | Built and tested. A dry run with no model scores both languages' reference solutions 100%, and the repair loop works. |
| Backends | `mock` and `mock-repair` (no model), `ollama`, `llamacpp`, `anthropic` |
| Tasks | 2 validation tasks, written by the design process. **The 20 pilot tasks do not exist yet.** |
| Smoke run with a real model | Done with `llama3.2:3b` through Ollama, on a CPU. All 4 runs completed with 3 repairs each, in 18 to 29 seconds per run. No program was valid in either language. That is expected at 3 billion parameters, and it shows only that the real-model path works. |
| Pilot run | Not run. Needs the decisions below. |

## How it works

For each task, arm and sample, `run.ts`:

1. Sends one prompt: the language manual, the task in plain words, the HTTP contract, and the visible example tests. Hidden tests are never shown.
2. Checks the reply with the language's real tool: `charter check` (parse, types, proofs) or `tsc --strict`.
3. If it fails, sends the checker's diagnostics back, up to 3 times. That gives valid@1 and valid@repair.
4. Starts the program as a server, a fresh database per test, and runs the hidden black-box tests over HTTP. The same tests run unchanged against both languages.

The TypeScript arm gets a scaffold, `scaffold-ts/runtime.ts`, with the same services Charter's runtime gives a Charter program: one transaction per rule call with rollback on rejection, read-only queries, the caller, ids, and identical HTTP statuses. The comparison measures the language, not missing infrastructure.

## Deviations from the design (Phase 7)

| Planned | What this pilot can do | Why |
|---|---|---|
| Arms A (Charter, constrained) against D (TypeScript, constrained) | **C against B: both free decoding** | Hosted APIs and Ollama cannot hold output to a GBNF grammar, and no TypeScript GBNF grammar exists. Arm A runs only on a llama.cpp server; arm D is refused by the harness rather than faked. |
| One run per cell at temperature 0 | Repeated samples only | Current Claude models reject sampling parameters. |
| Two frontier models from different providers | Claude models, plus local models | Only an Anthropic backend is built for hosted models. |

The free-decoding comparison still answers the question that matters most first: with no help from a decoder, do models write valid Charter? If they do not, constraints are the only way to make it work, and that is worth knowing before building them.

Two more things the report must say. The exported grammar forces whitespace after word-like tokens, which matters only for arm A. Charter reserves common words such as `to`, `by`, `set`, `order` and `result`. The wallet task's contract names a parameter `to`, and Charter programs must rename it. That is a real cost of the language, and the pilot should measure it rather than hide it.

## Running it

A dry run, with no model and no cost:

```bash
node bench/harness/run.ts --backend mock --arms B,C --out bench/results/dry-run
```

A local model through Ollama (free, slow on a CPU):

```bash
node bench/harness/run.ts --backend ollama:llama3.2:3b --arms B,C --out bench/results/local
```

Constrained Charter needs a llama.cpp server started with a model:

```bash
node bench/harness/run.ts --backend llamacpp:http://127.0.0.1:8080 --arms A,B,C --out bench/results/llamacpp
```

Claude needs an API key in `ANTHROPIC_API_KEY`. `--pilot` leaves out the validation-only tasks:

```bash
node bench/harness/run.ts --backend anthropic:claude-opus-5-5 --effort high --arms B,C --samples 3 --pilot --out bench/results/pilot-opus
```

Then summarize. Validation-only tasks are left out unless you add `--include-validation`, and are never evidence:

```bash
node bench/harness/analyze.ts bench/results/pilot-opus
```

The Anthropic backend pins the effort level and leaves refusal fallbacks off. A fallback answers with a different model, which would put another model's output under this model's name. A refusal is recorded as a failed run instead. `--fallbacks` turns fallbacks on.

## Decisions needed before the pilot

1. **Task authors.** Phase 7 requires the request, contract and hidden tests of each task to be written independently of Charter's design. Tasks written by the design process favour Charter. The two tasks here are for testing the harness only, and the analysis excludes them.
2. **Models and access.** For example, Claude Opus 5.5 and Claude Sonnet 5.5, with an API key. A local model through llama.cpp would add the constrained arm.
3. **Budget.** The estimate below. A one-task calibration run, for about $1, gives real numbers first.

### Cost estimate

Measured prompt sizes: about 1,000 tokens for TypeScript and 1,600 for Charter, of which the Charter manual is about 1,060. Estimated per run: about 3,000 input tokens across attempts, and 4,000 to 10,000 output tokens, mostly the model's thinking at high effort.

| Model | Runs (20 tasks, 2 arms, 3 samples) | Estimate |
|---|---|---|
| Claude Opus 5.5 ($4 / $20 per million tokens) | 120 | about $10 to $25 |
| Claude Sonnet 5.5 ($2 / $10) | 120 | about $5 to $13 |
| Claude Haiku 5.5 ($0.10 / $0.50) | 120 | under $1 |

These are estimates. The harness records the real token counts of every run in `runs.jsonl`.

## Writing a task

Each task is a folder in `tasks/` with:

- **`task.json`** with these fields:
  - `request`: the task in plain words, as a non-programmer would write it;
  - `contract`: the rules and queries, with argument types and rejection reasons;
  - `tests`: the hidden black-box tests, as HTTP steps;
  - `visibleTests`: the names of the tests that are shown to the model as examples;
  - `validationOnly`: `false` for pilot tasks;
  - `authoredBy`: who wrote the task.
- **At least one reference solution,** `reference.ts` or `reference.charter`, that passes every hidden test. The dry run checks this. A test that no reference passes is a broken test.

Rules for authors:

- **Write the request and tests before looking at any solution, in either language.**
- **Make every test decided by the request.** A test the request does not settle measures luck, so remove it.
- **Test one failure at a time.** A call that is both unauthorized and invalid can fairly be answered either way.
- **Write contracts in plain terms:** Text, Int, Bool, Id, lists of records. Ids are strings, and amounts in cents avoid decimal formatting disputes.
- **Don't avoid words because Charter reserves them.** If a natural parameter name is `to`, use `to`.
