// Run: node --test test/root.test.mjs
// Write root: lint containment, bounded scan, change classification (spec-9).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePath } from "../core/contract.ts";
import { lintPlan } from "../core/plan.ts";
import { classifyChange, diffScan, scanRoot } from "../core/root.ts";

const fence = (graph) => `\`\`\`og-plan\n${JSON.stringify(graph, null, 2)}\n\`\`\``;
const planText = (writeRoot, writes, extra = {}) => {
	const graph = { version: 1, nodes: [{ id: "a", role: "r", task: "t", writes }] };
	if (writeRoot !== undefined) graph.writeRoot = writeRoot;
	return fence({ ...graph, ...extra });
};

const dir = mkdtempSync(join(tmpdir(), "og-root-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name) {
	const path = join(dir, name);
	mkdirSync(path, { recursive: true });
	return path;
}

function write(path, body) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
}

// ── lint: writeRoot is mandatory, absolute, and contains every write ─────────

test("lintPlan: a plan without writeRoot is refused with no-write-root", () => {
	const result = lintPlan(planText(undefined, ["C:/proj/out/a.md"]));
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some((e) => e.code === "no-write-root"));
});

test("lintPlan: a write outside the root is refused, segment boundary included", () => {
	const outside = lintPlan(planText("C:/proj/out", ["C:/proj/elsewhere/a.md"]));
	assert.equal(outside.ok, false);
	if (!outside.ok) {
		assert.ok(outside.errors.some((e) => e.code === "write-outside-root" && e.node === "a" && e.detail === "C:/proj/elsewhere/a.md"));
	}

	// `C:/proj/outbc` is a sibling, not a child, of `C:/proj/out`.
	const boundary = lintPlan(planText("C:/proj/out", ["C:/proj/outbc/a.md"]));
	assert.equal(boundary.ok, false);
	if (!boundary.ok) assert.ok(boundary.errors.some((e) => e.code === "write-outside-root"));

	const inside = lintPlan(planText("C:/proj/out", ["C:/proj/out/sub/a.md"]));
	assert.equal(inside.ok, true);
});

test("lintPlan: a relative or dot-segment root is refused by the normalisation rule", () => {
	const relative = lintPlan(planText("./out", ["./out/a.md"]));
	assert.equal(relative.ok, false);
	if (!relative.ok) assert.ok(relative.errors.some((e) => e.code === "unnormalized-path" && e.detail === "./out"));

	const dot = lintPlan(planText("C:/proj/out/../out", ["C:/proj/out/a.md"]));
	assert.equal(dot.ok, false);
	if (!dot.ok) assert.ok(dot.errors.some((e) => e.code === "unnormalized-path"));
});

test("lintPlan: relative writes resolve from cwd before containment", () => {
	const inside = lintPlan(planText("C:/proj/out", ["out/a.md"]), { cwd: "C:/proj" });
	assert.equal(inside.ok, true);

	const outside = lintPlan(planText("C:/proj/out", ["out/a.md"]), { cwd: "C:/other" });
	assert.equal(outside.ok, false);
	if (!outside.ok) assert.ok(outside.errors.some((e) => e.code === "write-outside-root" && e.detail === "out/a.md"));
});

// ── scan: bounded, deterministic, symlinks recorded and not followed ─────────

test("scanRoot: counts files, ignores .git/, node_modules/, and the pool's own state", () => {
	const root = fixture("count");
	write(join(root, "a.md"), "a");
	write(join(root, "sub", "b.md"), "bb");
	write(join(root, ".git", "config"), "git");
	write(join(root, "node_modules", "x", "index.js"), "js");
	write(join(root, ".pi", "orchestration-graph", "runs", "x.batch.json"), "{}");
	// State of a *different* tool under .pi/ is not infrastructure: it scans.
	write(join(root, ".pi", "other-tool", "state.json"), "{}");

	const scan = scanRoot(root);
	assert.equal(scan.count, 3);
	assert.equal(scan.truncated, false);
	assert.deepEqual(
		[...scan.files.keys()].sort(),
		[
			`${normalizePath(root)}/.pi/other-tool/state.json`,
			`${normalizePath(root)}/a.md`,
			`${normalizePath(root)}/sub/b.md`,
		].sort()
	);
});

test("scanRoot: absent root is an empty scan, not an error", () => {
	const scan = scanRoot(join(dir, "missing"));
	assert.equal(scan.count, 0);
	assert.equal(scan.truncated, false);
	assert.equal(scan.files.size, 0);
});

test("scanRoot: the bound truncates instead of throwing", () => {
	const root = fixture("bound");
	for (let i = 0; i < 5; i++) write(join(root, `f${i}.md`), "x");
	const scan = scanRoot(root, { maxFiles: 2 });
	assert.equal(scan.truncated, true);
	assert.ok(scan.count <= 2);
});

test("scanRoot: a symlink is recorded with hash null and its target is not walked", () => {
	const root = fixture("links");
	const outside = fixture("links-target");
	write(join(outside, "secret.md"), "secret");
	write(join(root, "own.md"), "own");
	let linked = false;
	try {
		symlinkSync(outside, join(root, "link"), "junction");
		linked = true;
	} catch {
		// Windows without the privilege: the rule is still exercised by the fixture below.
	}

	const scan = scanRoot(root);
	assert.ok(scan.files.has(`${normalizePath(root)}/own.md`));
	if (linked) {
		assert.deepEqual(scan.files.get(`${normalizePath(root)}/link`), { hash: null, size: 0 });
		assert.equal(scan.files.has(`${normalizePath(root)}/link/secret.md`), false);
	}
});

// ── classification: own / other-declared / undeclared, deletions included ────

function planFor(root) {
	const r = normalizePath(root);
	return {
		version: 1,
		writeRoot: r,
		nodes: [
			{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: [`${r}/out/own.md`], dependsOn: [], width: 1 },
			{ id: "neighbour", role: "r", task: "t", requires: [], reads: [], writes: [`${r}/out/other.md`], dependsOn: [], width: 1 },
		],
	};
}

test("diffScan: three buckets, added/modified/deleted", () => {
	const root = fixture("classify");
	const out = join(root, "out");
	write(join(out, "own.md"), "v1");
	write(join(out, "other.md"), "v1");
	write(join(out, "gone.txt"), "v1");
	const plan = planFor(root);
	const before = scanRoot(root);

	write(join(out, "own.md"), "v2");
	write(join(out, "other.md"), "v2");
	write(join(out, "new-temp.txt"), "tmp");
	rmSync(join(out, "gone.txt"));

	const after = scanRoot(root);
	const changes = diffScan(before, after, plan, ["writer"]);
	const byName = new Map(changes.map((c) => [c.path.split("/").pop(), `${c.kind}:${c.change}`]));

	assert.equal(byName.get("own.md"), "own:modified");
	assert.equal(byName.get("other.md"), "other-declared:modified");
	assert.equal(byName.get("new-temp.txt"), "undeclared:added");
	assert.equal(byName.get("gone.txt"), "undeclared:deleted");
	assert.deepEqual(changes.map((c) => c.path), [...changes.map((c) => c.path)].sort());
});

test("diffScan: an unchanged file is not a change", () => {
	const root = fixture("stable");
	write(join(root, "out", "own.md"), "same");
	const plan = planFor(root);
	const before = scanRoot(root);
	const after = scanRoot(root);
	assert.deepEqual(diffScan(before, after, plan, ["writer"]), []);
});

test("classifyChange: batch membership decides own vs other-declared", () => {
	const root = fixture("membership");
	const plan = planFor(root);
	const ownPath = `${normalizePath(root)}/out/own.md`;
	const otherPath = `${normalizePath(root)}/out/other.md`;

	assert.equal(classifyChange(ownPath, plan, ["writer"]), "own");
	assert.equal(classifyChange(ownPath, plan, ["neighbour"]), "other-declared");
	assert.equal(classifyChange(otherPath, plan, ["writer"]), "other-declared");
	assert.equal(classifyChange(`${normalizePath(root)}/loose.md`, plan, ["writer"]), "undeclared");
});

test("classifyChange: relative plan writes resolve from cwd", () => {
	const plan = {
		version: 1,
		writeRoot: "C:/proj",
		nodes: [{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: ["out/a.md"], dependsOn: [], width: 1 }],
	};
	assert.equal(classifyChange("C:/proj/out/a.md", plan, ["writer"], "C:/proj"), "own");
});
