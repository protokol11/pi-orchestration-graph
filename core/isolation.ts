// writer isolation — a worktree per repo-writing node, a patch applied at one
// seam (spec-10).
//
// The pool does not create isolation; `pi-subagents` owns the worktree
// lifecycle. This module decides the three things the pool must decide:
// whether the repository may be used at all (`checkRepoClean`), what a
// captured patch is allowed to touch (`classifyPatch`), and where it may land
// (`applyPatch`). Children never write the main tree; the seam is
// single-writer by construction.
//
// Refusal is structural, never advisory: a dirty repository, a second
// unisolated repo writer, or an `other-declared` patch path all stop the work
// before anything is applied. Isolation is never dropped automatically.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isInsideRoot, normalizePath, resolvePlanPath } from "./contract.ts";
import type { Plan } from "./plan.ts";
import type { ChangeKind } from "./root.ts";

export type GitRun = { code: number; stdout: string; stderr: string };
export type GitRunner = (args: string[], options: { cwd: string; input?: string }) => GitRun;

export function spawnGit(args: string[], options: { cwd: string; input?: string }): GitRun {
	const run = spawnSync("git", args, {
		cwd: options.cwd,
		input: options.input,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * Walk up from `startPath` (a file or a directory — both work, a non-directory
 * simply fails its `.git` probe) to the nearest directory containing `.git`.
 * `null` outside any repository. Pure fs existence checks, no git call.
 */
export function findRepoRoot(
	startPath: string,
	exists: (path: string) => boolean = existsSync
): string | null {
	let dir = normalizePath(startPath);
	for (;;) {
		if (exists(`${dir}/.git`)) return dir;
		const parent = normalizePath(`${dir}/..`);
		if (parent === dir || parent === "." || parent === "") return null;
		dir = parent;
	}
}

export type RepoStatus = { clean: boolean; dirty: string[] };

/**
 * `git status --porcelain` against the declared ignore list (default
 * `.pi/subagents/` — the runtime's own scratch, not the author's work). A
 * failed status (not a repository, git absent) reports the repository as
 * unclean with the stderr line: an isolation batch must refuse, never guess.
 */
export function checkRepoClean(repo: string, options: { ignore?: string[]; git?: GitRunner } = {}): RepoStatus {
	const git = options.git ?? spawnGit;
	const ignore = uniquePaths(options.ignore ?? [".pi/subagents"]);
	const run = git(["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
	if (run.code !== 0) {
		return { clean: false, dirty: [`git-status-failed: ${(run.stderr || run.stdout).trim()}`] };
	}

	const dirty: string[] = [];
	for (const line of run.stdout.split("\n")) {
		if (line.length < 4) continue;
		let rel = line.slice(3).trim();
		// Porcelain quotes paths with special characters: "…". Unquote for matching.
		if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
		const path = normalizePath(rel);
		if (path === "") continue;
		const absolute = resolvePlanPath(repo, path);
		if (ignore.some((root) => isInsideRoot(resolvePlanPath(repo, root), absolute))) continue;
		dirty.push(path);
	}
	return { clean: dirty.length === 0, dirty };
}

export type PatchClass = { path: string; kind: ChangeKind };

/**
 * Every path of a captured patch, bucketed by the same target rule as spec-9:
 * this node's `writes` (`own`), another node's `writes` (`other-declared`),
 * nobody's (`undeclared`). Manifest paths are repo-relative or absolute;
 * relative ones resolve against `repoBase` (the plan's cwd base).
 */
export function classifyPatch(manifest: { files: string[] }, plan: Plan, nodeId: string, repoBase: string = process.cwd()): PatchClass[] {
	const node = plan.nodes.find((candidate) => candidate.id === nodeId);
	if (!node) throw new Error(`classifyPatch: unknown node ${nodeId}`);

	const own = new Set(node.writes.map((write) => resolvePlanPath(repoBase, write)));
	const others = new Map<string, string>();
	for (const other of plan.nodes) {
		if (other.id === nodeId) continue;
		for (const write of other.writes) others.set(resolvePlanPath(repoBase, write), other.id);
	}

	return manifest.files.map((file) => {
		const absolute = resolvePlanPath(repoBase, file);
		if (own.has(absolute)) return { path: file, kind: "own" as const };
		if (others.has(absolute)) return { path: file, kind: "other-declared" as const };
		return { path: file, kind: "undeclared" as const };
	});
}

/** `git diff` header paths, one per file entry; the `b/` side wins, `rename to` overrides it. */
export function parsePatchPaths(patch: string): string[] {
	const paths: string[] = [];
	let current: string | null = null;
	for (const line of patch.split(/\r?\n/)) {
		const diff = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (diff) {
			if (current !== null) paths.push(current);
			current = diff[2];
			continue;
		}
		const renameTo = /^rename to (.+)$/.exec(line);
		if (renameTo && current !== null) current = renameTo[1];
	}
	if (current !== null) paths.push(current);
	return uniquePaths(paths);
}

export type ApplyResult =
	| { ok: true; applied: PatchClass[]; refused: PatchClass[] }
	| { ok: false; reason: "other-declared" | "patch-conflict"; applied: PatchClass[]; refused: PatchClass[]; detail?: string };

/**
 * Classify, then apply — all-or-nothing. One `other-declared` path refuses the
 * whole patch before git sees it (nothing applied). Otherwise `git apply` at
 * the seam: a failed apply is `patch-conflict`, the node stays undone, the
 * manifest keeps the patch. `own` and `undeclared` land together; the
 * undeclared ones are the reviewer's garbage list (spec-9).
 */
export function applyPatch(
	manifest: { patch: string; files: string[] },
	repo: string,
	plan: Plan,
	nodeId: string,
	options: { git?: GitRunner; cwd?: string } = {}
): ApplyResult {
	const cwd = options.cwd ?? process.cwd();
	const git = options.git ?? spawnGit;
	const classes = classifyPatch(manifest, plan, nodeId, cwd);
	const refused = classes.filter((entry) => entry.kind === "other-declared");
	if (refused.length > 0) return { ok: false, reason: "other-declared", applied: [], refused };

	// Best-effort index refresh so apply judges content state, not a stale cache.
	git(["update-index", "-q", "--refresh"], { cwd: repo });
	const run = git(["apply", "--whitespace=nowarn", "-"], { cwd: repo, input: manifest.patch });
	if (run.code !== 0) {
		return {
			ok: false,
			reason: "patch-conflict",
			applied: [],
			refused: [],
			detail: (run.stderr || run.stdout).trim(),
		};
	}
	return { ok: true, applied: classes, refused: [] };
}

/** The three spec-10 lint codes, shared by lintPlan and its test rows. */
export function isolationLint(
	node: { id: string; isolation?: unknown; writes?: unknown },
	cwd: string,
	repoRootOf: (path: string) => string | null
): Array<{ code: string; detail?: string }> {
	const errors: Array<{ code: string; detail?: string }> = [];
	const isolation = node.isolation;
	if (typeof isolation !== "string") return errors; // non-strings are lintNode's bad-shape
	if (isolation !== "none" && isolation !== "worktree") {
		errors.push({ code: "bad-isolation", detail: String(isolation) });
		return errors;
	}
	if (isolation !== "worktree" || !Array.isArray(node.writes)) return errors;

	const states = (node.writes as string[]).map((write) => ({
		write,
		root: repoRootOf(resolvePlanPath(cwd, write)),
	}));
	const inside = states.filter((state) => state.root !== null);
	const outside = states.filter((state) => state.root === null);
	if (inside.length > 0 && outside.length > 0) {
		errors.push({ code: "isolation-mixed-writes", detail: outside[0].write });
	} else if (outside.length > 0) {
		errors.push({ code: "isolation-outside-repo", detail: outside[0].write });
	}
	return errors;
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const normalized = normalizePath(path);
		if (normalized === "" || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}
