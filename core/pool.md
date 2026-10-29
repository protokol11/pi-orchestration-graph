# pool — batch scheduler runbook (spec-8, amended by spec-9)

`/og-dispatch [plan.md] [--serial]` asks the pool for the next batch. The pool never spawns: it
prints the batch and a ready `runs.all` block; the orchestrator agent executes it.

## Packing

Candidates are the dispatchable nodes in declaration order.

```
batch = []; cap = Infinity; usedSessions = {}
for node of candidates:
  first node           -> admit
  min(cap, width) < n+1 -> defer "width"
  shares a write        -> defer "collision"
  ranked session taken  -> defer "session-taken"
  otherwise             -> admit; cap = min(cap, width)
```

- `width` caps the batch through `min` over its members: a declared `1` is a veto.
- One warm session serves one child per batch; the loser waits and re-ranks next step.
- A node that is not dispatchable is not a candidate and is not listed as deferred.
- Same plan + same filesystem → deep-equal batch.

## Isolation is checked, not created

- One `scanRoot(plan.writeRoot)` before, one after (`<slug>.batch.json` holds the after-scan's
  baseline; deletion loses only the verdict, never scheduling).
- `verifyBatch` reports per node `accepted | missing | unchanged`, plus spec-9's stray buckets.
- `unchanged` is all-or-nothing: every write exists and none changed.
- `strayCheck: "skipped"` when either scan hit the bound; the run continues.

## Retry and exit

- A batch settles fully: a failed child costs only itself.
- Done comes from `deriveDone` (writes on disk), never from the verdict.
- Counters live in `runs/<slug>.attempts.json`; `accepted` clears them.
- At `maxAttempts` the pool returns `node-failed` and the run stops.
- `finished` when all nodes are done; `blocked` when an undone node has no dispatchable path.
- Deleting the run log changes nothing — the log is telemetry.

## Stray policy (spec-9)

| Change | Batch of one | Batch of several |
|---|---|---|
| `own` | feeds the verdict | feeds the verdict |
| `other-declared` | node counted as intrusion, retry counter bumped | batch stops, nothing else dispatched |
| `undeclared` | recorded as garbage | recorded as garbage |

## Serial opt-out

`--serial` runs the spec-7 `nextStep` path exactly: one node, `declaredWidth` reported, no batch
record. Use it on a plan that already declares a width when a serial step is wanted for one turn.

## Settle warning (spec-12)

After the verdict is recorded, `settleWarnings` recomputes `deriveDone` and flags every
accepted node that make-semantics still derives undone:


og: <id> verdict accepted but NOT done — missing: [...]; stale: [...]; blocked by: [...]. Fix the plan's writes, never touch untouched files.

The P2-9 incident: an over-declared write (`player.test.ts` never created) made the node
accepted-by-verdict but not-done-by-derivation, and the gap surfaced only on a later session
resume as a surprise re-dispatch. The warning is emitted through `ui.notify` at level `warn`
and logged in the run log; it never blocks settle or changes the verdict.
