# rewind — runbook (spec-5, R6 verdict 2026-10-18)

Parent-side lazy rewind. **There is no hook.** The child never moves its own
tree; the orchestrator rewrites the child's file before it resumes the child.

## When rewind runs

1. A task run on a marked child completed (parent knows — it dispatched the run).
2. Before the next `subagent({action:"resume"})`, the parent calls
   `rewindSessionFile(childSessionFile, { open })`.
3. Only then the parent resumes. The pre-resume position check is replaced by
   the rewind itself plus its post-write verification.

Call `rewindSessionFile` only when the child is **terminal** — never while a run
holds the file. Two open managers do not error; the earlier write silently
leaves the active branch (warm-load P3).

## What it does (all measured in `.scratch/rewind-probe/`)

1. Open the file, `rewindTarget(branch)`:
   - latest `load-ready` marker on the branch; `markerValidity` must be `ok`
     (`compacted` → refuse: moving to a summarized point is not a rewind);
   - zero entries after the marker → `already-at-marker` (nothing to do);
   - only `og-rewound` entries after the marker → `already-rewound` (idempotent
     no-op — a second call must not stack anchors);
   - otherwise → rewind.
2. `SessionManager.branch(markerId)` — move the leaf pointer to the marker.
3. `appendCustomEntry("og-rewound", { v:1, markerId, at, by })` — **the anchor
   is the durability mechanism**. A bare tree move is in-memory only: the leaf
   is recomputed as the last file line on open, so without an append the rewind
   evaporates with the process.
4. Reopen and require: leaf is the anchor and everything after the marker is
   `og-rewound`. Any other shape → `lost-to-concurrent-writer`; treat the node
   as unavailable and spawn fresh.

## What the parent checks before resume

Nothing extra — the rewind's own verification is the check. If it returns
`lost-to-concurrent-writer`, the node is unavailable (`rewind-missing` in spec-5
terms) and the dispatcher falls back to a fresh spawn seeded with the map.

## The task must outlive the window

A rewind drops the task's reads, reasoning and report from the active branch.
The dispatch contract (spec-4) already requires the report/map to be written to
disk before the run ends; rewind assumes the work left the window.

## Diagnostics

`/og-rewind <sessionFile>` in the TUI runs the same function on any child file
and toasts the outcome. Safe to run twice (`already-rewound`).

## Why no self-rewind hook (R1/R2/R3 verdict)

Measured 2026-10-18 on `.scratch/rewind-probe/`:

- **R1** (direct `navigateTree` in `agent_settled`): impossible — the event
  context carries no tree actions (types.d.ts: actions are command-context only).
- **R2** (deferred `/og-rewind` from `agent_settled`): works, but relies on
  sending a message from a notification-only handler — an undocumented
  allowance; correctness still rested on the parent's check anyway.
- **R3** (command as the resume message): works only if the command chains no
  model turn; the nav-probe turn-bookkeeping defect lives exactly there.

R6 (parent-side, this file) achieves the same window with zero hooks, no env
flag, no reliance on handler contracts, and it is testable headless. The cost:
the child's file stays "dirty" between tasks — the task branch remains the
active line until the parent rewinds it. Only the parent ever resumes the
child, so nobody observes the dirty state in the protocol.
