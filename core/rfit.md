# rfit — role-fit runbook (spec-13)

Does this role actually do this task? Dispatch picks a child by role id;
`rfit` says whether that role's declared capabilities cover what the node
needs, **before** a spawn is spent.

```
node    { role: "coder", needs: ["typescript","tests"] }
catalog { role: "coder", holds: ["typescript","git","tests"] }
→ coverage 2/2, precision 2/3, score 4/6 — fit: ok, missing: []
```

## The formula

Same shape as spec-3 ranking (`core/rank.ts`), one formula, two substrates:

| layer | substrate | computed over |
|---|---|---|
| `rank.ts` | warm candidates | `files` ∩ `requires` (file paths) |
| `rfit.ts` | plan nodes | `holds` ∩ `needs` (capability tags) |

```
coverage  = |holds ∩ needs| / |needs|    how much of the need is held
precision = |holds ∩ needs| / |holds|    how much of the load is used
score     = coverage × precision
```

Their product ranks a candidate well. It does not decide fit. Coverage
>= `MIN_COVERAGE` decides fit (2026-11-02), score orders the result.

## Three outcomes — `unknown` is an answer, not an error

| result | when | dispatch |
|---|---|---|
| `ok` | `coverage >= MIN_COVERAGE` | dispatched |
| `below` | `coverage < MIN_COVERAGE`, both sides declared | deferred, reason `fit-below` |
| `unknown` | `needs` empty/absent, or `holds` empty/absent, or role absent from the catalog | dispatched, listed as unproven |

`unknown` is never coerced to `ok`. An undeclared agent and an undeclared task
are both honest blanks; the summary names them so the gap is visible instead of
laundered into a pass. Enforcement tightens as the catalog fills (spec-A), never
by surprise.

## Threshold

Two constants, one gate:

| constant | value | role |
|---|---|---|
| `MIN_COVERAGE` | 0.5 | gating line, the `rank.ts` precedent |
| `MIN_FIT` | 0.5 | score constant, reported and not gating |

`MIN_FIT` stays exported and `score` stays computed. Both feed ordering and the
run-log audit trail. Coverage alone decides `ok` vs `below`. The constant is the
default, not the law: the batch summary prints the actual coverage and precision
numbers, so the owner moves it from evidence (HUMAN-JUDGMENT-FINAL stays with the
human). Boundary is inclusive: `coverage === 0.5` is `ok`.

## Decision addendum (2026-11-02)

Gate is `coverage >= MIN_COVERAGE` at 0.5, the `rank.ts` precedent. The score
(`coverage × precision`) is reported, not gating.

Rationale: precision punishes versatile agents on narrow tasks. Measured on the
real catalog, `coder` holds four tags. A task that needs `[code]` gives coverage
1 and precision 1/4, so score is 0.25. The old rule called that `below` even
though `missing` was empty. Nothing was lacking, so nothing justified a refusal.

Evidence rows after the change:

| role | needs | coverage | score | fit |
|---|---|---|---|---|
| coder | `[code]` | 1 | 0.25 | ok |
| coder | `[rust]` | 0 | 0 | below |
| tester | `[tests]` | 1 | 1/3 | ok |
| explore | `[research]` | 1 | 1/3 | ok |
| coder | `[code, rust]` | 0.5 | 0.125 | ok, missing `[rust]` |

The last row is the trade the owner accepted. Partial coverage passes the gate
and the shortfall stays visible in `missing`.

## `needs` vs `requires` (CP-22)

- `requires` — preload **file paths** for the load turn, truncated by `fitPaths`
  under the window budget (spec-7).
- `needs` — **capability tags** the task requires, resolved against the catalog.

Overloading one field would make an invalid state representable: a node whose
"requires" mixes paths and tags is neither truncatable nor fittable. Two
vocabularies, two fields.

Plans carry `needs`, never `holds`. `holds` belongs to the catalog entry; an
inline copy in a plan is refused by schema lint (`inline-holds`), because a
second unowned source of truth for "what this agent can do" is exactly the
drift K1 closed.

## Purity and injection

`core/rfit.ts` has no fs, no clock, no catalog paths. The caller (pool / index)
resolves the catalog and injects it as `CatalogEntry[]`; tests use fixtures.
Results are JSON-serializable (RTL-03), so the run log can carry them verbatim.

Absent catalog → **no filtering at all** (never fail-closed): a missing producer
is not a plan failure. Same rule at lint time — `unknown-role` is skipped and
noted.

## Exports (PS-02)

Two functions, nothing else:

```
fitNode(node, entry)        -> FitResult { fit, coverage, precision, score, missing }
fitBatch(nodes, entries)    -> { ok, below, unknown, results, summary }
```

## Diagnostics

- Lint: `unknown-role(node) detail=role` when a catalog is injected and the
  role is absent; `role catalog not injected — unknown-role skipped` in
  `LintResult.notes` when it is not.
- Dispatch: `og: batch … | deferred mismatch(fit-below)` plus a
  `fit: ok N (…) | below deferred M (…) | unknown K (…)` line — the audit trail
  for the decision, in the run log and the notify text.

## Review notes

1. The float boundary uses the same `coverage >= MIN_COVERAGE` double expression
   as `rank.ts`. Exact-half rationals (`2/4`) land on 0.5 exactly. Revisit only
   if a consumer needs exactness.
2. `fitBatch` skips nodes without a string id. Lint enforces `id`, so this is
   unreachable after lint. It stays as a pure-function guard.
3. In the unknown branch `missing` is deliberately `[]`. Nothing was claimed, so
   nothing is lacking. Consumers rendering diagnostics must branch on `fit`
   first, before reading `missing`.
4. `index.ts` notify paths (og-plan notes, og-dispatch fit summary) are UI glue
   without unit tests. This is the pre-existing pattern for `index.ts` in this
   repo.

## Out of scope

The judgment band for `unknown`/borderline fit (spec-14), the tag registry,
auto-extraction of `needs` from task text, and catalog frontmatter (spec-A).
