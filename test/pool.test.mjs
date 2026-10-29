// Run: node --test test/pool.test.mjs
// Pool packing, pre/post scan verdict, attempts, and the spec-9 stray policy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePath } from "../core/contract.ts";
import { nextStep, writeCollisions } from "../core/dispatcher.ts";
import { lintPlan } from "../core/plan.ts";
import {
	attemptsPath,
	bumpAttempts,
	clearAttempts,
	nextBatch,
	readAttempts,
	settleWarnings,
	verifyBatch,
} from "../core/pool.ts";
import { scanRoot } from "../core/root.ts";

let clock = 1000;
const node = (id, writes, extra = {}) => ({
	id,
	role: "coder",
	task: `do ${id}`,
	requires: extra.requires ?? [],
	reads: [],
	writes,
	dependsOn: extra.dependsOn ?? [],
	width: extra.width ?? 1,
});
const plan = (nodes, writeRoot = "C:/proj") => ({ version: 1, writeRoot, nodes });
const allAbsent = { exists: () => false, mtime: () => undefined };
const present = (paths, mtime = () => 1000) => {
	const set = new Set(paths.map(normalizePath));
	return { exists: (path) => set.has(normalizePath(path)), mtime: (path) => (set.has(normalizePath(path)) ? mtime(path) : undefined) };
};

const dir = mkdtempSync(join(tmpdir(), "og-pool-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// ── packing ─────────────────────────────────────────────────────────────────

test("nextBatch: four disjoint width-4 nodes pack into one batch", () => {
	const p = plan([
		node("s1", ["C:/proj/s1.md"], { width: 4 }),
		node("s2", ["C:/proj/s2.md"], { width: 4 }),
		node("s3", ["C:/proj/s3.md"], { width: 4 }),
		node("s4", ["C:/proj/s4.md"], { width: 4 }),
	]);
	const result = nextBatch(p, allAbsent);
	assert.equal(result.kind, "batch");
	if (result.kind !== "batch") return;
	assert.deepEqual(result.batch.ids, ["s1", "s2", "s3", "s4"]);
	assert.equal(result.batch.widthCap, 4);
	assert.deepEqual(result.batch.deferred, []);
	assert.equal(writeCollisions(p, result.batch.ids).length, 0);
});

test("nextBatch: a width-1 node first takes a batch of one; the rest defer as width", () => {
	const p = plan([
		node("a", ["C:/proj/a.md"], { width: 1 }),
		node("b", ["C:/proj/b.md"], { width: 4 }),
		node("c", ["C:/proj/c.md"], { width: 4 }),
		node("d", ["C:/proj/d.md"], { width: 4 }),
	]);
	const first = nextBatch(p, allAbsent);
	assert.equal(first.kind, "batch");
	if (first.kind !== "batch") return;
	assert.deepEqual(first.batch.ids, ["a"]);
	assert.deepEqual(first.batch.deferred.map((r) => `${r.id}:${r.why}`), ["b:width", "c:width", "d:width"]);

	const second = nextBatch(p, present(["C:/proj/a.md"]));
	assert.equal(second.kind, "batch");
	if (second.kind !== "batch") return;
	assert.deepEqual(second.batch.ids, ["b", "c", "d"]);
});

test("nextBatch: a width-2 candidate against a width-4 batch of two defers as width", () => {
	const p = plan([
		node("a", ["C:/proj/a.md"], { width: 4 }),
		node("b", ["C:/proj/b.md"], { width: 4 }),
		node("c", ["C:/proj/c.md"], { width: 2 }),
	]);
	const result = nextBatch(p, allAbsent);
	assert.equal(result.kind, "batch");
	if (result.kind !== "batch") return;
	assert.deepEqual(result.batch.ids, ["a", "b"]);
	assert.deepEqual(result.batch.deferred, [{ id: "c", why: "width" }]);
});

test("nextBatch: a shared write defers the second node as collision", () => {
	const p = plan([
		node("a", ["C:/proj/out.md"], { width: 4 }),
		node("b", ["C:/proj/out.md"], { width: 4 }),
		node("c", ["C:/proj/c.md"], { width: 4 }),
	]);
	const result = nextBatch(p, allAbsent);
	assert.equal(result.kind, "batch");
	if (result.kind !== "batch") return;
	assert.deepEqual(result.batch.ids, ["a", "c"]);
	assert.deepEqual(result.batch.deferred, [{ id: "b", why: "collision" }]);
});

test("nextBatch: two nodes ranked to one session — the loser defers and is first next step", () => {
	const p = plan([
		node("a", ["C:/proj/a.md"], { width: 4, requires: ["src/x.md"] }),
		node("b", ["C:/proj/b.md"], { width: 4, requires: ["src/x.md"] }),
	]);
	const candidate = {
		nodeId: "warm",
		role: "coder",
		files: ["src/x.md"],
		at: "2026-10-19T00:00:00.000Z",
		entriesAfterMarker: 0,
		compactedAfterMarker: false,
	};
	const result = nextBatch(p, allAbsent, { candidates: [candidate] });
	assert.equal(result.kind, "batch");
	if (result.kind !== "batch") return;
	assert.deepEqual(result.batch.ids, ["a"]);
	assert.deepEqual(result.batch.deferred, [{ id: "b", why: "session-taken" }]);

	const next = nextBatch(p, present(["C:/proj/a.md"]), { candidates: [candidate] });
	assert.equal(next.kind, "batch");
	if (next.kind !== "batch") return;
	assert.deepEqual(next.batch.ids, ["b"]);
});

test("nextBatch: deterministic — the same plan and fs yield a deep-equal batch", () => {
	const p = plan([
		node("a", ["C:/proj/a.md"], { width: 3 }),
		node("b", ["C:/proj/b.md"], { width: 3 }),
	]);
	const first = nextBatch(p, allAbsent);
	const second = nextBatch(p, allAbsent);
	assert.deepEqual(first, second);
});

test("nextBatch: snapshot is a projection of the pre-batch root scan", () => {
	const root = join(dir, "snapshot-root");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "a.md"), "v1");
	const p = plan([node("a", [`${normalizePath(root)}/a.md`], { width: 2 })], normalizePath(root));
	const result = nextBatch(p, allAbsent);
	assert.equal(result.kind, "batch");
	if (result.kind !== "batch") return;
	assert.equal(result.batch.snapshot.length, 1);
	assert.equal(result.batch.snapshot[0].exists, true);
	assert.notEqual(result.batch.snapshot[0].hash, null);
	assert.equal(result.batch.rootScan.count, 1);
});

// ── verdict ─────────────────────────────────────────────────────────────────

test("verifyBatch: accepted, unchanged, missing from the two scans", () => {
	const root = join(dir, "verdict");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "own.md"), "v1");
	writeFileSync(join(root, "stale.md"), "v1");
	const r = normalizePath(root);
	const p = plan(
		[
			node("writer", [`${r}/own.md`], { width: 2 }),
			node("stale", [`${r}/stale.md`], { width: 2 }),
			node("ghost", [`${r}/never.md`], { width: 2 }),
		],
		r
	);
	const before = scanRoot(root);
	writeFileSync(join(root, "own.md"), "v2");
	const after = scanRoot(root);
	const verdict = verifyBatch({ ids: ["writer", "stale", "ghost"] }, before, after, p, { cwd: root });
	assert.deepEqual(verdict.accepted, ["writer"]);
	assert.deepEqual(verdict.unchanged, ["stale"]);
	assert.deepEqual(verdict.missing, ["ghost"]);
	assert.equal(verdict.strayCheck, "ok");
	assert.equal(verdict.intrusion, false);
});

test("verifyBatch: other-declared is an intrusion, undeclared is garbage", () => {
	const root = join(dir, "intrusion");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "own.md"), "v1");
	writeFileSync(join(root, "other.md"), "v1");
	const r = normalizePath(root);
	const p = plan(
		[
			node("writer", [`${r}/own.md`], { width: 2 }),
			node("neighbour", [`${r}/other.md`], { width: 2 }),
		],
		r
	);
	const before = scanRoot(root);
	writeFileSync(join(root, "own.md"), "v2");
	writeFileSync(join(root, "other.md"), "v2");
	writeFileSync(join(root, "temp.txt"), "tmp");
	const after = scanRoot(root);
	const verdict = verifyBatch({ ids: ["writer"] }, before, after, p, { cwd: root });

	assert.deepEqual(verdict.accepted, ["writer"]);
	assert.equal(verdict.intrusion, true);
	assert.deepEqual(
		verdict.stray.map((c) => `${c.kind}:${c.path.split("/").pop()}`),
		["other-declared:other.md", "undeclared:temp.txt"]
	);
});

test("verifyBatch: a truncated scan degrades to strayCheck skipped, never fails", () => {
	const root = join(dir, "bounded");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "a.md"), "a");
	const before = scanRoot(root, { maxFiles: 0 });
	const after = scanRoot(root, { maxFiles: 0 });
	const p = plan([node("a", [`${normalizePath(root)}/a.md`])], normalizePath(root));
	const verdict = verifyBatch({ ids: ["a"] }, before, after, p);
	assert.equal(verdict.strayCheck, "skipped");
	assert.deepEqual(verdict.stray, []);
	assert.equal(verdict.intrusion, false);
});

// ── retry state ─────────────────────────────────────────────────────────────

test("attempts: a counter at maxAttempts yields node-failed; an accepted verdict clears it", () => {
	const file = attemptsPath(dir, "retry-plan");
	const p = plan([node("a", ["C:/proj/a.md"])]);

	bumpAttempts(file, "a");
	assert.deepEqual(readAttempts(file), { a: 1 });
	assert.equal(nextBatch(p, allAbsent, { attempts: readAttempts(file), maxAttempts: 3 }).kind, "batch");

	bumpAttempts(file, "a");
	bumpAttempts(file, "a");
	const failed = nextBatch(p, allAbsent, { attempts: readAttempts(file), maxAttempts: 3 });
	assert.equal(failed.kind, "node-failed");
	if (failed.kind === "node-failed") {
		assert.equal(failed.node, "a");
		assert.equal(failed.attempts, 3);
	}

	clearAttempts(file, ["a"]);
	assert.deepEqual(readAttempts(file), {});
	assert.equal(nextBatch(p, allAbsent, { attempts: readAttempts(file), maxAttempts: 3 }).kind, "batch");
});

test("attempts: a corrupt file reads as empty rather than throwing", () => {
	const file = join(dir, "corrupt.attempts.json");
	writeFileSync(file, "{not json");
	assert.deepEqual(readAttempts(file), {});
});

// ── serial reference and the real plan ──────────────────────────────────────

test("nextBatch on a width-1 plan matches nextStep's node", () => {
	const p = plan([node("a", ["C:/proj/a.md"]), node("b", ["C:/proj/b.md"], { dependsOn: ["a"] })]);
	const pooled = nextBatch(p, allAbsent);
	const serial = nextStep(p, allAbsent);
	assert.equal(pooled.kind, "batch");
	assert.equal(serial.kind, "next");
	if (pooled.kind === "batch" && serial.kind === "next") {
		assert.deepEqual(pooled.batch.ids, [serial.node.id]);
	}
});

test("nextBatch: batches on the real Round8 plan are write-disjoint", () => {
	const planPath = "C:/Users/HOME/Desktop/Agentic-Engineering/.pi/orchestration-graph/plans/round8-principles.md";
	if (!existsSync(planPath)) return;
	const linted = lintPlan(readFileSync(planPath, "utf-8"), { cwd: "C:/Users/HOME/Desktop/Agentic-Engineering" });
	assert.equal(linted.ok, true);
	if (!linted.ok) return;

	let fs = allAbsent;
	const seen = [];
	for (let step = 0; step < 20; step++) {
		const result = nextBatch(linted.plan, fs, { attempts: {} });
		if (result.kind !== "batch") break;
		assert.equal(writeCollisions(linted.plan, result.batch.ids).length, 0);
		seen.push(...result.batch.ids.map((id) => linted.plan.nodes.find((n) => n.id === id)));
		// Pretend the batch wrote its outputs so the next call advances.
		const paths = seen.flatMap((n) => n.writes);
		fs = present(paths);
		clock++;
	}
	assert.ok(seen.length > 0);
});

// ── spec-12: settle warnings ────────────────────────────────────────────────

test("settleWarnings: accepted node that make-semantics derives undone is flagged (spec-12)", () => {
	// P2-9 shape: node accepted by the batch verdict, but its write list carries a
	// phantom file that was never created — deriveDone says not done.
	const p = plan([node("n1", ["C:/proj/n1.ts", "C:/proj/n1.test.ts"])]);
	const fs = present(["C:/proj/n1.ts"]); // n1.test.ts absent
	const warnings = settleWarnings(p, fs, ["n1"]);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].id, "n1");
	assert.deepEqual(warnings[0].missing, ["C:/proj/n1.test.ts"]);
	assert.deepEqual(warnings[0].stale, []);
});

test("settleWarnings: clean accepted node and non-accepted nodes produce no warning (spec-12)", () => {
	const p = plan([node("n1", ["C:/proj/n1.ts"]), node("n2", ["C:/proj/n2.ts"])]);
	const fs = present(["C:/proj/n1.ts"]);
	assert.deepEqual(settleWarnings(p, fs, ["n1"]), []);
	// n2 was never accepted — even though it is undone, no warning
	assert.deepEqual(settleWarnings(p, fs, []), []);
});
