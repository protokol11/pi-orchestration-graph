// Marker validity — is the fork point still raw? (spec-4, decision 7)
//
// A CompactionEntry between the marker and the leaf means the prefix was
// summarized, so `holds` no longer describes the window. `rank` consumes this as
// `compactedAfterMarker`; nobody re-implements the scan.

export type ValidityEntry = { id: string; type?: string };

export type MarkerValidity =
	| { state: "ok" }
	| { state: "compacted"; by: string }
	| { state: "missing" };

export function markerValidity(branch: ValidityEntry[], markerId: string): MarkerValidity {
	const index = branch.findIndex((entry) => entry.id === markerId);
	if (index === -1) return { state: "missing" };
	for (const entry of branch.slice(index + 1)) {
		if (entry.type === "compaction") return { state: "compacted", by: entry.id };
	}
	return { state: "ok" };
}
