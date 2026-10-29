// warm-load — create the reuse point: a [load-only] turn, a map, and a marker
// appended by the parent once the run is terminal (spec-4).
//
// The parent writes; the child never sees the marker. Two measured facts shape
// this module:
//   1. a marker appended to a closed session is a real tree entry (P1), so the
//      leaf after the append is the point wave 3 rewinds to;
//   2. two open managers do NOT error — the earlier entry silently leaves the
//      active branch (P3), so the append is verified by reopening the file.

import { readFileSync } from "node:fs";
import { normalizePath, readMarker, uniquePaths, writeMarker, type LoadReadyPayload } from "./contract.ts";

export type MapCheck = { ok: true } | { ok: false; reason: "map-missing" | "map-incomplete" };

export type MarkerEntryView = {
	id: string;
	type?: string;
	customType?: string;
	data?: unknown;
	parentId?: string | null;
};

export type MarkerSession = {
	getBranch(): MarkerEntryView[];
	getLeafId(): string | null;
	appendCustomEntry(customType: string, data?: unknown): string;
};

export type OpenMarkerSession = (sessionFile: string) => MarkerSession;

export type AppendInput = {
	role: string;
	/** The same array that built the prompt: declared paths, not the tool-call log. */
	files: string[];
	mapPath: string;
	requires?: string[];
	at?: string;
};

export type AppendFailureReason =
	| "invalid-input"
	| "map-missing"
	| "map-incomplete"
	| "duplicate"
	| "lost-to-concurrent-writer";

export type AppendResult =
	| { ok: true; markerId: string; payload: LoadReadyPayload }
	| { ok: false; reason: AppendFailureReason; detail?: string };

/**
 * A map without `read:` lines or without `gaps:` cannot support `holds`: the
 * first means nothing was loaded, the second hides truncation at the window cap.
 */
export function checkLoadMap(mapPath: string): MapCheck {
	let text: string;
	try {
		text = readFileSync(mapPath, "utf-8");
	} catch {
		return { ok: false, reason: "map-missing" };
	}
	const hasRead = /^\s*-\s*read:/m.test(text);
	const hasGaps = /^\s*-\s*gaps:/m.test(text);
	if (!hasRead || !hasGaps) return { ok: false, reason: "map-incomplete" };
	return { ok: true };
}

/** The `[load-only]` prompt. Same `paths` array must be handed to `appendLoadMarker`. */
export function loadPrompt(paths: string[], mapPath: string, role: string): string {
	const files = uniquePaths(paths);
	const list = files.map((path, index) => `${index + 1}. ${path}`).join("\n");
	return [
		"[load-only] Do not start a task. Do not edit any file except the map.",
		"",
		"Read exactly these files:",
		list,
		"",
		`Then write ${normalizePath(mapPath)} in this format and nothing else:`,
		`# load-map — ${role}`,
		"- read: <path>",
		"  - contains: <one line>",
		'  - symbols: <comma list or "n/a">',
		"- gaps: <what you did NOT read and why>",
	].join("\n");
}

/**
 * Append the marker to a terminal child session and prove it landed.
 *
 * Order matters: map check → duplicate scan → write → reopen and require the
 * leaf to be the new marker. The last step is the only defence against the
 * silent concurrent-writer loss (P3).
 */
export function appendLoadMarker(
	sessionFile: string,
	input: AppendInput,
	options: { open: OpenMarkerSession; checkMap?: boolean }
): AppendResult {
	if (!input || typeof input.role !== "string" || input.role === "") {
		return { ok: false, reason: "invalid-input", detail: "role" };
	}
	if (!Array.isArray(input.files) || input.files.length === 0) {
		return { ok: false, reason: "invalid-input", detail: "files" };
	}
	if (typeof input.mapPath !== "string" || input.mapPath === "") {
		return { ok: false, reason: "invalid-input", detail: "mapPath" };
	}

	const mapPath = normalizePath(input.mapPath);
	if (options.checkMap !== false) {
		const map = checkLoadMap(input.mapPath);
		if (!map.ok) return { ok: false, reason: map.reason, detail: mapPath };
	}

	const files = uniquePaths(input.files);
	let session: MarkerSession;
	try {
		session = options.open(sessionFile);
	} catch (error) {
		return { ok: false, reason: "invalid-input", detail: error instanceof Error ? error.message : String(error) };
	}

	const duplicate = session.getBranch().find((entry) => {
		const marker = readMarker(entry);
		return marker !== undefined && marker.role === input.role && marker.mapPath === mapPath;
	});
	if (duplicate) return { ok: false, reason: "duplicate", detail: duplicate.id };

	const markerId = writeMarker(session, {
		role: input.role,
		files,
		mapPath,
		...(input.requires ? { requires: input.requires } : {}),
		...(input.at ? { at: input.at } : {}),
	});

	// Reopen: never trust the writer's own view (a stale manager keeps appending
	// to its cached leaf and the marker becomes a sibling branch).
	const verify = options.open(sessionFile);
	if (verify.getLeafId() !== markerId) {
		return { ok: false, reason: "lost-to-concurrent-writer", detail: markerId };
	}
	const payload = readMarker(verify.getBranch().find((entry) => entry.id === markerId));
	if (!payload) return { ok: false, reason: "lost-to-concurrent-writer", detail: markerId };

	return { ok: true, markerId, payload };
}
