# plan store — runbook (spec-6)

The plan is a **markdown file with exactly one fenced `og-plan` JSON block**.
Narrative outside the fence, graph inside it. Edit the graph by editing the
file; prove the edit with lint; only then execute.

## Where

- Plans: `<project>/.pi/orchestration-graph/plans/<slug>.md`
- Maps: `<project>/.pi/orchestration-graph/load-maps/load-map-<role>-<hash>.md`
- Run logs: `<project>/.pi/orchestration-graph/runs/<plan>-<stamp>.jsonl`

The extension creates all three directories lazily on first write
(`ensureOgDirs(cwd)`). Nothing creates them by hand; if they are missing, the
first plan write or marker append makes them.

## Writing a plan

1. Create `plans/<slug>.md`: a short narrative (why, context, author's words)
   plus the `og-plan` block.
2. Nodes in declaration order — the order **is** the dispatch priority.
   `requires` is sorted by the planner's judgment of what matters most, because
   `fitPaths` truncates from the tail, never re-sorts.
3. Split the two kinds of material (spec-7):
   - `requires` — preload for the load turn. Truncated under the window budget.
   - `reads` — task material. Listed whole in the dispatch text, never truncated.
   A large source document belongs in `reads`; a working file the child must hold
   at turn start belongs in `requires`.
4. `writes` is mandatory and non-empty. It is the done predicate, the
   independence set, and the declared output list. A node with no output cannot
   be scheduled.
5. Every path in `requires`/`reads`/`writes` is normalized (`C:/...`, no
   `.`/`..`); lint refuses anything else, naming the offending path.
6. `dependsOn` forms a DAG. `width` defaults to 1; declare N only for branches
   with disjoint `writes`.

## Growing the plan mid-run

An undeclared subtask discovered during execution becomes a node appended to
the same block — between dispatches, never during a child's run (single-writer
discipline). Then `/og-plan` re-proves the file before the new node is
dispatched.

## The executor reads

- `lintPlan(text)` → refuse on `!ok` (never partially execute).
- `dispatchable(plan, done)` → the next candidates, in declaration order.
- per candidate: `fitPaths(node.requires, windowBudget, { sizeOf })` → the path
  list for the load turn; write `dropped` into the map's `gaps:` (spec-4
  honesty contract).
- then spec-3 rank, spec-5 rewind, spec-4 dispatch — this spec owns none of
  that machinery.

## Window budget

`fitPaths` charges `ceil(bytes/4) + 64` per file and fills greedily in
declaration order. The budget is the role window minus the reserve for the map
and the task text — the caller (wave-4 dispatcher) owns the number; this module
enforces the cap and reports `kept`/`dropped`/`missing`. A missing file is
charged a 1 KB estimate and reported; bytes/4 is an estimate by design, the cap
is not an invoice.

## Diagnostics

`/og-plan <path>` lints one file; `/og-plan` lints every `.md` in
`<cwd>/.pi/orchestration-graph/plans/`. Failures render as
`code(node) detail` lines suitable for a status file.

## Hard rules (spec-11)

Beyond structure, lint checks three text rules:

- `write-not-in-task` — every `writes` entry must be named in the task text
  (full path, basename, or as the `.test.` twin of a task-named file).
  Default: **warning**; `/og-plan --strict` promotes it to an error. Warnings
  are the default because the settled plan corpus (mc-full-parity, Round8)
  legitimately omits test twins; new plans should be authored strict.
  The phantom case a twin can mask (P2-8 recipes.test.ts) is caught
  dynamically by settle make-semantics (spec-12) — text alone cannot
  separate a phantom twin from a real one.
- `no-budget-line` (warning) — a task with a live/screenshot gate
  (`npm run live`, `screenshot`) should carry a `Budget:` line (units first,
  live attempts capped). Recorded lesson: up-front budget = single-take
  staging (P2-12) vs 24-iteration burn (P2-11).
- `render-gate-unproducible` (warning) — a frame-gated node should own a
  write from which the expected frame can plausibly be produced (a
  render/screen/harness/demo path). The P2-3 trap: a frame only reachable
  through another node's file pushes the child into an intrusion.

Warnings render via `og: warnings:` and never fail the lint; they are the
corpus-wide debt list and promote to errors once plans are revised.
