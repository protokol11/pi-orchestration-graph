// Run: node --test test/isolation.test.mjs
// Writer isolation: lint codes, repo preflight, patch classification and the
// one seam (spec-10). Rows without a fixture repo use injected detectors and
// fake git runners; the apply rows use a real temporary git repository and are
// skipped where git is unavailable.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deriveDone, fsProbe } from "../core/dispatcher.ts";
import {
	applyPatch,
	checkRepoClean,
	classifyPatch,
	findRepoRoot,
	isolationLint,
	parsePatchPaths,
	spawnGit,
} from "../core/isolation.ts";
import { lintPlan } from "../core/plan.ts";
import { nextBatch } from "../core/pool.ts";

const fence = (graph) => `\`\`\`og-plan\n${JSON.stringify(graph, null, 2)}\n\`\`\``;
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0;

const dir = mkdtempSync(join(tmpdir(), "og-isolation-"));
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

function git(repo, args, input) {
	const run = spawnGit(args, { cwd: repo, input });
	if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr || run.stdout}`);
	return run;
}

/** A committed repository with one file; returns the repo path. */
function gitRepo(name) {
	const repo = fixture(name);
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["-c", "user.email=og@test", "-c", "user.name=og", "commit", "-q", "--allow-empty", "-m", "init"]);
	return repo;
}

// ── lint: the three spec-10 codes (injected repo detector, no fs) ────────────

const REPO = "C:/proj/repo";
const repoRootOf = (path) => (path.startsWith(REPO) ? REPO : null);

test("lintPlan: bad isolation value is refused", () => {
	const result = lintPlan(
		fence({
			version: 1,
			writeRoot: REPO,
			nodes: [{ id: "a", role: "r", task: "t", writes: [`${REPO}/src/a.ts`], dependsOn: [], isolation: "branch" }],
		}),
		{ repoRootOf }
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some((e) => e.code === "bad-isolation" && e.node === "a"));
});

test("lintPlan: isolation with a repo-external write is refused", () => {
	const result = lintPlan(
		fence({
			version: 1,
			writeRoot: "C:/proj",
			nodes: [{ id: "a", role: "r", task: "t", writes: ["C:/proj/out/a.md"], dependsOn: [], isolation: "worktree" }],
		}),
		{ repoRootOf }
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some((e) => e.code === "isolation-outside-repo" && e.node === "a"));
});

test("lintPlan: isolation mixing repo-internal and external writes is refused", () => {
	const result = lintPlan(
		fence({
			version: 1,
			writeRoot: "C:/proj",
			nodes: [{ id: "a", role: "r", task: "t", writes: [`${REPO}/src/a.ts`, "C:/proj/out/a.md"], dependsOn: [], isolation: "worktree" }],
		}),
		{ repoRootOf }
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.errors.some((e) => e.code === "isolation-mixed-writes" && e.node === "a"));
});

test("lintPlan: worktree isolation inside a repository passes and survives parsing", () => {
	const result = lintPlan(
		fence({
			version: 1,
			writeRoot: REPO,
			nodes: [{ id: "a", role: "r", task: "t", writes: [`${REPO}/src/a.ts`], dependsOn: [], isolation: "worktree" }],
		}),
		{ repoRootOf }
	);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.plan.nodes[0].isolation, "worktree");
});

test("lintPlan: no isolation field means no isolation codes (default none)", () => {
	const result = lintPlan(
		fence({
			version: 1,
			writeRoot: "C:/proj",
			nodes: [{ id: "a", role: "r", task: "t", writes: ["C:/proj/out/a.md"], dependsOn: [] }],
		}),
		{ repoRootOf }
	);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.plan.nodes[0].isolation, undefined);
});

// ── findRepoRoot: walk-up without git ─────────────────────────────────────────

test("findRepoRoot: walks up from a file path to the .git directory", () => {
	const repo = fixture("walk");
	mkdirSync(join(repo, ".git"));
	const nested = join(repo, "src", "deep");
	mkdirSync(nested, { recursive: true });
	assert.equal(findRepoRoot(join(nested, "a.ts")), repo.replace(/\\/g, "/"));
	assert.equal(findRepoRoot(join(dir, "nowhere")), null);
});

// ── checkRepoClean: fake git rows ─────────────────────────────────────────────

test("checkRepoClean: dirty paths are listed, .pi/subagents/ is ignored", () => {
	const calls = [];
	const fake = (args) => {
		calls.push(args);
		return {
			code: 0,
			stdout: [" M src/a.ts", "?? notes.md", "?? .pi/subagents/x/state.json"].join("\n"),
			stderr: "",
		};
	};
	const status = checkRepoClean("C:/proj/repo", { git: fake });
	assert.deepEqual(status.dirty, ["src/a.ts", "notes.md"]);
	assert.equal(status.clean, false);
});

test("checkRepoClean: a failed git status refuses honestly", () => {
	const status = checkRepoClean("C:/proj/repo", { git: (() => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" })) });
	assert.equal(status.clean, false);
	assert.ok(status.dirty[0].startsWith("git-status-failed"));
});

// ── classifyPatch: the three buckets, rename included ─────────────────────────

function planFor(root) {
	return {
		version: 1,
		writeRoot: root,
		nodes: [
			{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/src/core.ts`], dependsOn: [], width: 1, isolation: "worktree" },
			{ id: "neighbour", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/tests/other.test.ts`], dependsOn: [], width: 1 },
		],
	};
}

test("classifyPatch: own / other-declared / undeclared, rename lands as the new path", () => {
	const plan = planFor("C:/proj/repo");
	const classes = classifyPatch(
		{ files: ["src/core.ts", "tests/other.test.ts", "scratch/notes.md", "src/renamed.ts"] },
		plan,
		"writer",
		"C:/proj/repo"
	);
	const byKind = new Map(classes.map((c) => [c.path, c.kind]));
	assert.equal(byKind.get("src/core.ts"), "own");
	assert.equal(byKind.get("tests/other.test.ts"), "other-declared");
	assert.equal(byKind.get("scratch/notes.md"), "undeclared");
	assert.equal(byKind.get("src/renamed.ts"), "undeclared");
});

test("classifyPatch: unknown node throws", () => {
	assert.throws(() => classifyPatch({ files: ["a"] }, planFor("C:/proj/repo"), "ghost"), /unknown node/);
});

// ── parsePatchPaths: git diff headers ─────────────────────────────────────────

test("parsePatchPaths: b-side per file entry, rename to wins", () => {
	const patch = [
		"diff --git a/src/core.ts b/src/core.ts",
		"index 111..222 100644",
		"--- a/src/core.ts",
		"+++ b/src/core.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
		"diff --git a/src/old.ts b/src/new.ts",
		"similarity index 90%",
		"rename from src/old.ts",
		"rename to src/renamed.ts",
	].join("\n");
	assert.deepEqual(parsePatchPaths(patch), ["src/core.ts", "src/renamed.ts"]);
});

// ── nextBatch: the one-unisolated-repo-writer rule and the repo-dirty refusal ─

function repoFixturePlan(root, nodes) {
	return {
		version: 1,
		writeRoot: root,
		nodes: nodes.map((node) => ({ requires: [], reads: [], dependsOn: [], width: 2, ...node })),
	};
}

const emptyFs = { exists: () => false, mtime: () => undefined };

test("nextBatch: two unisolated repo writers → repo-write-conflict before dispatch", () => {
	const repo = fixture("pack-repo");
	mkdirSync(join(repo, ".git"));
	const root = repo.replace(/\\/g, "/");
	const plan = repoFixturePlan(root, [
		{ id: "w1", role: "r", task: "t", writes: [`${root}/a.ts`] },
		{ id: "w2", role: "r", task: "t", writes: [`${root}/b.ts`] },
	]);
	const result = nextBatch(plan, emptyFs, { cwd: dir });
	assert.equal(result.kind, "batch");
	if (result.kind === "batch") {
		assert.deepEqual(result.batch.ids, ["w1"]);
		assert.deepEqual(result.batch.deferred, [{ id: "w2", why: "repo-write-conflict" }]);
		assert.equal(result.refused, undefined);
	}
});

test("nextBatch: one isolated + one unisolated repo writer is allowed when clean", () => {
	const repo = fixture("pack-repo-mixed");
	mkdirSync(join(repo, ".git"));
	const root = repo.replace(/\\/g, "/");
	const plan = repoFixturePlan(root, [
		{ id: "iso", role: "r", task: "t", writes: [`${root}/a.ts`], isolation: "worktree" },
		{ id: "plain", role: "r", task: "t", writes: [`${root}/b.ts`] },
	]);
	const result = nextBatch(plan, emptyFs, { cwd: dir, checkRepo: () => ({ clean: true, dirty: [] }) });
	assert.equal(result.kind, "batch");
	if (result.kind === "batch") {
		assert.deepEqual(result.batch.ids, ["iso", "plain"]);
		assert.equal(result.refused, undefined);
	}
});

test("nextBatch: an isolated node in a dirty repository refuses the batch with the paths", () => {
	const repo = fixture("pack-repo-dirty");
	mkdirSync(join(repo, ".git"));
	const root = repo.replace(/\\/g, "/");
	const plan = repoFixturePlan(root, [
		{ id: "iso", role: "r", task: "t", writes: [`${root}/a.ts`], isolation: "worktree" },
	]);
	const result = nextBatch(plan, emptyFs, {
		cwd: dir,
		checkRepo: () => ({ clean: false, dirty: ["src/a.ts"] }),
	});
	assert.equal(result.kind, "batch");
	if (result.kind === "batch") {
		assert.deepEqual(result.refused, { reason: "repo-dirty", dirty: ["src/a.ts"] });
	}
});

// ── applyPatch: real git fixture — the seam ───────────────────────────────────

function repoWithCommit(name, files) {
	const repo = gitRepo(name);
	for (const [path, body] of Object.entries(files)) write(join(repo, path), body);
	git(repo, ["add", "-A"]);
	git(repo, ["-c", "user.email=og@test", "-c", "user.name=og", "commit", "-q", "-m", "seed"]);
	return repo;
}

function childPatch(repo, branch, mutate) {
	const wt = fixture(`${branch.replace(/\//g, "-")}-wt`);
	git(repo, ["worktree", "add", "-q", wt, "-b", branch]);
	try {
		mutate(wt);
		git(wt, ["add", "-A"]);
		return git(wt, ["diff", "--cached", "HEAD"]).stdout;
	} finally {
		git(repo, ["worktree", "remove", "--force", wt]);
		git(repo, ["branch", "-D", branch]);
	}
}

test("applyPatch: own + undeclared land at the seam, deriveDone sees the node done", () => {
	if (!gitAvailable) return;
	const repo = repoWithCommit("apply-ok", { "src/core.ts": "export const a = 1;\n" });
	const root = repo.replace(/\\/g, "/");
	const plan = {
		version: 1,
		writeRoot: root,
		nodes: [
			{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/src/core.ts`], dependsOn: [], width: 1, isolation: "worktree" },
		],
	};
	const patch = childPatch(repo, "og/writer", (wt) => {
		write(join(wt, "src", "core.ts"), "export const a = 2;\n");
		write(join(wt, "scratch", "notes.md"), "temp\n");
	});
	const files = parsePatchPaths(patch);
	const verdict = applyPatch({ patch, files }, repo, plan, "writer", { cwd: root });
	assert.equal(verdict.ok, true);
	if (verdict.ok) {
		assert.deepEqual(verdict.applied.map((c) => `${c.kind}:${c.path}`).sort(), ["own:src/core.ts", "undeclared:scratch/notes.md"]);
	}
	assert.equal(readFileSync(join(repo, "src", "core.ts"), "utf-8").replace(/\r\n/g, "\n"), "export const a = 2;\n");
	assert.equal(readFileSync(join(repo, "scratch", "notes.md"), "utf-8").replace(/\r\n/g, "\n"), "temp\n");
	const state = deriveDone(plan, fsProbe(root));
	assert.deepEqual(state.done, ["writer"]);
});

test("applyPatch: one other-declared path applies nothing; git status is unchanged", () => {
	if (!gitAvailable) return;
	const repo = repoWithCommit("apply-intrusion", {
		"src/core.ts": "export const a = 1;\n",
		"tests/other.test.ts": "test('x');\n",
	});
	const root = repo.replace(/\\/g, "/");
	const plan = {
		version: 1,
		writeRoot: root,
		nodes: [
			{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/src/core.ts`], dependsOn: [], width: 1, isolation: "worktree" },
			{ id: "neighbour", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/tests/other.test.ts`], dependsOn: [], width: 1 },
		],
	};
	const patch = childPatch(repo, "og/intruder", (wt) => {
		write(join(wt, "src", "core.ts"), "export const a = 2;\n");
		write(join(wt, "tests", "other.test.ts"), "test('y');\n");
	});
	const files = parsePatchPaths(patch);
	const verdict = applyPatch({ patch, files }, repo, plan, "writer", { cwd: root });
	assert.equal(verdict.ok, false);
	if (!verdict.ok) {
		assert.equal(verdict.reason, "other-declared");
		assert.deepEqual(verdict.refused.map((c) => c.path), ["tests/other.test.ts"]);
	}
	assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "");
	assert.equal(readFileSync(join(repo, "src", "core.ts"), "utf-8"), "export const a = 1;\n");
});

test("applyPatch: a stale patch is patch-conflict and the node stays undone", () => {
	if (!gitAvailable) return;
	const repo = repoWithCommit("apply-conflict", { "src/core.ts": "export const a = 1;\n" });
	const root = repo.replace(/\\/g, "/");
	const plan = {
		version: 1,
		writeRoot: root,
		nodes: [
			{ id: "writer", role: "r", task: "t", requires: [], reads: [], writes: [`${root}/src/core.ts`], dependsOn: [], width: 1, isolation: "worktree" },
		],
	};
	const patch = childPatch(repo, "og/conflict", (wt) => {
		write(join(wt, "src", "core.ts"), "export const a = 2;\n");
	});
	// The main tree moves between capture and apply.
	write(join(repo, "src", "core.ts"), "export const a = 999;\n");
	const files = parsePatchPaths(patch);
	const verdict = applyPatch({ patch, files }, repo, plan, "writer", { cwd: root });
	assert.equal(verdict.ok, false);
	if (!verdict.ok) assert.equal(verdict.reason, "patch-conflict");
	// The main tree keeps the newer edit; make semantics see a fresh write, so
	// the run log's patch-conflict record — not deriveDone — is what marks the
	// node undone for the conductor (spec-10 decision 6 keeps `done` on disk).
	assert.equal(readFileSync(join(repo, "src", "core.ts"), "utf-8").replace(/\r\n/g, "\n"), "export const a = 999;\n");
});

test("isolationLint: non-string isolation is left to lintNode's bad-shape", () => {
	const errors = isolationLint({ id: "a", isolation: 42, writes: ["x"] }, "C:/proj", () => null);
	assert.deepEqual(errors, []);
});
