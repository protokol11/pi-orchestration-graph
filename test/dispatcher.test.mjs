// Run: node --test test/dispatcher.test.mjs
// Dispatcher core (spec-7): derived done state, the step function, the post-task
// map, the reads/preload split, and the serial/width record.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	appendRunLog,
	buildTaskText,
	deriveDone,
	disjointWriteSets,
	estimateTokens,
	mapFromNode,
	nextStep,
	renderLoadMap,
	runLogPath,
	writeCollisions,
} from "../core/dispatcher.ts";
import { checkLoadMap } from "../core/warm-load.ts";

function node(fields) {
	return {
		id: "a",
		role: "coder",
		task: "do a",
		requires: [],
		reads: [],
		writes: ["out/a.md"],
		dependsOn: [],
		width: 1,
		...fields,
	};
}

function plan(...nodes) {
	return { version: 1, nodes };
}

const root = mkdtempSync(join(tmpdir(), "og-dispatch-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

let project = 0;
function freshProject() {
	const dir = join(root, `p${project++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function touch(cwd, rel, mtimeMs) {
	const path = join(cwd, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "x");
	if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
	return path;
}

// --- deriveDone -----------------------------------------------------------

test("deriveDone: done = every write exists, order-free", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 1_000);
	const state = deriveDone(plan(node()), { exists: (p) => existsIn(cwd, p), mtime: (p) => mtimeIn(cwd, p) });
	assert.deepEqual(state.done, ["a"]);
	assert.deepEqual(state.missing, {});
});

test("deriveDone: one absent write leaves the node undone and names the path", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 1_000);
	const two = plan(node({ writes: ["out/a.md", "out/b.md"] }));
	const state = deriveDone(two, probe(cwd));
	assert.deepEqual(state.done, []);
	assert.deepEqual(state.missing.a, ["out/b.md"]);
});

test("deriveDone: a node whose dep is undone is not done, even with its outputs present", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 1_000);
	touch(cwd, "out/b.md", 2_000);
	const two = plan(node({ id: "a", writes: ["out/a.md"] }), node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] }));
	rmSync(join(cwd, "out/a.md"));
	const state = deriveDone(two, probe(cwd));
	assert.deepEqual(state.done, []);
	assert.deepEqual(state.blockedByDep, { b: ["a"] });
});

test("deriveDone: a write older than the newest dependency output is stale, not done", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 2_000);
	touch(cwd, "out/b.md", 1_000);
	const two = plan(node({ id: "a", writes: ["out/a.md"] }), node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] }));
	const state = deriveDone(two, probe(cwd));
	assert.deepEqual(state.done, ["a"]);
	assert.deepEqual(state.stale.b, ["out/b.md"]);
});

test("deriveDone: equal mtimes count as fresh (make semantics)", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 2_000);
	touch(cwd, "out/b.md", 2_000);
	const two = plan(node({ id: "a", writes: ["out/a.md"] }), node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] }));
	assert.deepEqual(deriveDone(two, probe(cwd)).done, ["a", "b"]);
});

test("deriveDone: pre-existing outputs mark a node done without it ever running", () => {
	const cwd = freshProject();
	touch(cwd, "out/a.md", 5_000);
	assert.deepEqual(deriveDone(plan(node()), probe(cwd)).done, ["a"]);
});

// --- nextStep -------------------------------------------------------------

test("nextStep: linear chain advances one node per step and finishes", () => {
	const cwd = freshProject();
	const p = plan(node({ id: "a", writes: ["out/a.md"] }), node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] }));

	const first = nextStep(p, probe(cwd));
	assert.equal(first.kind, "next");
	assert.equal(first.node.id, "a");
	assert.deepEqual(first.done, []);

	touch(cwd, "out/a.md", 1_000);
	const second = nextStep(p, probe(cwd));
	assert.equal(second.node.id, "b");
	assert.deepEqual(second.done, ["a"]);

	touch(cwd, "out/b.md", 2_000);
	assert.equal(nextStep(p, probe(cwd)).kind, "finished");
});

test("nextStep: never returns a node whose dependency is undone", () => {
	const cwd = freshProject();
	touch(cwd, "out/b.md", 5_000); // b's output exists, but a never ran
	const p = plan(node({ id: "a", writes: ["out/a.md"] }), node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] }));
	const step = nextStep(p, probe(cwd));
	assert.equal(step.node.id, "a");
});

test("nextStep: diamond preserves declaration order", () => {
	const cwd = freshProject();
	const p = plan(
		node({ id: "root", writes: ["out/r.md"] }),
		node({ id: "left", writes: ["out/l.md"], dependsOn: ["root"] }),
		node({ id: "right", writes: ["out/rr.md"], dependsOn: ["root"] })
	);
	touch(cwd, "out/r.md", 1_000);
	assert.equal(nextStep(p, probe(cwd)).node.id, "left");
	touch(cwd, "out/l.md", 2_000);
	assert.equal(nextStep(p, probe(cwd)).node.id, "right");
});

test("nextStep: a cycle is blocked, not a hang", () => {
	const cwd = freshProject();
	const p = plan(
		node({ id: "a", writes: ["out/a.md"], dependsOn: ["b"] }),
		node({ id: "b", writes: ["out/b.md"], dependsOn: ["a"] })
	);
	const step = nextStep(p, probe(cwd));
	assert.equal(step.kind, "blocked");
});

test("nextStep: empty pool is a cold start → spawn, not an error", () => {
	const cwd = freshProject();
	const step = nextStep(plan(node()), probe(cwd), { candidates: [] });
	assert.equal(step.kind, "next");
	assert.deepEqual(step.action, { kind: "spawn" });
});

test("nextStep: a ranked candidate becomes resume", () => {
	const cwd = freshProject();
	const step = nextStep(plan(node({ reads: ["doc/x.md"] })), probe(cwd), {
		candidates: [
			{ nodeId: "session-1", role: "coder", files: ["doc/x.md"], at: new Date().toISOString(), entriesAfterMarker: 3, compactedAfterMarker: false },
		],
		now: Date.now(),
	});
	assert.equal(step.action.kind, "resume");
	assert.equal(step.action.candidate, "session-1");
});

// --- requires / reads split (F1) ------------------------------------------

test("nextStep: truncation applies to requires only, reads survive whole", () => {
	const cwd = freshProject();
	touch(cwd, "big/read.md", 400_000); // ~100k tokens
	touch(cwd, "src/small.ts", 400);
	const p = plan(node({ requires: ["src/small.ts"], reads: ["big/read.md"], writes: ["out/a.md"] }));
	const step = nextStep(p, probe(cwd), { budgetTokens: 500, sizeOf: (path) => statIn(cwd, path) });
	assert.deepEqual(step.load.kept, ["src/small.ts"]);
	assert.deepEqual(step.load.dropped, []);
	assert.deepEqual(step.reads, ["big/read.md"]);
	assert.ok(step.readsTokens > 90_000);
	assert.equal(step.readWarn, true);
	assert.ok(buildTaskText(step.node).includes("big/read.md"));
});

test("nextStep: a reads list over the warn threshold is flagged, never dropped", () => {
	const cwd = freshProject();
	touch(cwd, "doc/a.md", 4_000);
	const step = nextStep(plan(node({ reads: ["doc/a.md"] })), probe(cwd), { readWarnTokens: 10 });
	assert.deepEqual(step.reads, ["doc/a.md"]);
	assert.equal(step.readWarn, true);
});

test("nextStep: width is reported, never used to reorder", () => {
	const cwd = freshProject();
	const p = plan(
		node({ id: "a", width: 4, writes: ["out/a.md"] }),
		node({ id: "b", width: 4, writes: ["out/b.md"] })
	);
	const step = nextStep(p, probe(cwd));
	assert.equal(step.node.id, "a");
	assert.equal(step.declaredWidth, 4);
});

// --- text, map, independence ---------------------------------------------

test("buildTaskText: reads listed in order after the task; empty reads adds nothing", () => {
	const text = buildTaskText(node({ task: "do it", reads: ["a.md", "b.md"] }));
	assert.ok(text.startsWith("do it"));
	assert.ok(text.indexOf("a.md") < text.indexOf("b.md"));
	assert.equal(buildTaskText(node({ task: "do it" })), "do it\n");
});

test("mapFromNode: normalized, deduplicated, sorted union of the three lists", () => {
	const files = mapFromNode(
		node({ requires: ["b.md", "a.md"], reads: ["a.md"], writes: ["c.md"] })
	);
	assert.deepEqual(files, ["a.md", "b.md", "c.md"]);
});

test("renderLoadMap satisfies the spec-4 map contract", () => {
	const cwd = freshProject();
	const mapPath = join(cwd, "load-map-coder-a.md");
	writeFileSync(
		mapPath,
		renderLoadMap({ role: "coder", node: "a", plan: "plans/demo.md", files: ["a.md"] }),
		"utf-8"
	);
	assert.deepEqual(checkLoadMap(mapPath), { ok: true });
});

test("disjointWriteSets / writeCollisions: shared writes cannot run together", () => {
	const a = node({ id: "a", writes: ["out/x.md"] });
	const b = node({ id: "b", writes: ["out/y.md"] });
	const c = node({ id: "c", writes: ["out/x.md"] });
	assert.equal(disjointWriteSets(a, b), true);
	assert.equal(disjointWriteSets(a, c), false);
	assert.deepEqual(writeCollisions(plan(a, b, c), ["a", "b", "c"]), [["a", "c"]]);
});

// --- telemetry ------------------------------------------------------------

test("runLog: one JSON line per step, and the log is not read back", () => {
	const cwd = freshProject();
	const file = runLogPath(cwd, "Demo Plan", "2026-10-18T12:34:56.000Z");
	assert.ok(/runs[\\/]demo-plan-20261018123456\.jsonl$/.test(file), file);

	for (let step = 1; step <= 3; step++) {
		appendRunLog(file, {
			step,
			node: `n${step}`,
			action: "spawn",
			kept: [],
			dropped: [],
			missing: [],
			readsTokens: 0,
			readWarn: false,
			declaredWidth: 1,
			writesVerified: false,
			at: "2026-10-18T12:34:56.000Z",
		});
	}
	const lines = readLines(file);
	assert.equal(lines.length, 3);
	for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

	// Deleting the log does not change the next step: state came from the files.
	touch(cwd, "out/a.md", 1_000);
	const before = nextStep(plan(node()), probe(cwd));
	rmSync(file);
	const after = nextStep(plan(node()), probe(cwd));
	assert.deepEqual(before, after);
});

test("estimateTokens: missing files are charged the pessimistic estimate", () => {
	assert.equal(estimateTokens(["ghost.md"], () => undefined), 256 + 64);
});

// --- helpers --------------------------------------------------------------

function probe(cwd) {
	return {
		exists: (p) => statIn(cwd, p) !== undefined,
		mtime: (p) => statIn(cwd, p),
	};
}

function existsIn(cwd, p) {
	return statIn(cwd, p) !== undefined;
}

function mtimeIn(cwd, p) {
	return statIn(cwd, p);
}

function statIn(cwd, p) {
	try {
		return statSync(join(cwd, p)).mtimeMs;
	} catch {
		return undefined;
	}
}

function readLines(file) {
	return readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
}
