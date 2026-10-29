// Run: node --test test/plan.test.mjs
// Plan lint, dispatchable order, window truncation, dir ownership (spec-6).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	defaultMapPath,
	dispatchable,
	ensureOgDirs,
	fitPaths,
	lintPlan,
	ogDirs,
	parsePlan,
} from "../core/plan.ts";

const GOOD = `
# demo plan

Narrative stays outside the fence.

\`\`\`og-plan
{
  "version": 1,
  "writeRoot": "C:/proj",
  "nodes": [
    {"id": "a", "role": "coder", "task": "do a", "requires": ["src/a.ts"], "writes": ["C:/proj/out/a.md"], "dependsOn": []},
    {"id": "b", "role": "reviewer", "task": "review a", "requires": ["src/a.ts", "docs/r.md"], "writes": ["C:/proj/out/b.md"], "dependsOn": ["a"]}
  ]
}
\`\`\`
`;

test("parsePlan: zero or two fences are reported, one is extracted", () => {
	assert.deepEqual(parsePlan("no fence here"), { graphText: null, blockCount: 0 });
	const two = "```og-plan\n{}\n```\n```og-plan\n{}\n```";
	assert.equal(parsePlan(two).blockCount, 2);
	assert.equal(parsePlan(GOOD).blockCount, 1);
	assert.ok(parsePlan(GOOD).graphText.includes('"nodes"'));
});

test("lintPlan: a valid plan passes with width default 1", () => {
	const result = lintPlan(GOOD);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.plan.nodes.length, 2);
		assert.equal(result.plan.nodes[0].width, 1);
		assert.deepEqual(result.plan.nodes[1].dependsOn, ["a"]);
	}
});

test("lintPlan: no fence → no-graph", () => {
	const result = lintPlan("# nothing\n");
	assert.deepEqual(result, { ok: false, errors: [{ code: "no-graph", detail: "blocks: 0" }], warnings: [] });
});

test("lintPlan: broken JSON → invalid-json", () => {
	const result = lintPlan("```og-plan\n{oops\n```");
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.errors[0].code, "invalid-json");
});

test("lintPlan: dup ids, unknown deps, cycles get distinct codes", () => {
	const dup = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t","writes":["x"]},{"id":"a","role":"r","task":"t","writes":["y"]}]}
\`\`\``);
	assert.equal(dup.ok, false);
	if (!dup.ok) assert.equal(dup.errors[0].code, "dup-id");

	const unknown = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t","writes":["x"],"dependsOn":["ghost"]}]}
\`\`\``);
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.ok(unknown.errors.some((e) => e.code === "unknown-dep" && e.node === "a"));

	const cycle = lintPlan(`\`\`\`og-plan
{"version":1,"writeRoot":"C:/proj","nodes":[{"id":"a","role":"r","task":"t","writes":["C:/proj/x"],"dependsOn":["b"]},{"id":"b","role":"r","task":"t","writes":["C:/proj/y"],"dependsOn":["a"]}]}
\`\`\``);
	assert.equal(cycle.ok, false);
	if (!cycle.ok) assert.ok(cycle.errors.some((e) => e.code === "cycle"));
});

test("lintPlan: unnormalized paths are refused with the offending path named", () => {
	const result = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t","requires":["src\\\\a.ts"],"writes":["./x.md"]}]}
\`\`\``);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.errors.some((e) => e.code === "unnormalized-path" && e.detail === "src\\a.ts"));
		assert.ok(result.errors.some((e) => e.code === "unnormalized-path" && e.detail === "./x.md"));
	}
});

test("lintPlan: width must be an integer ≥ 1; role must be non-empty", () => {
	const result = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"","task":"t","width":0,"writes":["x"]}]}
\`\`\``);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.errors.some((e) => e.code === "empty-role"));
		assert.ok(result.errors.some((e) => e.code === "bad-width"));
	}
});

test("dispatchable: deps must all be done; declaration order preserved; unknown done ids ignored", () => {
	const result = lintPlan(GOOD);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(
		dispatchable(result.plan, ["ghost"]).map((n) => n.id),
		["a"]
	);
	assert.deepEqual(
		dispatchable(result.plan, ["a"]).map((n) => n.id),
		["b"]
	);
	assert.deepEqual(dispatchable(result.plan, ["a", "b"]).map((n) => n.id), []);
});

test("fitPaths: head kept in order, tail dropped, missing charged and reported", () => {
	const sizes = new Map([
		["a.ts", 400], // 100 + 64 = 164
		["b.ts", 400], // 164 → cumulative 328
		["c.ts", 400], // would be 492 > 400
	]);
	const result = fitPaths(["a.ts", "b.ts", "c.ts", "ghost.ts"], 400, {
		sizeOf: (p) => sizes.get(p),
	});
	assert.deepEqual(result.kept, ["a.ts", "b.ts"]);
	assert.deepEqual(result.dropped, ["c.ts", "ghost.ts"]);
	// a missing file is charged the 1 KB estimate but kept only if it fits;
	// here the budget is exhausted, so ghost lands in dropped… it is reported missing regardless.
	assert.deepEqual(result.missing, ["ghost.ts"]);
	assert.equal(result.chargedTokens, 328);
});

test("fitPaths: missing file charged 1 KB estimate when it fits", () => {
	const result = fitPaths(["ghost.ts"], 400, { sizeOf: () => undefined });
	assert.deepEqual(result.kept, ["ghost.ts"]);
	assert.deepEqual(result.missing, ["ghost.ts"]);
	assert.deepEqual(result.dropped, []);
	assert.equal(result.chargedTokens, 256 + 64);
});

test("fitPaths: zero budget keeps nothing", () => {
	const result = fitPaths(["a.ts"], 0, { sizeOf: () => 4 });
	assert.deepEqual(result.kept, []);
	assert.deepEqual(result.dropped, ["a.ts"]);
});

test("fitPaths: never re-sorts — declaration order is the priority", () => {
	const sizes = new Map([
		["big.ts", 4000],
		["small.ts", 40],
	]);
	const result = fitPaths(["big.ts", "small.ts"], 1100, { sizeOf: (p) => sizes.get(p) });
	assert.deepEqual(result.kept, ["big.ts"]);
	assert.deepEqual(result.dropped, ["small.ts"]);
});

const dir = mkdtempSync(join(tmpdir(), "og-plan-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("ensureOgDirs creates plans/ and load-maps/ idempotently", () => {
	const cwd = join(dir, "proj");
	const dirs = ensureOgDirs(cwd);
	assert.equal(existsSync(dirs.plans), true);
	assert.equal(existsSync(dirs.loadMaps), true);
	assert.deepEqual(ensureOgDirs(cwd), dirs);
	assert.equal(dirs.loadMaps, ogDirs(cwd).loadMaps);
});

test("defaultMapPath matches the spec-4 map name shape", () => {
	const path = defaultMapPath(join(dir, "proj"), "Coder", "abcd1234efgh");
	assert.ok(/load-maps[\\/]load-map-coder-abcd1234efgh\.md$/.test(path), path);
});

test("defaultMapPath sanitizes hostile role and hash", () => {
	const path = defaultMapPath(join(dir, "proj"), "Re Viewer!", "@@");
	assert.ok(/load-map-re-viewer--00000000\.md$/.test(path), path);
});

test("lintPlan: writes is mandatory — a node with no outputs is refused", () => {
	const missing = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t"}]}
\`\`\``);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.ok(missing.errors.some((e) => e.code === "no-writes" && e.node === "a"));

	const empty = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t","writes":[]}]}
\`\`\``);
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.ok(empty.errors.some((e) => e.code === "no-writes" && e.node === "a"));
});

test("lintPlan: reads is optional, normalized when present, never folded into requires", () => {
	const bad = lintPlan(`\`\`\`og-plan
{"version":1,"nodes":[{"id":"a","role":"r","task":"t","reads":["doc/./a.md"],"writes":["x"]}]}
\`\`\``);
	assert.equal(bad.ok, false, "unnormalized reads is refused, not silently fixed");
	if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === "unnormalized-path" && e.detail === "doc/./a.md"));

	const clean = lintPlan(`\`\`\`og-plan
{"version":1,"writeRoot":"C:/proj","nodes":[{"id":"a","role":"r","task":"t","reads":["doc/a.md"],"writes":["C:/proj/x"]}]}
\`\`\``);
	assert.equal(clean.ok, true);
	if (clean.ok) {
		assert.deepEqual(clean.plan.nodes[0].reads, ["doc/a.md"]);
		assert.deepEqual(clean.plan.nodes[0].requires, []);
	}
});

test("ensureOgDirs also owns runs/", () => {
	const dirs = ensureOgDirs(join(dir, "proj-runs"));
	assert.equal(existsSync(dirs.runs), true);
	assert.equal(dirs.runs, ogDirs(join(dir, "proj-runs")).runs);
});

// spec-11 hard rules.
test("lintPlan: write not named in task text warns by default, errors in strict mode (spec-11 rule 1)", () => {
	const plan = `\`\`\`og-plan
{"version":1,"writeRoot":"C:/proj","nodes":[{"id":"a","role":"coder","task":"create C:/proj/src/world/tick.ts, the fixed-step seam","writes":["C:/proj/src/world/tick.ts","C:/proj/src/world/tick.test.ts","C:/proj/src/world/phantom.ts"],"dependsOn":[]}]}
\`\`\``;
	// default: warning, lint still ok — the settled pre-spec-11 corpus must stay green
	const lenient = lintPlan(plan);
	assert.equal(lenient.ok, true);
	assert.ok(lenient.warnings.some((w) => w.code === "write-not-in-task" && w.node === "a" && w.detail === "C:/proj/src/world/phantom.ts"));
	assert.ok(!lenient.warnings.some((w) => w.detail === "C:/proj/src/world/tick.test.ts"), "test twin of a task-named file is covered");
	// strict: same plan fails
	const strict = lintPlan(plan, { strict: true });
	assert.equal(strict.ok, false);
	if (!strict.ok) assert.ok(strict.errors.some((e) => e.code === "write-not-in-task" && e.node === "a" && e.detail === "C:/proj/src/world/phantom.ts"));
});

test("lintPlan: frame-gated node without budget line and without a frame producer warns (spec-11 rules 2-3)", () => {
	const result = lintPlan(`\`\`\`og-plan
{"version":1,"writeRoot":"C:/proj","nodes":[{"id":"ui","role":"coder","task":"build C:/proj/src/ui/hud.ts. Gate: npm run live; the newest screenshot must show hearts","writes":["C:/proj/src/ui/hud.ts"],"dependsOn":[]}]}
\`\`\``);
	assert.equal(result.ok, true, "warnings do not fail lint");
	assert.ok(result.warnings.some((w) => w.code === "no-budget-line" && w.node === "ui"));
	assert.ok(result.warnings.some((w) => w.code === "render-gate-unproducible" && w.node === "ui"));
});

test("lintPlan: frame-gated node with budget line and frame producer is warning-free (spec-11)", () => {
	const result = lintPlan(`\`\`\`og-plan
{"version":1,"writeRoot":"C:/proj","nodes":[{"id":"ui","role":"coder","task":"build C:/proj/src/ui/hud-screen.ts with C:/proj/src/ui/demo-scene.ts. Budget: units first, live shot ≤3 attempts. Gate: npm run live; screenshot must show hearts","writes":["C:/proj/src/ui/hud-screen.ts","C:/proj/src/ui/demo-scene.ts"],"dependsOn":[]}]}
\`\`\``);
	assert.equal(result.ok, true);
	assert.deepEqual(result.warnings, []);
});
