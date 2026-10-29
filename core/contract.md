# load-ready contract

One marker, one map, one normalizer. Mirrors `.docs/SPECS/orchestration-graph/spec-2-load-ready-contract.md`.

## Why

A reuse point in a role-sub-agent's session is *created*, not discovered: the task arrives first in
today's session shape. The marker records where that point is; the map records what the point holds.
`pi-subagents` rejects `extensionBindings` on a retained `resume`, so everything the reuser needs must
be inside the marker.

## Marker — `custom` entry, `customType: "load-ready"`

```jsonc
{
  "v": 1,
  "role": "explore",
  "files": ["C:/abs/path/a.ts"],   // normalized, absolute, deduplicated
  "mapPath": "C:/.../load-map-explore.md",
  "requires": ["C:/abs/path/a.ts"], // optional; only when the plan already knows
  "at": "2026-10-17T21:49:58.555Z", // freshness for the pool policy
  "by": "orchestration-graph/1"     // writer id + contract version
}
```

A `custom` entry is in the tree and in the `.jsonl`, and is not sent to the model — measured cost is
~0 prompt tokens (spec-1 AC5).

## API

| Export | Contract |
|---|---|
| `normalizePath(p)` | `/` separators, `.`/`..` resolved, case preserved, idempotent |
| `uniquePaths(paths)` | normalized + deduplicated, order preserved |
| `writeMarker(manager, input)` | appends the entry, returns its id; never writes messages, never triggers a turn |
| `readMarker(entry)` | the payload, or `undefined` for any other type / `v` — never guesses |
| `markerAge(entry, now?)` | ms since `at`, `undefined` when not a marker |

`writeMarker` requires `role`, `files`, `mapPath`; `at` defaults to the current time.

## Map — `load-map-<role>.md`

```markdown
# load-map — <role>
- read: <path>
  - contains: <one line>
  - symbols: <comma list or "n/a">
- gaps: <what was NOT read and why>
```

`gaps` is load-bearing: without it the ranker cannot tell "loaded and complete" from "loaded and
truncated at the window cap".

## Traps

- Do not parse `entry.data` outside this module. One reader, one shape.
- Do not lower-case paths. Windows is case-insensitive; the session file stays byte-faithful.
- Do not put the map in the entry. It is a file; the marker stores `mapPath`.
- Do not accept an unknown `v`. Session files are append-only and never migrated.
