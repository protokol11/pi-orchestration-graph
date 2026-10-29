// dispatcher — the loop that turns a plan into runs (spec-7).
//
// The lesson of the Round8 run (`.scratch/round8-dispatcher/FINDINGS.md`):
// state must be recomputed from the repository, never appended to a log. So
// `deriveDone` is make semantics over `writes`, `nextStep` is a pure function of
// (plan, fs), and the run log is telemetry — deleting it changes nothing.
//
// Everything is pure except the fs tail (default `sizeOf`, map write, run log).
import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePath } from "./contract.ts";
import { fitPaths, type FitOptions, type FitResult, type Plan, type PlanNode } from "./plan.ts";
import { rank, type Candidate } from "./rank.ts";

export const DEFAULT_MAX_ATTEMPTS = 2;
/** 40% of a 120k window: above this the task text is logged as oversized, never truncated. */
export const DEFAULT_READ_WARN_TOKENS = 48_000;
export const MAP_SOURCE_POST_TASK = "post-task";

export type FsProbe = {
	exists(path: string): boolean;
	mtime(path: string): number | undefined;
};

export type DoneState = {
	done: string[];
	/** Undone nodes with a write that is absent on disk. */
	missing: Record<string, string[]>;
	/** Undone nodes with a write older than the newest dependency output. */
	stale: Record<string, string[]>;
	/** Undone nodes whose dependencies are not done. */
	blockedByDep: Record<string, string[]>;
};

export type StepAction = { kind: "spawn" } | { kind: "resume"; candidate: string; score: number };

export type NextStep =
	| { kind: "finished"; done: string[] }
	| { kind: "blocked"; done: string[]; detail: string }
	| {
			kind: "next";
			done: string[];
			node: PlanNode;
			action: StepAction;
			load: FitResult;
			reads: string[];
			readsTokens: number;
			readWarn: boolean;
			declaredWidth: number;
	  };

export type StepOptions = {
	/** Preload budget for `requires`; default 12k tokens. */
	budgetTokens?: number;
	/** Pool candidates for this node's role (spec-3). Empty means cold start → spawn. */
	candidates?: Candidate[];
	now?: number;
	readWarnTokens?: number;
	sizeOf?: FitOptions["sizeOf"];
	perFileOverhead?: number;
};

function maxWriteMtime(node: PlanNode, fs: FsProbe): number {
	let max = Number.NEGATIVE_INFINITY;
	for (const path of node.writes) {
		const mtime = fs.mtime(path);
		if (mtime !== undefined && mtime > max) max = mtime;
	}
	return max;
}

/**
 * Make semantics: a node is done when every `writes` path exists and is not
 * older than the newest write of its done dependencies. A node whose deps are
 * undone is never done, even if its outputs are present.
 */
export function deriveDone(plan: Plan, fs: FsProbe): DoneState {
	const byId = new Map(plan.nodes.map((node) => [node.id, node]));
	const memo = new Map<string, boolean>();
	const missing: Record<string, string[]> = {};
	const stale: Record<string, string[]> = {};
	const blockedByDep: Record<string, string[]> = {};

	const isDone = (id: string): boolean => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		const node = byId.get(id);
		if (!node) return false;

		// Guard: lint rejects cycles, but deriveDone is also called on a plan that
		// may have been edited. A cycle must not hang the loop.
		memo.set(id, false);

		const undoneDeps = node.dependsOn.filter((dep) => !isDone(dep));
		if (undoneDeps.length > 0) {
			blockedByDep[id] = undoneDeps;
			return false;
		}

		if (node.writes.length === 0) {
			missing[id] = [];
			return false;
		}

		const depMax = Math.max(
			Number.NEGATIVE_INFINITY,
			...node.dependsOn.map((dep) => maxWriteMtime(byId.get(dep)!, fs))
		);

		const absent: string[] = [];
		const older: string[] = [];
		for (const path of node.writes) {
			const mtime = fs.mtime(path);
			if (mtime === undefined || !fs.exists(path)) {
				absent.push(path);
			} else if (mtime < depMax) {
				older.push(path);
			}
		}
		if (absent.length > 0) missing[id] = absent;
		if (older.length > 0) stale[id] = older;
		if (absent.length > 0 || older.length > 0) return false;

		memo.set(id, true);
		return true;
	};

	const done: string[] = [];
	for (const node of plan.nodes) {
		if (isDone(node.id)) done.push(node.id);
	}
	return { done, missing, stale, blockedByDep };
}

/** Normalized, deduplicated, sorted union of preload, task material and outputs. */
export function mapFromNode(node: PlanNode): string[] {
	const seen = new Set<string>();
	for (const path of [...node.requires, ...node.reads, ...node.writes]) {
		const normalized = normalizePath(path);
		if (normalized !== "") seen.add(normalized);
	}
	return [...seen].sort();
}

/** The dispatch text. `reads` is listed whole: the planner's task material is never truncated. */
export function buildTaskText(node: PlanNode): string {
	const parts = [node.task.trim()];
	if (node.reads.length > 0) {
		parts.push("", "Read these files before you start:");
		node.reads.forEach((path, index) => parts.push(`${index + 1}. ${path}`));
	}
	return `${parts.join("\n")}\n`;
}

/** Token estimate for a path list; the same bytes/4 estimate `fitPaths` charges. */
export function estimateTokens(paths: string[], sizeOf?: FitOptions["sizeOf"]): number {
	const probe = sizeOf ?? ((path: string) => statSize(path));
	let total = 0;
	for (const path of uniqueNormalized(paths)) {
		const bytes = probe(path);
		total += (bytes === undefined ? 256 : Math.ceil(bytes / 4)) + 64;
	}
	return total;
}

function uniqueNormalized(paths: string[]): string[] {
	const seen = new Set<string>();
	for (const path of paths) {
		const normalized = normalizePath(path);
		if (normalized !== "") seen.add(normalized);
	}
	return [...seen];
}

/** Independence test for the pool (wave 5): two branches may run together only with disjoint writes. */
export function disjointWriteSets(a: PlanNode, b: PlanNode): boolean {
	const left = new Set(a.writes.map(normalizePath));
	return b.writes.every((path) => !left.has(normalizePath(path)));
}

/** Node ids that cannot run together because they share a write. */
export function writeCollisions(plan: Plan, ids: string[]): Array<[string, string]> {
	const wanted = new Set(ids);
	const nodes = plan.nodes.filter((node) => wanted.has(node.id));
	const collisions: Array<[string, string]> = [];
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			if (!disjointWriteSets(nodes[i], nodes[j])) collisions.push([nodes[i].id, nodes[j].id]);
		}
	}
	return collisions;
}

/**
 * One step of the loop. Node order is declaration order; `rank` picks a session
 * for the chosen node, never a different node. Empty pool is a cold start, not
 * an error (F3).
 */
export function nextStep(plan: Plan, fs: FsProbe, options: StepOptions = {}): NextStep {
	const state = deriveDone(plan, fs);
	const doneSet = new Set(state.done);
	const candidates = plan.nodes.filter(
		(node) => !doneSet.has(node.id) && node.dependsOn.every((dep) => doneSet.has(dep))
	);

	if (candidates.length === 0) {
		if (state.done.length === plan.nodes.length) return { kind: "finished", done: state.done };
		const blocked = Object.keys(state.blockedByDep);
		return {
			kind: "blocked",
			done: state.done,
			detail: blocked.length > 0 ? `undone deps: ${blocked.join(", ")}` : "no dispatchable node",
		};
	}

	const node = candidates[0];
	const load = fitPaths(node.requires, options.budgetTokens ?? 12_000, {
		...(options.sizeOf ? { sizeOf: options.sizeOf } : {}),
		...(options.perFileOverhead !== undefined ? { perFileOverhead: options.perFileOverhead } : {}),
	});
	// The estimate is the full declared load (requires + reads), not `reads`
	// alone: a plan that puts its whole corpus in `requires` must still see a
	// non-zero number (og-three-demo run, harness gap #1).
	const need = uniqueNormalized([...node.requires, ...node.reads]);
	const readsTokens = estimateTokens(need, options.sizeOf);
	const readWarn = readsTokens > (options.readWarnTokens ?? DEFAULT_READ_WARN_TOKENS);
	const ranked = rank({
		role: node.role,
		requires: need,
		candidates: options.candidates ?? [],
		...(options.now !== undefined ? { now: options.now } : {}),
	});
	const action: StepAction =
		ranked.chosen !== null
			? { kind: "resume", candidate: ranked.chosen, score: ranked.score }
			: { kind: "spawn" };

	return {
		kind: "next",
		done: state.done,
		node,
		action,
		load,
		reads: node.reads,
		readsTokens,
		readWarn,
		declaredWidth: node.width,
	};
}

/** The map contract (spec-4) needs `- read:` lines and one `- gaps:` line. */
export function renderLoadMap(input: {
	role: string;
	node: string;
	plan: string;
	files: string[];
	gaps?: string;
}): string {
	const lines = [
		`# load-map — ${input.role}`,
		"",
		`- source: ${MAP_SOURCE_POST_TASK}`,
		`- node: ${input.node}`,
		`- plan: ${normalizePath(input.plan)}`,
		"- coverage: declared",
	];
	for (const path of input.files) {
		lines.push(`- read: ${path}`, "  - contains: declared in the plan node", "  - symbols: n/a");
	}
	lines.push(`- gaps: ${input.gaps ?? "none declared; coverage is declared, not observed"}`);
	return `${lines.join("\n")}\n`;
}

export type RunLogEntry = {
	step: number;
	node: string;
	action: StepAction["kind"];
	candidate?: string;
	score?: number;
	kept: string[];
	dropped: string[];
	missing: string[];
	readsTokens: number;
	readWarn: boolean;
	declaredWidth: number;
	writesVerified: boolean;
	at: string;
};

/** Telemetry only. Nothing in this file reads it back — that is the point (F5). */
export function runLogLine(entry: object): string {
	return JSON.stringify(entry);
}

export function runLogPath(cwd: string, planSlug: string, at: string = new Date().toISOString()): string {
	const safePlan = planSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "plan";
	const stamp = at.replace(/[^0-9]/g, "").slice(0, 14);
	return join(cwd, ".pi", "orchestration-graph", "runs", `${safePlan}-${stamp}.jsonl`);
}

export function appendRunLog(path: string, entry: object): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${runLogLine(entry)}\n`, "utf-8");
}

/** Default fs probe: relative paths resolve against `cwd`. */
export function fsProbe(cwd: string): FsProbe {
	const resolve = (path: string) => (path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : join(cwd, path));
	return {
		exists: (path) => existsSync(resolve(path)),
		mtime: (path) => {
			try {
				return statSync(resolve(path)).mtimeMs;
			} catch {
				return undefined;
			}
		},
	};
}

/** Byte sizes relative to `cwd`, for `fitPaths` and the reads estimate. */
export function sizeProbe(cwd: string): (path: string) => number | undefined {
	return (path) => {
		const resolved = path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : join(cwd, path);
		return statSize(resolved);
	};
}

export function readText(path: string): string {
	return readFileSync(path, "utf-8");
}

function statSize(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}
