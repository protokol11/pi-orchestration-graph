# root — write root runbook (spec-9)

The plan declares `writeRoot`: an absolute, normalized directory. Every `writes` path of every
node must sit inside it. Lint refuses a plan without the field (`no-write-root`) or with a write
outside it (`write-outside-root`, path-segment aware). A relative or dot-segment root is refused by
the existing `unnormalized-path` rule.

Relative `writes` are resolved against the project `cwd` — the same base `fsProbe` uses. `writeRoot`
is never relative.

## Buckets

A changed path under the root falls into exactly one bucket. The bucket is decided by the **target**,
never by who wrote it.

| Bucket | Meaning | Cost |
|---|---|---|
| `own` | a `writes` path of a node in this batch | feeds the spec-8 verdict |
| `other-declared` | another node's `writes` path | intrusion: node fails (batch of one), batch stops (batch of several) |
| `undeclared` | under the root, in nobody's `writes` | garbage: recorded, never fatal |

`own` is the only bucket allowed to touch the verdict. `other-declared` means the disjointness claim
at packing time was false. `undeclared` is how a tool's `.tmp` file stays visible without stopping a
pipeline.

## Scan

- One scan before the batch, one after; `diffScan` compares them.
- Bound: 10 000 files or 200 MB, whichever comes first. Hitting it yields `truncated: true` and the
  caller degrades to `strayCheck: "skipped"` — a flag, never a failure.
- Ignored subtrees: `.git/`, `node_modules/`, and `.pi/orchestration-graph/` (the pool's own
  run state — infrastructure, not a child's output; without it every verdict would list the pool's
  batch record as its own stray write). Ignore patterns match a name at any depth or a path relative
  to the root, so the nested `.pi/orchestration-graph/` needs no special case.
- Symlinks are recorded as `{ hash: null, size: 0 }` and never followed, so a link cannot walk the
  scan out of the declared root.
- An absent root scans empty: a first run is legal.

## Honest limit

The scan proves set membership, not authorship. Two children in one tree leave no trace of who wrote
a file. That is why severity is a property of the target path.
