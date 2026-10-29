# isolation — writer isolation runbook (spec-10)

Repo-internal writes only. A node declares `isolation: "worktree"`; children
run in their own checkout (the worktree lifecycle belongs to `pi-subagents`,
not to this extension); the pool applies their patches to the main tree at one
seam, after classifying them. External writes never get isolation — a worktree
cannot hold them, so lint refuses the mix (`isolation-mixed-writes`).

## Refusals (structural, never advisory)

| When | Code | What happens |
|---|---|---|
| Unknown `isolation` value | `bad-isolation` | lint refuses the plan |
| Isolated write outside any repository | `isolation-outside-repo` | lint refuses the plan |
| Repo-internal + external writes on one isolated node | `isolation-mixed-writes` | lint refuses the plan |
| Second unisolated repo-internal writer in one batch | `repo-write-conflict` | node deferred before dispatch |
| Dirty repository when a batch carries isolated nodes | `repo-dirty` | the batch is refused, paths listed, nothing dispatched |
| Patch touches another node's declared write | `other-declared` | apply refuses, nothing applied |
| `git apply` fails (tree moved) | `patch-conflict` | node stays undone, manifest keeps the patch |
| `/og-apply` on a node without worktree isolation | `isolation-refused` | command refuses |

No stash, no automatic commit, no shared-tree fallback. Isolation is never
dropped automatically.

## Seam protocol

1. Conductor spawns the child with a managed worktree (branch from `HEAD`;
   named baseRefs are out of scope this wave).
2. Child finishes; conductor captures `git diff --cached HEAD` in the worktree
   into a patch file.
3. `/og-apply <child.patch> <plan.md> <nodeId>`:
   - lint the plan, verify the node declares `isolation: "worktree"`;
   - `parsePatchPaths` reads the file list from the diff headers (`rename to`
     wins over the `b/` side);
   - `classifyPatch` buckets each path — `own | other-declared | undeclared`
     (same target rule as spec-9);
   - one `other-declared` path → nothing applied;
   - otherwise `git apply --whitespace=nowarn -` at the repository root. A
     failed apply is `patch-conflict`; stderr is kept in the run log.
4. `deriveDone` then sees the applied writes on disk — `done` is still make
   semantics over `writes` (spec-7 decision 2 is untouched).

`own` and `undeclared` paths land together; undeclared ones are the reviewer's
garbage list and appear in the run log's `patch-apply` record. Silently
dropping a child's output would be worse than showing it.

## Operator duties

- Commit (or stash) between isolated batches. The seam applies without
  committing, so the main tree is dirty after every apply — the next isolated
  batch is refused `repo-dirty` until you commit. That is deliberate.
- The batch preflight ignores exactly `.pi/subagents/`; everything else dirty
  is yours to clean.

## Probe

`.scratch/isolation-probe/NOTES.md` — refusal, full patch lifecycle with a real
worktree, intrusion with byte-identical `git status` after refusal.
