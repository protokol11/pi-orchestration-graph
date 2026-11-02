// role-fit — can this catalog entry do this task? (spec-13)
//
// score = coverage × precision, the same shape rank.ts ships (spec-3), on a new
// substrate: rank.ts scores *file* overlap for warm candidates, rfit scores
// *capability tag* overlap for the plan's `needs`.
//
//   coverage  = |holds ∩ needs| / |needs|   how much of the need is held
//   precision = |holds ∩ needs| / |holds|   how much of the load is used
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
export const MIN_FIT = 0.5;

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
	/** Node ids below MIN_FIT. Deferred with reason `fit-below`. */
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

function bucketLine(label: string, ids: string[]): string {
	return ids.length === 0 ? `${label} 0` : `${label} ${ids.length} (${ids.join(", ")})`;
}

/**
 * Fit one plan node against one catalog entry. Either side declaring nothing is
 * `unknown` — score 0, no missing list (nothing was claimed, so nothing is
 * lacking). Otherwise the rank.ts formula decides, and MIN_FIT is the line.
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
		fit: score >= MIN_FIT ? "ok" : "below",
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
