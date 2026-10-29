// load-ready contract — one marker shape, one normalizer (spec-2).
//
// The marker is a `custom` session entry: durable in the tree, absent from model
// context, so it costs no prompt tokens. It exists because a retained
// `pi-subagents` resume cannot receive `extensionBindings` — role, files and map
// path must live inside the entry itself.
//
// Structural types only: the writer takes anything with appendCustomEntry(), so
// the contract is testable without a live session.

export const LOAD_READY_CUSTOM_TYPE = "load-ready";
export const MARKER_VERSION = 1;
export const WRITER_ID = "orchestration-graph/1";

export type LoadReadyPayload = {
	v: typeof MARKER_VERSION;
	role: string;
	files: string[];
	mapPath: string;
	requires?: string[];
	at: string;
	by: string;
};

export type MarkerInput = {
	role: string;
	files: string[];
	mapPath: string;
	requires?: string[];
	/** Defaults to the current time; injected by tests and by the harness-owned writer. */
	at?: string;
};

export type MarkerEntry = {
	type?: string;
	id?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
};

export type MarkerWriter = {
	appendCustomEntry(customType: string, data?: unknown): string;
};

/**
 * Unify separators and resolve "." / ".." segments. Case is preserved: Windows
 * paths are case-insensitive, but the session file should stay byte-faithful.
 * Idempotent — normalizePath(normalizePath(p)) === normalizePath(p).
 */
export function normalizePath(input: string): string {
	if (typeof input !== "string") return "";
	const unified = input.trim().replace(/\\/g, "/");
	if (unified === "") return "";

	const drive = /^([A-Za-z]:)(\/|$)/.exec(unified);
	const root = drive ? `${drive[1]}/` : unified.startsWith("/") ? "/" : "";
	const rest = drive ? unified.slice(drive[1].length) : unified;

	const segments: string[] = [];
	for (const segment of rest.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	const body = segments.join("/");
	if (root === "") return body === "" ? "." : body;
	return body === "" ? root : `${root}${body}`;
}

/** The two absolute shapes plans use: `C:/…` and `/…`. */
export function isAbsolutePath(path: string): boolean {
	return /^[A-Za-z]:\//.test(path) || path.startsWith("/");
}

/**
 * A plan path is absolute or relative to the project root. `lintPlan`, the
 * dispatcher and the root scan must agree on that base, so this is the one
 * resolver (spec-9 decision 1).
 */
export function resolvePlanPath(cwd: string, path: string): string {
	return normalizePath(isAbsolutePath(path) ? path : `${normalizePath(cwd)}/${path}`);
}

/**
 * Segment-aware containment: `C:/a/b` contains `C:/a/b/c.md`, never
 * `C:/a/bc/d.md`. Both sides are normalized first.
 */
export function isInsideRoot(root: string, path: string): boolean {
	const normalizedRoot = normalizePath(root);
	const normalizedPath = normalizePath(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Normalized, deduplicated, order-preserving. */
export function uniquePaths(paths: string[]): string[] {
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
 * Append the marker and return its entry id. Never writes messages, never
 * triggers a turn.
 */
export function writeMarker(manager: MarkerWriter, input: MarkerInput): string {
	if (!manager || typeof manager.appendCustomEntry !== "function") {
		throw new TypeError("writeMarker: manager must expose appendCustomEntry()");
	}
	if (typeof input.role !== "string" || input.role === "") {
		throw new TypeError("writeMarker: role must be a non-empty string");
	}
	if (!Array.isArray(input.files)) {
		throw new TypeError("writeMarker: files must be an array");
	}
	if (typeof input.mapPath !== "string" || input.mapPath === "") {
		throw new TypeError("writeMarker: mapPath must be a non-empty string");
	}

	const payload: LoadReadyPayload = {
		v: MARKER_VERSION,
		role: input.role,
		files: uniquePaths(input.files),
		mapPath: normalizePath(input.mapPath),
		at: input.at ?? new Date().toISOString(),
		by: WRITER_ID,
	};
	if (input.requires !== undefined) payload.requires = uniquePaths(input.requires);

	return manager.appendCustomEntry(LOAD_READY_CUSTOM_TYPE, payload);
}

/**
 * Read a marker. Returns undefined for anything that is not a `custom` entry of
 * our type at our version — unknown versions are skipped, never guessed.
 */
export function readMarker(entry: unknown): LoadReadyPayload | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as MarkerEntry;
	if (candidate.type !== "custom") return undefined;
	if (candidate.customType !== LOAD_READY_CUSTOM_TYPE) return undefined;

	const data = candidate.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const fields = data as Record<string, unknown>;

	if (fields.v !== MARKER_VERSION) return undefined;
	if (typeof fields.role !== "string" || fields.role === "") return undefined;
	if (!isStringArray(fields.files)) return undefined;
	if (typeof fields.mapPath !== "string" || fields.mapPath === "") return undefined;
	if (typeof fields.at !== "string" || Number.isNaN(Date.parse(fields.at))) return undefined;
	if (fields.requires !== undefined && !isStringArray(fields.requires)) return undefined;
	if (fields.by !== undefined && typeof fields.by !== "string") return undefined;

	const payload: LoadReadyPayload = {
		v: MARKER_VERSION,
		role: fields.role,
		files: uniquePaths(fields.files),
		mapPath: normalizePath(fields.mapPath),
		at: fields.at,
		by: typeof fields.by === "string" ? fields.by : WRITER_ID,
	};
	if (fields.requires !== undefined) payload.requires = uniquePaths(fields.requires);
	return payload;
}

/** Age of a marker in milliseconds; undefined when it is not a marker. */
export function markerAge(entry: unknown, now: number = Date.now()): number | undefined {
	const marker = readMarker(entry);
	if (!marker) return undefined;
	return now - Date.parse(marker.at);
}
