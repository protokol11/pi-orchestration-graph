# orchestration-graph

An explicit topology for pi orchestration: subagent pools, parallelism width, candidates, and a disk-backed dispatcher.

Orchestration-graph is a pi extension that turns an orchestration plan (a markdown file of nodes with declared `writes`, `reads`, and `width`) into a schedule. The premise: an orchestrator under bounded rationality cannot hold the whole task network in its head while also improvising it — so the topology lives on disk, checked by lint, and the dispatcher follows it mechanically. Rules live outside the network, so a run can be audited, replayed, and rewound.

In scope: plan linting, batch selection with declared width, candidate resume from session markers, worktree patch isolation at one seam, and warm-load preload budgeting. Out of scope: anything model-facing — no tools, no context injection, no turns enter the child sessions.

## Install

Prerequisites: Node.js ≥ 22, the `pi` coding agent, a git repository for isolation features.

```sh
mkdir -p ~/.pi/agent/extensions/orchestration-graph
cp -r index.ts core package.json ~/.pi/agent/extensions/orchestration-graph/
```

Restart pi; the `og-*` commands appear as slash commands.

## Usage

One step of a plan, from the repo root:

```sh
pi /og-plan plans/add-auth.md        # lint; expect "og: 1/1 plans ok"
pi /og-dispatch plans/add-auth.md    # one batch; expect "og: batch <ids> (width N)"
pi /og-mark <childSession> plans/add-auth.md <nodeId>
pi /og-apply <child.patch> plans/add-auth.md <nodeId>
pi /og-dispatch plans/add-auth.md    # verdict: accepted / missing / unchanged
```

`og-dispatch` is one step per call: it settles the previous batch against a fresh root scan, then selects the next batch. Repeat until `og: plan finished`.

## Commands

| Command | Effect |
|---|---|
| `/og-plan [file] [--strict]` | Lint a plan file or the whole `plans/` dir; `--strict` promotes write ⊆ task-text to an error |
| `/og-dispatch <plan.md> [--serial]` | One pool step: settle the prior batch, then spawn the next batch (or one node serially) |
| `/og-mark <session> <plan.md> <nodeId>` | Write the post-task load map and a load-ready marker into the child session |
| `/og-rewind <sessionFile>` | Rewind a child session file to its latest load-ready marker |
| `/og-apply <patch> <plan.md> <nodeId>` | Classify and apply a child's patch at the one seam (worktree isolation only) |
| `/og-markers` | Diagnostic: list load-ready markers on the current branch |

## Design

- **Topology as data.** A plan declares nodes, dependencies, `reads`, `writes`, and `width`. `lintPlan` rejects a plan whose writes are not covered by its task text; the dispatcher (`nextBatch`, `nextStep`) never invents structure.
- **Pools and candidates.** Finished child sessions become candidates (`candidatesFromBranch`); a candidate resumes only when its marker files still match, and a warm-load map preloads bounded context for it.
- **Bounded width.** `width` caps how many branches share a wave; write-set overlap is the reason a wider batch is refused or deferred, and spec-8-pool keeps writer isolation per pool step.
- **Disk state, auditable runs.** Batch state, attempts, and verdicts live under `.og/` in the repo root; every step appends to a run log.
- **One seam.** Child patches enter the main tree only through `og-apply`, classified against the plan's declared writes; other-declared or conflicting paths are refused, and `widthCap` is never raised to force progress.

Waves: waves 1–4 are implemented (plan contract, isolation, pool/dispatcher, and the command layer in `index.ts`); wave 5 consumes `width` metadata. Related ideas on hierarchy of harness needs and editable specifications: [`maslow-harness-pyramid-journey.md`](../../../../../../../Notes/Sakana-ai_road/portfolio-facts&plans/journey/maslow-harness-pyramid-journey.md).

## Contributing

Tests: `npm test` (Node's built-in runner, 125 tests across `test/` and `core/`). Type-check: `npm run typecheck`. File issues in the monorepo's `protokol11` tracker.

## License

See [the monorepo LICENSE](../../LICENSE).
