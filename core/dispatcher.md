# dispatcher — runbook (spec-7)

The loop turns a plan into runs. State is recomputed from the repository on
every step; the run log is telemetry and nothing reads it back.

## The step

```
lintPlan(text) -> refuse on !ok
deriveDone(plan, fs) -> done[]
nextStep(plan, fs) -> finished | blocked | next(node, action, load)
```

`nextStep` is pure: give it a plan and a filesystem probe and it returns the
same answer every time. That is what makes a crashed run resumable.

## Done

```
done(node) = every w in writes exists AND mtime(w) >= newest write of a done dependency
```

Make semantics. A gate is a node whose `writes` is the report file: the report
exists only if the gate passed, so pass/fail lives in the same state space as
the artifacts. There is no `done.log`. Deleting the run log changes nothing.

A node whose dependency is undone is never done, even if its outputs are
present — the outputs are stale by definition.

## Order and width

Nodes dispatch in declaration order. `width` is a declaration for wave 5 (the
pool), not a schedule: one node per step here. `writeCollisions(plan, ids)`
answers which declared branches cannot share a wave because their `writes`
intersect.

## requires / reads

- `requires` is preloaded and truncated by `fitPaths` under the budget; the
  truncation report (`kept`/`dropped`/`missing`) goes to the run log.
- `reads` is listed in the task text and never truncated. Above
  `readWarnTokens` (default 48k) the step is flagged `readWarn` so the planner
  sees the number. It is a budget signal, not a drop.

## Marker after the task

The child starts task-first. After its `writes` are verified, the parent writes
the post-task map and marker:

```
/og-mark <childSessionFile> <plan.md> <nodeId>
```

The map lists `requires ∪ reads ∪ writes`, sorted and normalized, with
`source: post-task` and `coverage: declared`. `declared` means "the plan said
so" — a coverage claim for ranking, not a transcript proof. A resumed child
re-reads what the task text still names.

## Failure

`maxAttempts` defaults to 2 per node. A child that exits without writing leaves
the node undone and is retried; two failed attempts stop the run at
`node-failed`. The loop never skips a node: dependents would then run on absent
inputs.

## Run log

`runs/<plan>-<stamp>.jsonl`, one line per dispatched step:

```
step, node, action(spawn|resume), candidate?, score?, kept, dropped, missing,
readsTokens, readWarn, declaredWidth, writesVerified, at
```

Write it, never read it.

## Commands

- `/og-dispatch <plan.md>` — one step: derived state, next node, spawn or
  resume, the preload report, the reads budget, and the ready task text. The
  spawn itself is the harness `subagent` tool; the command prepares the step.
- `/og-mark <childSessionFile> <plan.md> <nodeId>` — post-task map and marker.
- `/og-plan [path]` — lint.
