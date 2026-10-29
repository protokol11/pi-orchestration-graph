// Candidate ranking — which already-loaded role-sub-agent takes this subtask
// (spec-3). Pure: no fs, no clock, no session access. The caller injects `now`.
//
// score = coverage × precision
//   coverage  = |holds ∩ requires| / |requires|   how much of the need is held
//   precision = |holds ∩ requires| / |holds|      how much of the load is used
// Their product rejects the node that read everything; coverage alone saturates
// and precision alone ignores the requirement (both measured, .scratch/rank-probe).

import { normalizePath } from "./contract.ts";

export const MIN_COVERAGE = 0.5;
export const DEFAULT_CACHE_LIFETIME_SEC = 300;

export type Candidate = {
	nodeId: string;
	role: string;
	files: string[];
	mapPath?: string;
	/** Marker timestamp (ISO). Freshness is a filter, never a bonus. */
	at: string;
	/** Entries added after the marker — kept for lineage/reporting. */
	entriesAfterMarker: number;
	/** A CompactionEntry between the marker and the leaf invalidates `holds`. */
	compactedAfterMarker: boolean;
};

export type RankInput = {
	role: string;
	requires: string[];
	candidates: Candidate[];
	/** Injected clock in ms. When absent, freshness is not evaluated (no false rejection). */
	now?: number;
	cacheLifetimeSec?: number;
	minCoverage?: number;
};

export type RankResult =
	| { chosen: null; reason: string; considered: number; filtered: number }
	| { chosen: string; score: number; reason: string; considered: number; filtered: number };

type Scored = {
	nodeId: string;
	hit: number;
	holds: number;
	coverage: number;
	precision: number;
	score: number;
	at: number;
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

function rejectionCause(
	candidate: Candidate,
	role: string,
	now: number | undefined,
	lifetimeMs: number,
	seen: Set<string>
): string | null {
	if (!candidate || typeof candidate !== "object") return "invalid";
	if (typeof candidate.nodeId !== "string" || candidate.nodeId === "") return "invalid";
	if (seen.has(candidate.nodeId)) return "duplicate";
	if (candidate.role !== role) return "role";
	if (candidate.compactedAfterMarker === true) return "compacted";
	if (!Array.isArray(candidate.files)) return "invalid";
	if (now === undefined) return null;

	const at = Date.parse(candidate.at);
	if (Number.isNaN(at)) return "stale";
	if (now - at > lifetimeMs) return "stale";
	return null;
}

export function rank(input: RankInput): RankResult {
	const requires = uniqueNormalized(Array.isArray(input.requires) ? input.requires : []);
	if (requires.length === 0) {
		return { chosen: null, reason: "requires-empty", considered: 0, filtered: 0 };
	}

	const candidates = Array.isArray(input.candidates) ? input.candidates : [];
	const lifetimeMs = (input.cacheLifetimeSec ?? DEFAULT_CACHE_LIFETIME_SEC) * 1000;
	const minCoverage = input.minCoverage ?? MIN_COVERAGE;

	const seen = new Set<string>();
	const rejections = new Map<string, number>();
	const scored: Scored[] = [];
	let filtered = 0;

	const reject = (cause: string) => {
		filtered++;
		rejections.set(cause, (rejections.get(cause) ?? 0) + 1);
	};

	for (const candidate of candidates) {
		const cause = rejectionCause(candidate, input.role, input.now, lifetimeMs, seen);
		if (cause) {
			reject(cause);
			continue;
		}
		seen.add(candidate.nodeId);

		const holds = uniqueNormalized(candidate.files);
		const hit = requires.filter((path) => holds.includes(path)).length;
		const coverage = hit / requires.length;
		// The floor is a pre-filter: a winner that is later rejected is a wrong
		// answer, not a strict one. Regression: rank-probe run 2, case 9.
		if (coverage < minCoverage) {
			reject("below-floor");
			continue;
		}
		const precision = holds.length === 0 ? 0 : hit / holds.length;
		scored.push({
			nodeId: candidate.nodeId,
			hit,
			holds: holds.length,
			coverage,
			precision,
			score: coverage * precision,
			at: Date.parse(candidate.at),
		});
	}

	if (scored.length === 0) {
		const causes = [...rejections.keys()].sort();
		const reason = causes.length === 0 ? "no-eligible-candidate" : `filtered:${causes.join("+")}`;
		return { chosen: null, reason, considered: 0, filtered };
	}

	const freshness = (at: number) => (Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at);
	scored.sort((a, b) => b.score - a.score || freshness(b.at) - freshness(a.at));

	const best = scored[0];
	return {
		chosen: best.nodeId,
		score: best.score,
		reason: `hit ${best.hit}/${requires.length} of ${best.holds} held`,
		considered: scored.length,
		filtered,
	};
}
