// pool — how a declared width becomes a batch (spec-8, amended by spec-9).
//
// The dispatcher runs one node per step. The pool packs several dispatchable
// nodes into one `runs.all` call when their declarations allow it:
//
//   - the batch cap is `min(width)` over its members;
//   - every pair of members has disjoint `writes`;
//   - no two members are ranked to the same warm session.
//
// Isolation is checked, not created. One bounded `scanRoot` before the batch,
// one after; `verifyBatch` turns the diff into `accepted | missing | unchanged`
// plus the spec-9 stray buckets. Authorship is never claimed.
//
// Pure except the fs tail: the scan default, the attempts file, and the
// `batch.json` audit record the shell writes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePath, resolvePlanPath } from "./contract.ts";
import {
	DEFAULT_MAX_ATTEMPTS,
	deriveDone,
	writeCollisions,
	type FsProbe,
} from "./dispatcher.ts";
import { checkRepoClean, findRepoRoot } from "./isolation.ts";
import { dispatchable, type Plan, type PlanNode } from "./plan.ts";
import { rank, type Candidate } from "./rank.ts";
import { diffScan, scanRoot, type Change, type RootScan } from "./root.ts";

export type PathSnapshot = {
	path: string;
	exists: boolean;
	hash: string | null;
	size: number;
};

export type RefusalWhy = "width" | "collision" | "session-taken" | "repo-write-conflict";
export type Refusal = { id: string; why: RefusalWhy };

export type Batch = {
	/** Declaration order; deterministic for the same plan + filesystem. */
	ids: string[];
	deferred: Refusal[];
	widthCap: number;
	/** Declared writes of `ids`, projected from the pre-batch `RootScan`. */
	snapshot: PathSnapshot[];
	rootScan: RootScan;
};

export type NextBatch =
	| { kind: "finished"; done: string[] }
	| { kind: "blocked"; done: string[]; detail: string }
	| { kind: "node-failed"; done: string[]; node: string; attempts: number }
	| {
			kind: "batch";
			done: string[];
			batch: Batch;
			/** Set when the batch carries isolated nodes but the repository is dirty (spec-10). */
			refused?: { reason: "repo-dirty"; dirty: string[] };
	  };

export type BatchVerdict = {
	accepted: string[];
	missing: string[];
	unchanged: string[];
	/** `other-declared` + `undeclared`, never `own` (spec-9). */
	stray: Change[];
	strayCheck: "ok" | "skipped";
	intrusion: boolean;
};

export type PoolOptions = {
	/** Warm sessions available to rank (spec-3). Empty means cold start. */
	candidates?: Candidate[];
	now?: number;
	/** Durable retry counters; default `{}`. */
	attempts?: Record<string, number>;
	maxAttempts?: number;
	cwd?: string;
	/** A scan already taken this step; avoids walking the root twice (spec-9). */
	scan?: RootScan;
	/** Injected preflight for isolated batches (spec-10); default runs real `git status`. */
	checkRepo?: (repo: string) => { clean: boolean; dirty: string[] };
};

function uniqueNormalized(paths: string[]): string[] {
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

/**
 * Greedy pack in declaration order. A node is admitted while the batch stays
 * within `min(width)`, its writes stay disjoint, and its ranked session is free.
 * A node that is not dispatchable is not a candidate and is not listed.
 */
export function nextBatch(plan: Plan, fs: FsProbe, options: PoolOptions = {}): NextBatch {
	const state = deriveDone(plan, fs);
	const candidates = dispatchable(plan, state.done);

	if (candidates.length === 0) {
		if (state.done.length === plan.nodes.length) return { kind: "finished", done: state.done };
		const blocked = Object.keys(state.blockedByDep);
		return {
			kind: "blocked",
			done: state.done,
			detail: blocked.length > 0 ? `undone deps: ${blocked.join(", ")}` : "no dispatchable node",
		};
	}

	const attempts = options.attempts ?? {};
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const exhausted = candidates.find((node) => (attempts[node.id] ?? 0) >= maxAttempts);
	if (exhausted) {
		return {
			kind: "node-failed",
			done: state.done,
			node: exhausted.id,
			attempts: attempts[exhausted.id] ?? 0,
		};
	}

	const cwd = options.cwd ?? process.cwd();
	const scan = options.scan ?? scanRoot(plan.writeRoot);
	// Repo membership is an fs walk-up per write, cached for the whole pack.
	const repoRootCache = new Map<string, string | null>();
	const repoRootOf = (absolute: string): string | null => {
		const cached = repoRootCache.get(absolute);
		if (cached !== undefined) return cached;
		const root = findRepoRoot(absolute);
		repoRootCache.set(absolute, root);
		return root;
	};
	const isRepoWriter = (node: PlanNode): boolean =>
		node.writes.some((write) => repoRootOf(resolvePlanPath(cwd, write)) !== null);
	const isUnisolatedRepoWriter = (node: PlanNode): boolean =>
		node.isolation !== "worktree" && isRepoWriter(node);
	const rankedSessions = new Map<string, string | null>();
	const sessionOf = (node: PlanNode): string | null => {
		const cached = rankedSessions.get(node.id);
		if (cached !== undefined) return cached;
		const ranked = rank({
			role: node.role,
			requires: uniqueNormalized([...node.requires, ...node.reads]),
			candidates: options.candidates ?? [],
			...(options.now !== undefined ? { now: options.now } : {}),
		});
		const chosen = ranked.chosen;
		rankedSessions.set(node.id, chosen);
		return chosen;
	};

	const members: PlanNode[] = [];
	const deferred: Refusal[] = [];
	const usedSessions = new Set<string>();
	let cap = Number.POSITIVE_INFINITY;

	const add = (node: PlanNode) => {
		members.push(node);
		cap = Math.min(cap, node.width);
		const session = sessionOf(node);
		if (session !== null) usedSessions.add(session);
	};

	for (const node of candidates) {
		if (members.length === 0) {
			add(node);
			continue;
		}
		if (Math.min(cap, node.width) < members.length + 1) {
			deferred.push({ id: node.id, why: "width" });
			continue;
		}
		// At most one unisolated repo-internal writer per batch: two children in
		// one tree leave no attribution, so the second is refused structurally
		// before dispatch, not warned about (spec-10 decision 2).
		if (isUnisolatedRepoWriter(node) && members.some(isUnisolatedRepoWriter)) {
			deferred.push({ id: node.id, why: "repo-write-conflict" });
			continue;
		}
		const ids = [...members.map((member) => member.id), node.id];
		if (writeCollisions(plan, ids).length > 0) {
			deferred.push({ id: node.id, why: "collision" });
			continue;
		}
		const session = sessionOf(node);
		if (session !== null && usedSessions.has(session)) {
			deferred.push({ id: node.id, why: "session-taken" });
			continue;
		}
		add(node);
	}

	const declared = new Set<string>();
	for (const member of members) {
		for (const write of member.writes) declared.add(resolvePlanPath(cwd, write));
	}
	const snapshot: PathSnapshot[] = [...declared]
		.sort()
		.map((path) => {
			const scanned = scan.files.get(path);
			return {
				path,
				exists: scanned !== undefined,
				hash: scanned?.hash ?? null,
				size: scanned?.size ?? 0,
			};
		});

	// Preflight: a batch that carries isolated nodes needs a clean repository.
	// Refused, not degraded — no stash, no shared-tree fallback (spec-10 decision 3).
	const isolated = members.find((member) => member.isolation === "worktree");
	if (isolated) {
		const repo = resolveRepo(cwd, isolated);
		if (repo !== null) {
			const status = (options.checkRepo ?? ((target: string) => checkRepoClean(target)))(repo);
			if (!status.clean) {
				return {
					kind: "batch",
					done: state.done,
					batch: { ids: members.map((member) => member.id), deferred, widthCap: cap, snapshot, rootScan: scan },
					refused: { reason: "repo-dirty", dirty: status.dirty },
				};
			}
		}
	}

	return {
		kind: "batch",
		done: state.done,
		batch: { ids: members.map((member) => member.id), deferred, widthCap: cap, snapshot, rootScan: scan },
	};
}

/** The repository an isolated node writes to; lint guarantees at least one repo-internal write. */
function resolveRepo(cwd: string, node: PlanNode): string | null {
	for (const write of node.writes) {
		const root = findRepoRoot(resolvePlanPath(cwd, write));
		if (root !== null) return root;
	}
	return null;
}

/**
 * spec-12: the accepted/not-done gap, computed AT settle time. An accepted
 * verdict records the batch outcome; make semantics (deriveDone) is recomputed
 * from the repo. When they disagree for a node, the fix is always the plan's
 * write list — never touching untouched files (P2-9 lesson).
 */
export type SettleWarning = {
	id: string;
	missing: string[];
	stale: string[];
	blockedByDep: string[];
};

export function settleWarnings(plan: Plan, fs: FsProbe, accepted: string[]): SettleWarning[] {
	const state = deriveDone(plan, fs);
	const warnings: SettleWarning[] = [];
	for (const id of accepted) {
		if (state.done.includes(id)) continue;
		warnings.push({
			id,
			missing: state.missing[id] ?? [],
			stale: state.stale[id] ?? [],
			blockedByDep: state.blockedByDep[id] ?? [],
		});
	}
	return warnings;
}

/**
 * Post-batch verdict. Own writes feed `accepted | missing | unchanged`; every
 * other changed path becomes `stray`. When a scan hit its bound the stray half
 * degrades to `skipped` — a flag, never a failure (spec-9).
 */
export function verifyBatch(
	batch: Pick<Batch, "ids">,
	before: RootScan,
	after: RootScan,
	plan: Plan,
	options: { cwd?: string } = {}
): BatchVerdict {
	const cwd = options.cwd ?? process.cwd();
	const strict = !before.truncated && !after.truncated;
	const changes = diffScan(before, after, plan, batch.ids, { cwd });
	const stray = strict ? changes.filter((change) => change.kind !== "own") : [];
	const ownPaths = new Set(changes.filter((change) => change.kind === "own").map((change) => change.path));

	const accepted: string[] = [];
	const missing: string[] = [];
	const unchanged: string[] = [];

	for (const id of batch.ids) {
		const node = plan.nodes.find((candidate) => candidate.id === id);
		if (!node) continue;
		const paths = node.writes.map((write) => resolvePlanPath(cwd, write));
		if (paths.some((path) => !after.files.has(path))) {
			missing.push(id);
		} else if (paths.some((path) => ownPaths.has(path))) {
			accepted.push(id);
		} else {
			unchanged.push(id);
		}
	}

	return {
		accepted,
		missing,
		unchanged,
		stray,
		strayCheck: strict ? "ok" : "skipped",
		intrusion: stray.some((change) => change.kind === "other-declared"),
	};
}

/** `.pi/orchestration-graph/runs/<slug>.attempts.json` — state, never the run log. */
export function attemptsPath(cwd: string, planSlug: string): string {
	const safePlan = planSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "plan";
	return join(cwd, ".pi", "orchestration-graph", "runs", `${safePlan}.attempts.json`);
}

export function readAttempts(path: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

export function bumpAttempts(path: string, id: string): number {
	const attempts = readAttempts(path);
	const next = (attempts[id] ?? 0) + 1;
	attempts[id] = next;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(attempts)}\n`, "utf-8");
	return next;
}

/** An accepted verdict clears the counter, so a manual rerun is not doomed early. */
export function clearAttempts(path: string, ids: Iterable<string>): void {
	const attempts = readAttempts(path);
	let changed = false;
	for (const id of ids) {
		if (id in attempts) {
			delete attempts[id];
			changed = true;
		}
	}
	if (!changed) return;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(attempts)}\n`, "utf-8");
}
