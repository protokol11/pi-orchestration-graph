// Run: node --test core/rank.test.mjs
// One row per prototype case (.scratch/rank-probe/NOTES.md). The decisions are
// the author's verdict, not the implementer's opinion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CACHE_LIFETIME_SEC, MIN_COVERAGE, rank } from "./rank.ts";

const NOW = Date.parse("2026-10-17T22:00:00.000Z");
const minutesAgo = (min) => new Date(NOW - min * 60_000).toISOString();
const f = (n) => `C:/repo/src/f${n}.ts`;
const range = (from, to, prefix = "f") => Array.from({ length: to - from + 1 }, (_, i) => `C:/repo/src/${prefix}${from + i}.ts`);

const candidate = (nodeId, role, files, at, extra = {}) => ({
	nodeId,
	role,
	files,
	at,
	entriesAfterMarker: 0,
	compactedAfterMarker: false,
	...extra,
});

test("case 1 fat-vs-precise: the precise node wins and the score is coverage × precision", () => {
	const result = rank({
		role: "coder",
		requires: [f(1), f(2)],
		now: NOW,
		candidates: [
			candidate("fat", "coder", range(1, 12), minutesAgo(1)),
			candidate("precise", "coder", [f(1), f(2), f(3)], minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "precise");
	// Hand-computed: precise = 1.0 × 2/3, fat = 1.0 × 2/12.
	assert.ok(Math.abs(result.score - (1 * 2) / 3) < 1e-12);
	assert.equal(result.considered, 2);
	assert.equal(result.filtered, 0);
});

test("case 2 tie on coverage: purity decides before freshness", () => {
	const result = rank({
		role: "explore",
		requires: [f(1), f(2), f(3)],
		now: NOW,
		candidates: [
			candidate("old", "explore", [f(1), f(2), f(3)], minutesAgo(4)),
			candidate("new", "explore", [f(1), f(2), f(3), f(4)], minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "old");
});

test("case 3 wrong files: none, and the reason says the floor filtered it", () => {
	const result = rank({
		role: "coder",
		requires: range(1, 4),
		now: NOW,
		candidates: [candidate("wrong-files", "coder", [f(9), f(10)], minutesAgo(1))],
	});

	assert.equal(result.chosen, null);
	assert.equal(result.reason, "filtered:below-floor");
});

test("case 4 wrong role: filtered before scoring, distinct reason", () => {
	const result = rank({
		role: "tester",
		requires: [f(1)],
		now: NOW,
		candidates: [candidate("coder-with-files", "coder", [f(1)], minutesAgo(1))],
	});

	assert.equal(result.chosen, null);
	assert.equal(result.reason, "filtered:role");
});

test("case 5 compacted above the marker: filtered, distinct reason", () => {
	const result = rank({
		role: "coder",
		requires: [f(1)],
		now: NOW,
		candidates: [candidate("compacted", "coder", [f(1)], minutesAgo(1), { compactedAfterMarker: true })],
	});

	assert.equal(result.chosen, null);
	assert.equal(result.reason, "filtered:compacted");
});

test("case 6 stale: a node older than the cache lifetime is not a candidate", () => {
	const result = rank({
		role: "coder",
		requires: [f(1)],
		now: NOW,
		candidates: [candidate("stale", "coder", [f(1)], minutesAgo(30))],
	});

	assert.equal(result.chosen, null);
	assert.equal(result.reason, "filtered:stale");
});

test("case 6b freshness is a filter, not a bonus: a stale node never wins", () => {
	const result = rank({
		role: "coder",
		requires: [f(1), f(2)],
		now: NOW,
		candidates: [
			candidate("stale-perfect", "coder", [f(1), f(2)], minutesAgo(120)),
			candidate("fresh-partial", "coder", [f(1), f(3)], minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "fresh-partial");
	assert.equal(result.filtered, 1);
});

test("case 7 empty requires: explicit none", () => {
	const result = rank({
		role: "coder",
		requires: [],
		now: NOW,
		candidates: [candidate("any", "coder", [f(1)], minutesAgo(1))],
	});

	assert.equal(result.chosen, null);
	assert.equal(result.reason, "requires-empty");
});

test("case 9 pure-narrow vs wide-full: the below-floor node is pre-filtered", () => {
	const result = rank({
		role: "coder",
		requires: range(1, 5),
		now: NOW,
		candidates: [
			candidate("pure-narrow", "coder", [f(1), f(2)], minutesAgo(1)),
			candidate("wide-full", "coder", range(1, 11), minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "wide-full");
});

test("floor-is-filter regression: a below-floor node with the higher score cannot turn a valid answer into none", () => {
	const result = rank({
		role: "coder",
		requires: range(1, 20),
		now: NOW,
		candidates: [
			// coverage 0.45, precision 1.0 → score 0.45 (higher, but below the floor)
			candidate("pure-narrow", "coder", range(1, 9), minutesAgo(1)),
			// coverage 0.50, precision 10/30 → score 0.167 (eligible)
			candidate("wide-full", "coder", [...range(1, 10), ...range(21, 40, "g")], minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "wide-full");
	assert.equal(result.filtered, 1);
});

test("freshness breaks a real score tie", () => {
	const result = rank({
		role: "coder",
		requires: [f(1), f(2)],
		now: NOW,
		candidates: [
			candidate("older", "coder", [f(1), f(2)], minutesAgo(5)),
			candidate("newer", "coder", [f(1), f(2)], minutesAgo(1)),
		],
	});

	assert.equal(result.chosen, "newer");
});

test("reason is non-empty for every result shape", () => {
	const inputs = [
		{ role: "coder", requires: [], candidates: [] },
		{ role: "coder", requires: [f(1)], candidates: [] },
		{ role: "coder", requires: [f(1)], candidates: [candidate("a", "coder", [f(1)], minutesAgo(1))] },
		{ role: "coder", requires: [f(1)], candidates: [candidate("a", "tester", [f(1)], minutesAgo(1))] },
	];
	for (const input of inputs) {
		const result = rank({ ...input, now: NOW });
		assert.equal(typeof result.reason, "string");
		assert.ok(result.reason.length > 0);
	}
});

test("no candidate array is tolerated as none rather than throwing", () => {
	const result = rank({ role: "coder", requires: [f(1)], now: NOW, candidates: undefined });
	assert.equal(result.chosen, null);
	assert.equal(result.reason, "no-eligible-candidate");
});

test("defaults equal the author verdict: minCoverage 0.5, cache lifetime 300 s", () => {
	assert.equal(MIN_COVERAGE, 0.5);
	assert.equal(DEFAULT_CACHE_LIFETIME_SEC, 300);
});

test("rank.ts is pure and carries no exponent knob", () => {
	const source = readFileSync(new URL("./rank.ts", import.meta.url), "utf-8");
	assert.equal(/node:fs/.test(source), false);
	assert.equal(/Date\.now/.test(source), false);
	assert.equal(/\balpha\b/i.test(source), false);
});
