// Run: node --test test/rfit.test.mjs
// Role-fit rows (spec-13). The formula is rank.ts's (score = coverage ×
// precision) on capability tags; `unknown` is an answer, not a failure.
import assert from "node:assert/strict";
import test from "node:test";
import { fitBatch, fitNode, MIN_FIT } from "../core/rfit.ts";

const entry = (role, holds) => (holds === undefined ? { role } : { role, holds });
const node = (needs, role = "coder") => (needs === undefined ? { role } : { role, needs });

// ── the formula ─────────────────────────────────────────────────────────────

test("fitNode: exact overlap is ok — coverage 1, precision 1", () => {
	const result = fitNode(node(["typescript", "tests"]), entry("coder", ["typescript", "tests"]));
	assert.deepEqual(result, { fit: "ok", coverage: 1, precision: 1, score: 1, missing: [] });
});

test("fitNode: the SPEC example — coverage 2/2, precision 2/3, score 4/6", () => {
	const result = fitNode(node(["typescript", "tests"]), entry("coder", ["typescript", "git", "tests"]));
	assert.equal(result.fit, "ok");
	assert.equal(result.coverage, 1);
	assert.equal(result.precision, 2 / 3);
	assert.equal(result.score, (2 / 2) * (2 / 3));
	assert.deepEqual(result.missing, []);
});

test("fitNode: partial overlap names the missing needs in declaration order", () => {
	const result = fitNode(node(["typescript", "tests", "screenshots"]), entry("coder", ["typescript", "tests", "screenshots", "git"]));
	assert.equal(result.coverage, 1);
	assert.equal(result.precision, 3 / 4);
	assert.deepEqual(result.missing, []);
	const short = fitNode(node(["typescript", "gamedesign"]), entry("coder", ["typescript", "tests"]));
	assert.equal(short.fit, "below");
	assert.deepEqual(short.missing, ["gamedesign"]);
	assert.equal(short.coverage, 1 / 2);
	assert.equal(short.score, (1 / 2) * (1 / 2));
});

test("fitNode: no overlap is below with score 0 and every need missing", () => {
	const result = fitNode(node(["rust", "wasm"]), entry("coder", ["typescript", "tests"]));
	assert.deepEqual(result, { fit: "below", coverage: 0, precision: 0, score: 0, missing: ["rust", "wasm"] });
});

// ── unknown is first-class, never ok ────────────────────────────────────────

test("fitNode: empty needs is unknown, score 0, missing empty", () => {
	const result = fitNode(node([]), entry("coder", ["typescript"]));
	assert.deepEqual(result, { fit: "unknown", coverage: 0, precision: 0, score: 0, missing: [] });
});

test("fitNode: absent needs is unknown", () => {
	assert.equal(fitNode({ role: "coder" }, entry("coder", ["typescript"])).fit, "unknown");
});

test("fitNode: empty holds is unknown — an undeclared agent is not a proven fit", () => {
	assert.deepEqual(fitNode(node(["typescript"]), entry("coder", [])), { fit: "unknown", coverage: 0, precision: 0, score: 0, missing: [] });
});

test("fitNode: absent holds and absent catalog entry are unknown", () => {
	assert.equal(fitNode(node(["typescript"]), entry("coder")).fit, "unknown");
	assert.equal(fitNode(node(["typescript"]), undefined).fit, "unknown");
});

test("fitNode: empty both is unknown", () => {
	assert.equal(fitNode(node([]), entry("coder", [])).fit, "unknown");
});

// ── threshold boundary ──────────────────────────────────────────────────────

test("MIN_FIT is the rank.ts precedent 0.5", () => {
	assert.equal(MIN_FIT, 0.5);
});

test("fitNode: exactly at the threshold is ok (score 0.5 = boundary, inclusive)", () => {
	// coverage 1, precision 1/2 → score 0.5
	const result = fitNode(node(["typescript"]), entry("coder", ["typescript", "git"]));
	assert.equal(result.score, 0.5);
	assert.equal(result.fit, "ok");
});

test("fitNode: just below the threshold is below (0.5 - ε)", () => {
	// coverage 2/3, precision 2/3 → 0.444… < 0.5
	const result = fitNode(node(["typescript", "tests", "rust"]), entry("coder", ["typescript", "tests", "git"]));
	assert.ok(result.score < MIN_FIT);
	assert.equal(result.fit, "below");
	assert.deepEqual(result.missing, ["rust"]);
});

test("fitNode: just above the threshold is ok (0.5 + ε)", () => {
	// coverage 2/2, precision 2/3 → 0.666…
	const result = fitNode(node(["typescript", "tests"]), entry("coder", ["typescript", "tests", "git"]));
	assert.ok(result.score > MIN_FIT);
	assert.equal(result.fit, "ok");
});

// ── fitBatch ────────────────────────────────────────────────────────────────

test("fitBatch: buckets in declaration order, one result row per node", () => {
	const nodes = [
		{ id: "a", role: "coder", needs: ["typescript", "tests"] },
		{ id: "b", role: "coder", needs: ["screenshots"] },
		{ id: "c", role: "reviewer" },
	];
	const catalog = [entry("coder", ["typescript", "tests"]), entry("reviewer", ["review"])];
	const batch = fitBatch(nodes, catalog);
	assert.deepEqual(batch.ok, ["a"]);
	assert.deepEqual(batch.below, ["b"]);
	assert.deepEqual(batch.unknown, ["c"]);
	assert.deepEqual(batch.results.map((row) => row.id), ["a", "b", "c"]);
});

test("fitBatch: a role missing from the catalog is unknown, never below", () => {
	const batch = fitBatch([{ id: "x", role: "ghost", needs: ["typescript"] }], [entry("coder", ["typescript"])]);
	assert.deepEqual(batch.unknown, ["x"]);
	assert.deepEqual(batch.below, []);
});

test("fitBatch: no catalog at all still yields three buckets, all unknown", () => {
	const batch = fitBatch([{ id: "x", role: "coder", needs: ["typescript"] }], undefined);
	assert.deepEqual(batch.unknown, ["x"]);
	assert.deepEqual(batch.ok, []);
	assert.deepEqual(batch.below, []);
});

test("fitBatch: summary names all three buckets", () => {
	const batch = fitBatch(
		[
			{ id: "a", role: "coder", needs: ["typescript"] },
			{ id: "b", role: "coder", needs: ["screenshots"] },
			{ id: "c", role: "reviewer" },
		],
		[entry("coder", ["typescript"])]
	);
	assert.equal(batch.summary, "fit: ok 1 (a) | below deferred 1 (b) | unknown 1 (c)");
});

// ── RTL-03: machine-readable ────────────────────────────────────────────────

test("FitResult survives a JSON round-trip unchanged (RTL-03)", () => {
	const result = fitNode(node(["typescript", "tests", "screenshots"]), entry("coder", ["typescript", "tests"]));
	const round = JSON.parse(JSON.stringify(result));
	assert.deepEqual(round, result);
	const batch = fitBatch([{ id: "a", role: "coder", needs: ["typescript"] }], [entry("coder", ["typescript"])]);
	assert.deepEqual(JSON.parse(JSON.stringify(batch)), batch);
});

test("fitNode is pure: the same inputs give the same result and inputs are untouched", () => {
	const n = node(["typescript", "tests"]);
	const e = entry("coder", ["typescript"]);
	const snapshot = JSON.stringify([n, e]);
	assert.deepEqual(fitNode(n, e), fitNode(n, e));
	assert.equal(JSON.stringify([n, e]), snapshot);
});
