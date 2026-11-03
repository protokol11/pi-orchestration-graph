// Run: node --test test/rfit.test.mjs
// Role-fit rows (spec-13). The formula is rank.ts's (score = coverage ×
// precision) on capability tags; `unknown` is an answer, not a failure.
//
// Gating is COVERAGE, not score (owner decision 2026-11-02). A node fits when
// coverage >= MIN_COVERAGE. score is computed and reported for ordering and
// audit only. Reason: precision punishes a versatile agent on a narrow task
// (measured: coder[code] scored 0.25 with missing [] — nothing was lacking).
import assert from "node:assert/strict";
import test from "node:test";
import {
	BAND_WIDTH,
	bandOf,
	buildRfitQuestions,
	familyOf,
	fitBatch,
	fitNode,
	mapVerdicts,
	MIN_COVERAGE,
	MIN_FIT,
	VERDICT_CONFIDENCE,
} from "../core/rfit.ts";

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
	const short = fitNode(node(["typescript", "gamedesign", "audiomix"]), entry("coder", ["typescript", "tests"]));
	assert.equal(short.fit, "below");
	assert.deepEqual(short.missing, ["gamedesign", "audiomix"]);
	assert.equal(short.coverage, 1 / 3);
	assert.equal(short.score, (1 / 3) * (1 / 2));
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

// ── threshold boundary: coverage gating (owner decision 2026-11-02) ──

test("MIN_COVERAGE is the rank.ts precedent 0.5", () => {
	assert.equal(MIN_COVERAGE, 0.5);
});

test("MIN_FIT stays the score constant 0.5 — reported, never gating", () => {
	assert.equal(MIN_FIT, 0.5);
});

test("fitNode: the regression case — 1 need, 4 holds, score 0.25, is ok", () => {
	// coder[code]: coverage 1, precision 1/4, score 0.25. Nothing is missing, so
	// score gating was wrong here. Coverage gates: ok.
	const result = fitNode(node(["code"]), entry("coder", ["code", "typescript", "tests", "git"]));
	assert.equal(result.coverage, 1);
	assert.equal(result.precision, 1 / 4);
	assert.equal(result.score, 0.25);
	assert.deepEqual(result.missing, []);
	assert.equal(result.fit, "ok");
});

test("fitNode: coverage exactly 0.5 is ok (boundary inclusive)", () => {
	// needs 2, holds 1 → coverage 1/2
	const result = fitNode(node(["typescript", "tests"]), entry("coder", ["typescript"]));
	assert.equal(result.coverage, 0.5);
	assert.equal(result.fit, "ok");
	assert.deepEqual(result.missing, ["tests"]);
});

test("fitNode: coverage 1/3 is below (just under the line)", () => {
	// needs 3, holds 1 → coverage 1/3
	const result = fitNode(node(["typescript", "tests", "rust"]), entry("coder", ["typescript"]));
	assert.ok(result.coverage < MIN_COVERAGE);
	assert.equal(result.fit, "below");
	assert.deepEqual(result.missing, ["tests", "rust"]);
});

test("fitNode: a low score no longer gates — coverage 2/3 with score 0.444 is ok", () => {
	// The retired row: this was `below` under score gating. Coverage 2/3 gates: ok.
	const result = fitNode(node(["typescript", "tests", "rust"]), entry("coder", ["typescript", "tests", "git"]));
	assert.equal(result.coverage, 2 / 3);
	assert.ok(result.score < MIN_FIT);
	assert.equal(result.fit, "ok");
	assert.deepEqual(result.missing, ["rust"]);
});

test("fitNode: coverage 1 with precision 1/2 is ok, score 0.5 is reported", () => {
	// coverage 1, precision 1/2 → score 0.5
	const result = fitNode(node(["typescript"]), entry("coder", ["typescript", "git"]));
	assert.equal(result.score, 0.5);
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

// ── spec-14: the judgment band ──────────────────────────────────────────────

const ok = (coverage) => ({ fit: "ok", coverage, precision: 1, score: coverage, missing: [] });
const at = (fit, coverage) => ({ fit, coverage, precision: 0, score: 0, missing: [] });

test("bandOf: unknown is always in band — missing declarations are a question, not a verdict", () => {
	assert.equal(BAND_WIDTH, 0.15);
	assert.equal(bandOf(at("unknown", 0)), true);
});

test("bandOf: an ok inside ±0.15 of the gate is in band, edges included", () => {
	assert.equal(bandOf(ok(0.5)), true, "exactly on the gate");
	assert.equal(bandOf(ok(0.6)), true);
	assert.equal(bandOf(ok(0.65)), true, "upper edge, float noise absorbed");
	assert.equal(bandOf(ok(0.6499999)), true);
});

test("bandOf: an ok outside the band asks nothing", () => {
	assert.equal(bandOf(ok(0.66)), false, "0.16 above the gate");
	assert.equal(bandOf(ok(0.75)), false);
	assert.equal(bandOf(ok(1)), false);
});

test("bandOf: below is never in band — below by a mile is a refusal, not a question", () => {
	assert.equal(bandOf(at("below", 0)), false);
	assert.equal(bandOf(at("below", 0.49)), false, "just under the line is still a refusal");
});

test("familyOf: the prefix before the first ':' or '-' is the family", () => {
	assert.equal(familyOf("coder"), "coder");
	assert.equal(familyOf("coder-typescript"), "coder");
	assert.equal(familyOf("coder:typescript"), "coder");
	assert.equal(familyOf("coder-typescript-fast"), "coder");
	assert.equal(familyOf("reviewer"), "reviewer");
	assert.equal(familyOf(""), "");
});

// ── buildRfitQuestions: one noul question per (band node, family candidate) ──

const BAND_CATALOG = [
	entry("coder", ["typescript"]),
	entry("coder-typescript", ["typescript", "rust"]),
	entry("reviewer", ["review"]),
];

test("buildRfitQuestions: a band node gets one question per family candidate", () => {
	const questions = buildRfitQuestions(
		[{ id: "n1", role: "coder", needs: ["typescript", "rust"], task: "add the typed loader" }],
		BAND_CATALOG
	);
	assert.deepEqual(Object.keys(questions), ["rfit:n1:coder", "rfit:n1:coder-typescript"]);
	const question = questions["rfit:n1:coder-typescript"];
	assert.equal(question.type, "noul");
	assert.equal(question.cp_key, "rfit:n1:coder-typescript");
	assert.equal(question.node, "n1");
	assert.equal(question.agent, "coder-typescript");
	// The shipped lint needs `instructions`; the metadata rides beside it.
	assert.match(
		question.instructions,
		/^Does agent coder-typescript \(holds: \[typescript, rust\]\) cover subtask: add the typed loader\?$/
	);
	assert.equal("reviewer" in questions, false, "another family is never asked about");
});

test("buildRfitQuestions: a settled node asks nothing", () => {
	const questions = buildRfitQuestions([{ id: "n2", role: "coder", needs: ["typescript"], task: "small" }], BAND_CATALOG);
	assert.deepEqual(questions, {}, "coverage 1 is out of band");
});

test("buildRfitQuestions: a role with no family in the catalog yields no question for that node", () => {
	const questions = buildRfitQuestions([{ id: "n3", role: "ghost", needs: ["typescript"], task: "haunt" }], BAND_CATALOG);
	assert.deepEqual(questions, {}, "no candidate, so nothing to ask — the pool still lists the node");
});

test("buildRfitQuestions: the task slice is bounded and whitespace-normalized", () => {
	const long = `line one\nline two ${"x".repeat(400)}`;
	const questions = buildRfitQuestions(
		[{ id: "n4", role: "coder", needs: ["rust", "screenshots"], task: long }],
		[entry("coder", ["rust", "git"])]
	);
	const text = questions["rfit:n4:coder"].instructions;
	assert.equal(text.includes("\n"), false);
	assert.ok(text.length < 260, "long tasks are sliced, not pasted whole");
	assert.ok(text.endsWith("…?"), "the slice is marked");
});

test("buildRfitQuestions is pure and JSON-serializable (RTL-03)", () => {	const nodes = [{ id: "n1", role: "coder", needs: ["typescript", "rust"], task: "add the typed loader" }];
	const before = JSON.stringify([nodes, BAND_CATALOG]);
	const first = buildRfitQuestions(nodes, BAND_CATALOG);
	assert.deepEqual(first, buildRfitQuestions(nodes, BAND_CATALOG));
	assert.equal(JSON.stringify([nodes, BAND_CATALOG]), before);
	assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

// ── mapVerdicts: deterministic, conservative, 0.8 boundary ──────────────────

const QUESTIONS = {
	"rfit:n1:coder": { type: "noul", cp_key: "rfit:n1:coder", node: "n1", agent: "coder", instructions: "q1" },
	"rfit:n1:coder-typescript": { type: "noul", cp_key: "rfit:n1:coder-typescript", node: "n1", agent: "coder-typescript", instructions: "q2" },
};

test("mapVerdicts: 0.79 stays unknown even when the value is yes", () => {
	assert.equal(VERDICT_CONFIDENCE, 0.8);
	const mapping = mapVerdicts({ "rfit:n1:coder": QUESTIONS["rfit:n1:coder"] }, { "rfit:n1:coder": { value: "yes", confidence: 0.79 } });
	assert.deepEqual(mapping.moves, []);
	assert.deepEqual(mapping.unresolved, ["rfit:n1:coder"]);
});

test("mapVerdicts: 0.80 yes moves to ok", () => {
	const mapping = mapVerdicts({ "rfit:n1:coder": QUESTIONS["rfit:n1:coder"] }, { "rfit:n1:coder": { value: "yes", confidence: 0.8 } });
	assert.deepEqual(mapping.moves, [{ id: "n1", agent: "coder", fit: "ok" }]);
	assert.deepEqual(mapping.unresolved, []);
});

test("mapVerdicts: 0.80 no moves to below", () => {
	const mapping = mapVerdicts({ "rfit:n1:coder": QUESTIONS["rfit:n1:coder"] }, { "rfit:n1:coder": { value: "no", confidence: 0.8 } });
	assert.deepEqual(mapping.moves, [{ id: "n1", agent: "coder", fit: "below" }]);
	assert.deepEqual(mapping.unresolved, []);
});

test("mapVerdicts: a mixed batch splits moves and unresolved by confidence", () => {
	const mapping = mapVerdicts(QUESTIONS, {
		"rfit:n1:coder": { value: "no", confidence: 0.9 },
		"rfit:n1:coder-typescript": { value: "yes", confidence: 0.4 },
	});
	assert.deepEqual(mapping.moves, [{ id: "n1", agent: "coder", fit: "below" }]);
	assert.deepEqual(mapping.unresolved, ["rfit:n1:coder-typescript"]);
});

test("mapVerdicts: a missing verdict is unresolved, never guessed", () => {
	const mapping = mapVerdicts(QUESTIONS, { "rfit:n1:coder": { value: "yes", confidence: 0.95 } });
	assert.deepEqual(mapping.moves, [{ id: "n1", agent: "coder", fit: "ok" }]);
	assert.deepEqual(mapping.unresolved, ["rfit:n1:coder-typescript"]);
});

test("mapVerdicts: an unusable value or absent verdicts stay unresolved in question order", () => {
	const mapping = mapVerdicts(QUESTIONS, { "rfit:n1:coder": { value: "maybe", confidence: 0.99 } });
	assert.deepEqual(mapping.moves, []);
	assert.deepEqual(mapping.unresolved, ["rfit:n1:coder", "rfit:n1:coder-typescript"]);
	assert.deepEqual(mapVerdicts(QUESTIONS, undefined).unresolved, ["rfit:n1:coder", "rfit:n1:coder-typescript"]);
});

// ── the shipped judgment lint must accept the batch, before any model call ──

// This row mirrors the checks the extension's pure `lintQuestions` performs
// (type in noul/choice/score, non-empty instructions). The gate itself runs in
// the judge tool, which owns the batch; a second linter here would drift.
test("every band question satisfies the shipped lint contract (spec-14 / RTL-04)", () => {
	const questions = buildRfitQuestions(
		[{ id: "n1", role: "coder", needs: ["typescript", "rust"], task: "add the typed loader" }],
		BAND_CATALOG
	);
	assert.ok(Object.keys(questions).length > 0, "fixture must produce a batch");
	for (const [key, question] of Object.entries(questions)) {
		assert.equal(key, question.cp_key, "the map key is the cp_key");
		assert.equal(question.type, "noul");
		assert.equal(typeof question.instructions, "string");
		assert.ok(question.instructions.trim().length > 0, "empty instructions are refused by lint");
		assert.equal(typeof question.node, "string");
		assert.equal(typeof question.agent, "string");
	}
});

// ── spec-14 review pins (2026-11-02): edge cases from the adversarial review ──

test("familyOf: leading separator falls back to the whole name, never an empty family", () => {
	assert.equal(familyOf("-coder"), "-coder");
	assert.equal(familyOf(":weird"), ":weird");
	assert.equal(familyOf("coder-"), "coder");
	assert.equal(familyOf("a-b-c"), "a");
});

test("mapVerdicts: NaN, over-1.0 and folded-case verdicts behave", () => {
	const questions = {
		"rfit:n:coder": { type: "noul", cp_key: "rfit:n:coder", node: "n", agent: "coder", instructions: "x" },
	};
	const nan = mapVerdicts(questions, { "rfit:n:coder": { value: "yes", confidence: NaN } });
	assert.deepEqual(nan.moves, []);
	assert.deepEqual(nan.unresolved, ["rfit:n:coder"]);
	const over = mapVerdicts(questions, { "rfit:n:coder": { value: "yes", confidence: 1.5 } });
	assert.deepEqual(over.moves, []);
	assert.deepEqual(over.unresolved, ["rfit:n:coder"]);
	const folded = mapVerdicts(questions, { "rfit:n:coder": { value: " YES ", confidence: 0.9 } });
	assert.deepEqual(folded.moves, [{ id: "n", agent: "coder", fit: "ok" }]);
});

test("buildRfitQuestions: duplicate role names in the catalog cannot collide cp_keys", () => {
	// coverage 0.5 (needs x,y; holds x) -> ok and inside the band, so questions are built
	const nodes = [{ id: "n", role: "coder", needs: ["x", "y"], task: "t" }];
	const entries = [
		{ role: "coder", holds: ["x"] },
		{ role: "coder", holds: ["x", "z"] },
	];
	const questions = buildRfitQuestions(nodes, entries);
	assert.equal(Object.keys(questions).length, 1);
	assert.equal(questions["rfit:n:coder"].agent, "coder");
});
