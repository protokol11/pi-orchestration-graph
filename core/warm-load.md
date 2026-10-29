# warm-load runbook

How to create a reuse point for a role sub-agent, and how it fails.
Mirrors `.docs/SPECS/orchestration-graph/spec-4-warm-load.md`.

## Dispatch

1. Build the path list and the map path: `<project>/.pi/orchestration-graph/load-maps/load-map-<role>-<shortId>.md`.
   `<shortId>` keeps two copies of one role apart — a pool may hold both.
2. `loadPrompt(paths, mapPath, role)` → spawn the role child with that text as its task.
   The child must have `read` + `write` only: no `bash`, no `edit`.
3. When the child's run is **terminal**, call
   `appendLoadMarker(childSessionFile, { role, files: paths, mapPath }, { open: SessionManager.open })`.
   Use the same `paths` array that built the prompt — the marker must describe what was asked for.
4. Reuse: `subagent({ action: "resume", id: <runId>, message: <task> })`. The resumed run starts from the
   marker leaf.

## Failure reasons (all are `ok: false`)

| Reason | Meaning | What to do |
|---|---|---|
| `map-missing` | the child did not write the map | spawn a fresh node; do not mark |
| `map-incomplete` | the map has no `read:` or no `gaps:` line | fix the load prompt, re-run the load |
| `duplicate` | a marker with this role + map path is already on the branch | reuse the existing marker id |
| `invalid-input` | empty role / files / mapPath, or the file cannot be opened | fix the caller |
| `lost-to-concurrent-writer` | the write landed but is not the leaf | **never** write while another manager holds the file; retry only after confirming the run is terminal |

## Traps (measured)

- **Two open managers do not error.** The earlier entry becomes a sibling branch and leaves the active
  line silently. That is why the append reopens the file and requires `getLeafId() === markerId`.
- **Never write inside a running turn.** Move and write while idle; a write during a turn breaks turn
  bookkeeping.
- **A compaction above the marker invalidates it.** `markerValidity(branch, markerId)` returns
  `compacted`; treat the node as absent, not as stale.
- **The child never sees the marker.** It is a `custom` entry: in the tree, out of the model context. Do
  not "helpfully" inject it into a prompt.

## Diagnostics

`/og-markers` lists the `load-ready` markers on the current branch with role, file count and validity.
Read-only; no state.
