// plan store — the typed graph the executor reads (spec-6).
//
// A plan is markdown + exactly one fenced `og-plan` JSON block: editable as a
// spec, parseable as data. Everything here is pure except the fs-touching
// tail (`ogDirs`/`ensureOgDirs` and the default `sizeOf`), so the lint and the
// truncation are testable without a project on disk.
//
// One owner rule: the extension creates `.pi/orchestration-graph/` lazily on
// first write; nothing creates it by hand.
import { isInsideRoot, normalizePath, resolvePlanPath, uniquePaths } from "./contract.ts";
import { findRepoRoot, isolationLint } from "./isolation.ts";

export const PLAN_BLOCK_FENCE = "og-plan";
export const PLAN_VERSION = 1;

export type PlanNode = {
	id: string;
	role: string;
	task: string;
	/** Preload material for the load turn. Budget-truncated by `fitPaths`. */
	requires: string[];
	/** Task material: listed in the task text, never truncated (spec-7). */
	reads: string[];
	/** Mandatory: the done predicate, the independence set, the declared outputs. */
	writes: string[];
	dependsOn: string[];
	/** Declared parallel width for independent branches; default 1. */
	width: number;
	/** Opt-in worktree isolation for repo-internal writes (spec-10); default "none". */
	isolation?: "none" | "worktree";
};

export type Plan = {
	version: number;
	/** Absolute boundary every `writes` path must sit inside (spec-9). */
	writeRoot: string;
	nodes: PlanNode[];
};

export type LintOptions = {
	/** Base for relative `writes` paths; defaults to the process cwd. */
	cwd?: string;
	/** Repository-root detector for the spec-10 isolation codes; defaults to fs walk-up. */
	repoRootOf?: (path: string) => string | null;
	/**
	 * spec-11 strict mode: promote `write-not-in-task` from warning to error.
	 * Default off — the pre-spec-11 plan corpus (mc-full-parity, Round8, og-selftest)
	 * names implementation files but not their test twins, so strict would fail
	 * every settled plan. New plans should be authored and linted strict.
	 */
	strict?: boolean;
};

export type LintError = { code: string; node?: string; detail?: string };

export type LintResult =
	| { ok: true; plan: Plan; warnings: LintError[] }
	| { ok: false; errors: LintError[]; warnings: LintError[] };

// Hard-rule heuristics (spec-11). Matching is textual by design: the plan is the
// authority and the lint must stay deterministic and cheap.
const FRAME_GATE_RE = /npm run live|screenshot/i;
const BUDGET_RE = /budget\s*:/i;
const FRAME_PRODUCER_RE = /render|screen|harness|demo|live|scene|game\.ts/i;

/** `src/mobs/combat.test.ts` -> `src/mobs/combat.ts`; non-test writes have no twin. */
function testTwinPath(write: string): string | null {
	return write.includes(".test.") ? write.replace(/\.test\./, ".") : null;
}

function taskCoversWrite(taskLower: string, write: string): boolean {
	const w = write.toLowerCase();
	if (taskLower.includes(w)) return true;
	const base = w.split("/").pop() ?? w;
	if (taskLower.includes(base)) return true;
	// Test twins are the one systematic omission of real task texts (measured on
	// mc-full-parity: 55/55 misses were twins of task-named implementation files).
	// The phantom case they can mask (P2-8 recipes.test.ts) is caught dynamically
	// by settle make-semantics (spec-12) — a text-only lint cannot separate a
	// phantom twin from a real one when the sibling is named.
	const twin = testTwinPath(w);
	if (twin !== null && (taskLower.includes(twin) || taskLower.includes(twin.split("/").pop() ?? twin))) return true;
	return false;
}

function lintHardRules(nodes: Array<Record<string, unknown>>, errors: LintError[], warnings: LintError[], strict: boolean): void {
	for (const node of nodes) {
		if (typeof node.id !== "string") continue;
		const id = node.id;
		if (typeof node.task !== "string" || !isStringArray(node.writes)) continue;
		const taskLower = node.task.toLowerCase();

		for (const write of node.writes) {
			if (!taskCoversWrite(taskLower, write)) {
				const violation = { code: "write-not-in-task", node: id, detail: write };
				if (strict) errors.push(violation);
				else warnings.push(violation);
			}
		}

		if (FRAME_GATE_RE.test(node.task)) {
			if (!BUDGET_RE.test(node.task)) {
				warnings.push({ code: "no-budget-line", node: id, detail: "frame-gated task needs a Budget: line" });
			}
			if (!node.writes.some((w) => FRAME_PRODUCER_RE.test(w.toLowerCase()))) {
				warnings.push({ code: "render-gate-unproducible", node: id, detail: "no write can produce the expected frame" });
			}
		}
	}
}

const FENCE_RE = /```og-plan\s*\n([\s\S]*?)```/g;

/** Extract the graph block. Never throws; zero or 2+ blocks are lint errors. */
export function parsePlan(text: string): { graphText: string | null; blockCount: number } {
	const matches = [...(text ?? "").matchAll(FENCE_RE)];
	if (matches.length !== 1) return { graphText: null, blockCount: matches.length };
	return { graphText: matches[0][1], blockCount: 1 };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function lintNode(raw: unknown, index: number, errors: LintError[], ids: Set<string>): void {
	const where = `node[${index}]`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push({ code: "bad-shape", node: where });
		return;
	}
	const node = raw as Record<string, unknown>;

	if (typeof node.id !== "string" || node.id === "") {
		errors.push({ code: "bad-shape", node: where, detail: "id" });
		return;
	}
	const id = node.id;
	if (ids.has(id)) errors.push({ code: "dup-id", node: id });
	ids.add(id);

	if (typeof node.role !== "string" || node.role === "") {
		errors.push({ code: "empty-role", node: id });
	}
	if (typeof node.task !== "string" || node.task === "") {
		errors.push({ code: "bad-shape", node: id, detail: "task" });
	}

	for (const field of ["requires", "reads", "writes", "dependsOn"] as const) {
		if (node[field] !== undefined && !isStringArray(node[field])) {
			errors.push({ code: "bad-shape", node: id, detail: field });
		}
	}

	// `writes` is the done predicate (spec-7): a node with no outputs can never be
	// verified, so it can never be scheduled. The planner names its artifact.
	if (node.writes === undefined || (isStringArray(node.writes) && node.writes.length === 0)) {
		errors.push({ code: "no-writes", node: id });
	}

	for (const field of ["requires", "reads", "writes"] as const) {
		if (!isStringArray(node[field])) continue;
		for (const path of node[field]) {
			if (normalizePath(path) !== path) {
				errors.push({ code: "unnormalized-path", node: id, detail: path });
			}
		}
	}

	if (node.width !== undefined && (!Number.isInteger(node.width) || (node.width as number) < 1)) {
		errors.push({ code: "bad-width", node: id, detail: String(node.width) });
	}

	if (node.isolation !== undefined && typeof node.isolation !== "string") {
		errors.push({ code: "bad-shape", node: id, detail: "isolation" });
	}
}

/**
 * Parse and validate. A plan that fails lint is never partially executed —
 * the executor calls this first and refuses on !ok.
 */
export function lintPlan(text: string, options: LintOptions = {}): LintResult {
	const errors: LintError[] = [];
	const warnings: LintError[] = [];
	const { graphText, blockCount } = parsePlan(text);
	if (blockCount !== 1) {
		return { ok: false, errors: [{ code: "no-graph", detail: `blocks: ${blockCount}` }], warnings };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(graphText!);
	} catch (error) {
		return { ok: false, errors: [{ code: "invalid-json", detail: error instanceof Error ? error.message : String(error) }], warnings };
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).nodes)) {
		return { ok: false, errors: [{ code: "bad-shape", detail: "root" }], warnings };
	}
	const root = raw as { version?: unknown; nodes: unknown[] };
	if (root.version !== PLAN_VERSION) {
		return { ok: false, errors: [{ code: "bad-shape", detail: `version: ${String(root.version)}` }], warnings };
	}

	const ids = new Set<string>();
	root.nodes.forEach((node, index) => lintNode(node, index, errors, ids));

	// spec-11 hard rules: write ⊆ task-text (strict: error, default: warning);
	// budget line and render-gate producibility for frame-gated nodes (warnings —
	// the settled plan corpus predates them; they promote to errors corpus-wide).
	lintHardRules(root.nodes as Array<Record<string, unknown>>, errors, warnings, options.strict ?? false);

	// writeRoot is mandatory and absolute: a root-relative boundary cannot be
	// contained against absolute writes without guessing a base (spec-9).
	const writeRootRaw = (root as Record<string, unknown>).writeRoot;
	let writeRoot: string | null = null;
	if (typeof writeRootRaw !== "string" || writeRootRaw === "") {
		errors.push({ code: "no-write-root" });
	} else if (normalizePath(writeRootRaw) !== writeRootRaw) {
		errors.push({ code: "unnormalized-path", detail: writeRootRaw });
	} else {
		writeRoot = writeRootRaw;
	}

	if (writeRoot !== null) {
		const base = options.cwd ?? process.cwd();
		for (const node of root.nodes as Array<Record<string, unknown>>) {
			if (typeof node.id !== "string" || !isStringArray(node.writes)) continue;
			for (const path of node.writes) {
				if (!isInsideRoot(writeRoot, resolvePlanPath(base, path))) {
					errors.push({ code: "write-outside-root", node: node.id, detail: path });
				}
			}
		}
	}

	// Isolation is opt-in and repo-bound (spec-10). The repository is
	// discovered by walking up from each resolved write — no git call at lint.
	const repoRootOf = options.repoRootOf ?? findRepoRoot;
	for (const node of root.nodes as Array<Record<string, unknown>>) {
		if (typeof node.id !== "string") continue;
		for (const error of isolationLint({ id: node.id, isolation: node.isolation, writes: node.writes }, options.cwd ?? process.cwd(), repoRootOf)) {
			errors.push({ code: error.code, node: node.id, detail: error.detail });
		}
	}

	for (const node of root.nodes as Array<Record<string, unknown>>) {
		if (typeof node.id !== "string" || !isStringArray(node.dependsOn)) continue;
		for (const dep of node.dependsOn) {
			if (!ids.has(dep)) errors.push({ code: "unknown-dep", node: node.id, detail: dep });
		}
	}

	if (errors.length === 0 && hasCycle(root.nodes as Array<{ id: string; dependsOn?: string[] }>)) {
		const cycleNode = (root.nodes as Array<{ id: string; dependsOn?: string[] }>).find((node) =>
			reachesSelf(node.id, root.nodes as Array<{ id: string; dependsOn?: string[] }>)
		);
		errors.push({ code: "cycle", node: cycleNode?.id });
	}

	if (errors.length > 0) return { ok: false, errors, warnings };

	const plan: Plan = {
		version: PLAN_VERSION,
		writeRoot: writeRoot as string,
		nodes: (root.nodes as Array<Record<string, unknown>>).map((node) => ({
			id: node.id as string,
			role: node.role as string,
			task: node.task as string,
			requires: uniquePaths((node.requires as string[] | undefined) ?? []),
			reads: uniquePaths((node.reads as string[] | undefined) ?? []),
			writes: uniquePaths((node.writes as string[] | undefined) ?? []),
			dependsOn: [...((node.dependsOn as string[] | undefined) ?? [])],
			width: (node.width as number | undefined) ?? 1,
			...(node.isolation !== undefined ? { isolation: node.isolation as "none" | "worktree" } : {}),
		})),
	};
	return { ok: true, plan, warnings };
}

function depsById(nodes: Array<{ id: string; dependsOn?: string[] }>): Map<string, string[]> {
	return new Map(nodes.map((node) => [node.id, node.dependsOn ?? []]));
}

function reachesSelf(start: string, nodes: Array<{ id: string; dependsOn?: string[] }>): boolean {
	const deps = depsById(nodes);
	const seen = new Set<string>();
	const stack = [...(deps.get(start) ?? [])];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === start) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		stack.push(...(deps.get(current) ?? []));
	}
	return false;
}

function hasCycle(nodes: Array<{ id: string; dependsOn?: string[] }>): boolean {
	return nodes.some((node) => reachesSelf(node.id, nodes));
}

/** Nodes whose deps are all in `done`, in plan (declaration) order. Unknown done ids are ignored. */
/** Nodes not yet done whose deps are all done, in plan (declaration) order. Unknown done ids are ignored. */
export function dispatchable(plan: Plan, done: Iterable<string>): PlanNode[] {
	const doneSet = new Set(done);
	return plan.nodes.filter((node) => !doneSet.has(node.id) && node.dependsOn.every((dep) => doneSet.has(dep)));
}

export const MISSING_FILE_TOKEN_ESTIMATE = 256; // 1 KB / 4

export type FitResult = {
	kept: string[];
	dropped: string[];
	missing: string[];
	/** Tokens charged for what fit — informational, for the truncation report. */
	chargedTokens: number;
};

export type FitOptions = {
	/** bytes per path; defaults to fs stat. Missing files → undefined → 1 KB estimate. */
	sizeOf?: (path: string) => number | undefined;
	/** Per-file overhead on top of the content estimate; default 64. */
	perFileOverhead?: number;
};

/**
 * Greedy head-fill in declaration order under a token budget. Never re-sorts:
 * the planner's order is the priority statement. Bytes/4 is an estimate by
 * design — the budget is a cap, not an invoice.
 */
export function fitPaths(files: string[], budgetTokens: number, options: FitOptions = {}): FitResult {
	const sizeOf =
		options.sizeOf ?? ((path: string) => { try { return statSize(path); } catch { return undefined; } });
	const overhead = options.perFileOverhead ?? 64;

	const kept: string[] = [];
	const dropped: string[] = [];
	const missing: string[] = [];
	let chargedTokens = 0;

	for (const file of uniquePaths(files)) {
		const bytes = sizeOf(file);
		const cost = bytes === undefined ? MISSING_FILE_TOKEN_ESTIMATE + overhead : Math.ceil(bytes / 4) + overhead;
		if (bytes === undefined) missing.push(file);
		if (chargedTokens + cost <= budgetTokens) {
			kept.push(file);
			chargedTokens += cost;
		} else {
			dropped.push(file);
		}
	}

	return { kept, dropped, missing, chargedTokens };
}

// fs stays in this tail; the pure section above never touches it.
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

function statSize(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

export type OgDirs = { root: string; plans: string; loadMaps: string; runs: string };

/** `<cwd>/.pi/orchestration-graph/{plans,load-maps,runs}` — the single tree the extension owns. */
export function ogDirs(cwd: string): OgDirs {
	const root = join(cwd, ".pi", "orchestration-graph");
	return { root, plans: join(root, "plans"), loadMaps: join(root, "load-maps"), runs: join(root, "runs") };
}

/** Idempotent; call before any plan/map/run-log write. */
export function ensureOgDirs(cwd: string): OgDirs {
	const dirs = ogDirs(cwd);
	mkdirSync(dirs.plans, { recursive: true });
	mkdirSync(dirs.loadMaps, { recursive: true });
	mkdirSync(dirs.runs, { recursive: true });
	return dirs;
}

/** The spec-4 map name shape: `load-maps/load-map-<role>-<hash>.md`. */
export function defaultMapPath(cwd: string, role: string, mapHash: string): string {
	const safeRole = role.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "role";
	const safeHash = mapHash.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "00000000";
	return join(ogDirs(cwd).loadMaps, `load-map-${safeRole}-${safeHash}.md`);
}
