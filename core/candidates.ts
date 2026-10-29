// candidatesFromBranch — the role pool the dispatcher ranks over (spec-3).
// One Candidate per valid load-ready marker on the branch. A compacted or
// missing marker is dropped because `holds` no longer describes the window
// (validity.ts owns that call; this module never re-implements the scan).
import { readMarker, uniquePaths } from "./contract.ts";
import type { Candidate } from "./rank.ts";
import { markerValidity } from "./validity.ts";

export type BranchEntry = {
	id?: string;
	type?: string;
	customType?: string;
	data?: unknown;
};

/**
 * Markers → rank candidates. `holds` is the union of the marker's declared
 * load files and requires: both were in the session's context when the marker
 * was written. `nodeId` is the marker entry id — within one branch dump it is
 * the resumable target's identity.
 */
export function candidatesFromBranch(branch: BranchEntry[]): Candidate[] {
	if (!Array.isArray(branch)) return [];
	const out: Candidate[] = [];
	branch.forEach((entry, index) => {
		const marker = readMarker(entry);
		if (!marker) return;
		const id = entry?.id;
		if (typeof id !== "string" || id === "") return;
		if (markerValidity(branch, id).state !== "ok") return;
		out.push({
			nodeId: id,
			role: marker.role,
			files: uniquePaths([...marker.files, ...(marker.requires ?? [])]),
			mapPath: marker.mapPath,
			at: marker.at,
			entriesAfterMarker: branch.length - index - 1,
			compactedAfterMarker: false,
		});
	});
	return out;
}
