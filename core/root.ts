// write root — the declared boundary that makes stray writes visible (spec-9).
//
// One bounded scan before a batch, one after, one classification per changed
// path. Set membership is what this module proves: `own | other-declared |
// undeclared`. It never claims authorship — two children in one tree leave no
// trace of who wrote a file.
//
// The surface is deliberately three exports (`scanRoot`, `diffScan`,
// `classifyChange`); `sha256File` stays internal because every caller needs the
// same hash and none needs to choose another.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isInsideRoot, normalizePath, resolvePlanPath } from "./contract.ts";
import type { Plan } from "./plan.ts";

export type ScannedFile = {
	/** `null` for a symlink: recorded by path, never followed. */
	hash: string | null;
	size: number;
};

export type RootScan = {
	root: string;
	files: Map<string, ScannedFile>;
	count: number;
	bytes: number;
	truncated: boolean;
};

export type ScanOptions = {
	maxFiles?: number;
	maxBytes?: number;
	ignore?: string[];
	/** Injected so the bounded walk is testable without hashing real bytes. */
	hashOf?: (path: string) => string;
};

export type ChangeKind = "own" | "other-declared" | "undeclared";
export type Change = {
	path: string;
	kind: ChangeKind;
	change: "added" | "modified" | "deleted";
};

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
// Name entries match any directory/file name; path entries (relative to the
// root) match one subtree. `.pi/orchestration-graph/` is the pool's own run
// state — spec-9 calls it infrastructure, not a child's output, so the pool
// must not report itself as stray in every verdict.
const DEFAULT_IGNORE = [".git", "node_modules", ".pi/orchestration-graph"];

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Iterative, sorted, bounded walk. The bound is a flag, never an exception:
 * exceeding it yields `truncated: true` and the caller degrades to `skipped`
 * (spec-9 decision 6).
 */
export function scanRoot(root: string, options: ScanOptions = {}): RootScan {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
	const hashOf = options.hashOf ?? sha256File;

	const normalizedRoot = normalizePath(root);
	const files = new Map<string, ScannedFile>();
	let count = 0;
	let bytes = 0;
	let truncated = false;

	const stack = [normalizedRoot];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // absent root is legal: a first run has nothing to scan
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			const full = `${dir}/${entry.name}`;
			const relative = full.slice(normalizedRoot.length + 1);
			if (ignore.has(entry.name) || ignore.has(relative)) continue;

			if (entry.isSymbolicLink()) {
				files.set(full, { hash: null, size: 0 });
				continue;
			}
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;

			if (count + 1 > maxFiles) return { root: normalizedRoot, files, count, bytes, truncated: true };

			let size = 0;
			try {
				size = lstatSync(full).size;
			} catch {
				continue;
			}
			if (bytes + size > maxBytes) return { root: normalizedRoot, files, count, bytes, truncated: true };

			files.set(full, { hash: hashOf(full), size });
			count++;
			bytes += size;
		}
	}

	return { root: normalizedRoot, files, count, bytes, truncated };
}

/**
 * A changed path belongs to exactly one bucket, decided by its target: a batch
 * node's `writes` (`own`), another node's `writes` (`other-declared`), or
 * nobody's (`undeclared`).
 */
export function classifyChange(path: string, plan: Plan, batchIds: Iterable<string>, cwd = process.cwd()): ChangeKind {
	const target = normalizePath(path);
	const batch = new Set(batchIds);

	for (const node of plan.nodes) {
		for (const write of node.writes) {
			if (resolvePlanPath(cwd, write) !== target) continue;
			return batch.has(node.id) ? "own" : "other-declared";
		}
	}
	return "undeclared";
}

/** Every content change between two scans, classified. Paths are sorted. */
export function diffScan(
	before: RootScan,
	after: RootScan,
	plan: Plan,
	batchIds: Iterable<string>,
	options: { cwd?: string } = {}
): Change[] {
	const cwd = options.cwd ?? process.cwd();
	const batch = new Set(batchIds);
	const changes: Change[] = [];

	for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
		const previous = before.files.get(path);
		const current = after.files.get(path);
		let change: Change["change"] | null = null;
		if (!previous && current) change = "added";
		else if (previous && !current) change = "deleted";
		else if (previous && current && previous.hash !== current.hash) change = "modified";
		if (change === null) continue;
		if (!isInsideRoot(after.root, path) && !isInsideRoot(before.root, path)) continue;
		changes.push({ path, kind: classifyChange(path, plan, batch, cwd), change });
	}

	return changes.sort((a, b) => a.path.localeCompare(b.path));
}
