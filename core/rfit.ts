// role-fit — can this catalog entry do this task? (spec-13)
//
// score = coverage × precision, the same shape rank.ts ships (spec-3), on a new
// substrate: rank.ts scores *file* overlap for warm candidates, rfit scores
// *capability tag* overlap for the plan's `needs`.
//
//   coverage  = |holds ∩ needs| / |needs|   how much of the need is held
//   precision = |holds ∩ needs| / |holds|   how much of the load is used
//
// Gating uses MIN_COVERAGE, the rank.ts rule (2026-11-02): a node fits when its
// needs are covered. `score` is reported for ordering and audit, never gating.
//
// `needs` (capability tags) is deliberately not `requires` (preload *file
// paths*, spec-7): overloading one field would make invalid states representable
// (CP-22). Plans never carry `holds` — the catalog owns that (K1 decision 2).
//
// Pure: no fs, no clock, no catalog paths. The caller resolves the catalog and
// injects it; every result is JSON-serializable.
//
// `unknown` is a first-class answer, not an error: an agent with no declared
// `holds`, or a task with no declared `needs`, is dispatchable but unproven —
// surfaced in the batch summary, never laundered into `ok`.
//
// Gating line: coverage >= MIN_COVERAGE decides ok vs below (rank.ts precedent).
// MIN_FIT stays the score constant and is reported only — score orders results.
export const MIN_COVERAGE = 0.5;
/**
 * Score threshold, reported for ordering/audit only — NEVER gate on this;
 * the gate is MIN_COVERAGE (Decision addendum 2026-11-02: gating on the
 * coverage × precision product rejects fitting versatile agents).
 */
export const MIN_FIT = 0.5;
/**
 * spec-14 band width: an `ok` whose coverage sits within ±0.15 of MIN_COVERAGE
 * is borderline — the tags disagree enough that a typed question beats a guess.
 * Owner-confirmed 2026-11-02 (probe NOTES): «В целом верим», band kept.
 */
export const BAND_WIDTH = 0.15;
/**
 * spec-14 confidence line: only a verdict at or above this moves a bucket.
 * Provisional on purpose — the judge is trusted overall and under calibration
 * observation (owner verdict 2026-11-02).
 */
export const VERDICT_CONFIDENCE = 0.8;

/** Float slack so a coverage exactly on the band edge stays inside (0.65 − 0.5). */
const BAND_EPSILON = 1e-9;
/** Task text carried into a question, in characters. Long tasks add no signal. */
const TASK_SLICE = 160;

export type Fit = "ok" | "unknown" | "below";

export type FitResult = {
	fit: Fit;
	coverage: number;
	precision: number;
	score: number;
	/** Needs the entry does not hold, in declaration order. */
	missing: string[];
};

export type CatalogEntry = { role: string; holds?: string[] };

/** The slice of a plan node fit cares about: the role, and the tags the task needs. */
export type FitNodeInput = { id: string; role: string; needs?: string[] };

export type NodeFit = { id: string } & FitResult;

export type BatchFit = {
	/** Node ids that proved fit. Dispatchable. */
	ok: string[];
	/** Node ids below MIN_COVERAGE. Deferred with reason `fit-below`. */
	below: string[];
	/** Node ids with nothing declared on one side. Dispatchable, unproven. */
	unknown: string[];
	/** Declaration order; one row per node. */
	results: NodeFit[];
	/** One greppable line naming all three buckets — the audit trail. */
	summary: string;
};

/** De-duplicated tag list; non-strings and blanks are ignored, order is kept. */
function tags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item === "") continue;
		seen.add(item);
	}
	return [...seen];
}

/**
 * Role family (spec-14 decision 3): the prefix before the first `:` or `-`.
 * `coder-typescript` and `coder:ts` are both family `coder`; a bare name is its
 * own family. Specialized agents take a prefix, so the family key needs no new
 * rule (locked in spec-D). An empty role yields an empty family.
 */
export function familyOf(role: string): string {
	if (typeof role !== "string") return "";
	const cut = role.search(/[:-]/);
	// A leading separator yields an empty prefix ("-coder" -> ""); the fallback
	// is the whole name, never "", so no agent lands in an empty family.
	return cut <= 0 ? role : role.slice(0, cut);
}

/**
 * Is this fit result doubtful enough to ask about? `unknown` always is: it means
 * the declarations are missing, not that the agent is wrong. An `ok` within
 * ±BAND_WIDTH of the gate is borderline. `below` is never in band: a node below
 * by a mile is a refusal, not a question (spec-14 decision 2).
 */
export function bandOf(fit: FitResult): boolean {
	if (!fit || typeof fit.coverage !== "number") return false;
	if (fit.fit === "unknown") return true;
	if (fit.fit === "below") return false;
	return Math.abs(fit.coverage - MIN_COVERAGE) <= BAND_WIDTH + BAND_EPSILON;
}

/**
 * Candidate agents for a role: every catalog entry in the same family, in
 * declaration order, de-duplicated by role. Both directions work — a generic
 * node sees its specialists, a specialist sees its generic sibling. Purpose is
 * choosing the best fit inside the family, never scarcity (spec-14 decision 3).
 */
export function familyCandidates(role: string, entries: CatalogEntry[] | undefined): string[] {
	const family = familyOf(role);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry.role !== "string" || familyOf(entry.role) !== family) continue;
		if (seen.has(entry.role)) continue;
		seen.add(entry.role);
		out.push(entry.role);
	}
	return out;
}

/**
 * One typed `noul` question (judgment extension shape): yes/no plus the metadata
 * the mapping needs. `cp_key`, `node` and `agent` are data, never parsed ids —
 * verdicts align by key, ADR-0039 precedent. `instructions` is the field the
 * shipped lint requires; `cp_key` is the sidecar field it tolerates.
 */
export type RfitQuestion = {
	type: "noul";
	cp_key: string;
	node: string;
	agent: string;
	instructions: string;
};

/** A band batch, keyed by `cp_key`: the judge tool takes a question map. */
export type RfitQuestions = Record<string, RfitQuestion>;

/** A plan node plus the task text a question quotes. */
export type RfitNodeInput = FitNodeInput & { task?: string };

export type RfitVerdict = { value: string; confidence: number };

export type RfitMove = { id: string; agent: string; fit: "ok" | "below" };

export type RfitMapping = {
	/** Bucket moves, in question order. Deterministic: same input, same moves. */
	moves: RfitMove[];
	/** Question keys with no verdict, a weak verdict, or an unusable value. */
	unresolved: string[];
};

function taskSlice(task: string | undefined): string {
	const text = typeof task === "string" ? task.replace(/\s+/g, " ").trim() : "";
	return text.length > TASK_SLICE ? `${text.slice(0, TASK_SLICE)}…` : text;
}

/**
 * Build the spec-14 batch: one `noul` question per (band node, family candidate)
 * pair. Pure — the caller resolves the catalog. Non-band nodes yield nothing, so
 * a settled plan asks nothing. A node whose role has no family in the catalog
 * yields nothing either; the pool still lists it with an empty candidate list.
 */
export function buildRfitQuestions(nodes: RfitNodeInput[], entries: CatalogEntry[] | undefined): RfitQuestions {
	const catalog = Array.isArray(entries) ? entries : [];
	const byRole = new Map<string, CatalogEntry>();
	for (const entry of catalog) {
		if (!entry || typeof entry.role !== "string" || byRole.has(entry.role)) continue;
		byRole.set(entry.role, entry);
	}

	const out: RfitQuestions = {};
	for (const node of Array.isArray(nodes) ? nodes : []) {
		if (!node || typeof node.id !== "string") continue;
		if (!bandOf(fitNode(node, byRole.get(node.role)))) continue;
		const task = taskSlice(node.task);
		for (const entry of catalog) {
			if (!entry || typeof entry.role !== "string") continue;
			if (familyOf(entry.role) !== familyOf(node.role)) continue;
			const key = `rfit:${node.id}:${entry.role}`;
			if (key in out) continue;
			out[key] = {
				type: "noul",
				cp_key: key,
				node: node.id,
				agent: entry.role,
				instructions: `Does agent ${entry.role} (holds: [${tags(entry.holds).join(", ")}]) cover subtask: ${task}?`,
			};
		}
	}
	return out;
}

/**
 * Map judge verdicts onto buckets. Deterministic and conservative: only a
 * confidence at or above VERDICT_CONFIDENCE moves `yes` to `ok` or `no` to
 * `below`. Anything else — low confidence, an unknown value, a missing verdict —
 * stays `unknown` and is listed. Nothing answered is ever guessed into a pass.
 */
export function mapVerdicts(questions: RfitQuestions, verdicts: Record<string, RfitVerdict> | undefined): RfitMapping {
	const answers = verdicts && typeof verdicts === "object" ? verdicts : {};
	const moves: RfitMove[] = [];
	const unresolved: string[] = [];
	for (const [key, question] of Object.entries(questions ?? {})) {
		const verdict = answers[key];
		const confidence = verdict && typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence) ? verdict.confidence : 0;
		const value = verdict && typeof verdict.value === "string" ? verdict.value.trim().toLowerCase() : "";
		// Above 1.0 is not a probability: reject it like a malformed verdict
		// rather than letting an over-confident number move a bucket.
		if (confidence < VERDICT_CONFIDENCE || confidence > 1 || (value !== "yes" && value !== "no")) {
			unresolved.push(key);
			continue;
		}
		moves.push({ id: question.node, agent: question.agent, fit: value === "yes" ? "ok" : "below" });
	}
	return { moves, unresolved };
}

function bucketLine(label: string, ids: string[]): string {
	return ids.length === 0 ? `${label} 0` : `${label} ${ids.length} (${ids.join(", ")})`;
}

/**
 * Fit one plan node against one catalog entry. Either side declaring nothing is
 * `unknown` — score 0, no missing list (nothing was claimed, so nothing is
 * lacking). Otherwise the rank.ts formula is computed, and MIN_COVERAGE is the
 * line: coverage alone gates, score (coverage × precision) is reported.
 */
export function fitNode(node: { role: string; needs?: string[] }, entry?: CatalogEntry): FitResult {
	const needs = tags(node?.needs);
	const holds = tags(entry?.holds);
	if (needs.length === 0 || holds.length === 0) {
		return { fit: "unknown", coverage: 0, precision: 0, score: 0, missing: [] };
	}

	const held = new Set(holds);
	const hit = needs.filter((tag) => held.has(tag));
	const coverage = hit.length / needs.length;
	const precision = hit.length / holds.length;
	const score = coverage * precision;
	return {
		fit: coverage >= MIN_COVERAGE ? "ok" : "below",
		coverage,
		precision,
		score,
		missing: needs.filter((tag) => !held.has(tag)),
	};
}

/**
 * Fit every node in declaration order, bucketed. A role with no catalog entry is
 * `unknown` (no evidence), never `below`: the catalog fills up (spec-A) without
 * turning today's dispatchable plans into failures.
 */
export function fitBatch(nodes: FitNodeInput[], entries: CatalogEntry[] | undefined): BatchFit {
	const catalog = new Map<string, CatalogEntry>();
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry.role !== "string" || catalog.has(entry.role)) continue;
		catalog.set(entry.role, entry);
	}

	const ok: string[] = [];
	const below: string[] = [];
	const unknown: string[] = [];
	const results: NodeFit[] = [];

	for (const node of Array.isArray(nodes) ? nodes : []) {
		if (!node || typeof node.id !== "string") continue;
		const result = fitNode(node, catalog.get(node.role));
		results.push({ id: node.id, ...result });
		if (result.fit === "ok") ok.push(node.id);
		else if (result.fit === "below") below.push(node.id);
		else unknown.push(node.id);
	}

	return {
		ok,
		below,
		unknown,
		results,
		summary: `fit: ${bucketLine("ok", ok)} | ${bucketLine("below deferred", below)} | ${bucketLine("unknown", unknown)}`,
	};
}
