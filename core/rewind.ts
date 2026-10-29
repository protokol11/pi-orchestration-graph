// rewind — return a used child to its load point, parent-side (spec-5, R6 verdict 2026-10-18).
//
// No hook: the parent rewinds the child's file lazily, before resume. Three
// measured facts shape this module (`.scratch/rewind-probe/NOTES.md`):
//   1. a bare tree move is in-memory only — `SessionManager` recomputes the leaf
//      as the last file line on open — so a rewind is `branch(markerId)` plus an
//      `og-rewound` anchor append; the anchor IS the durability mechanism;
//   2. two open managers on one file fail silently (warm-load P3), so the anchor
//      is verified by reopening, same pattern as `appendLoadMarker`;
//   3. `agent_settled`/`agent_before_settle` contexts carry no tree actions
//      (types.d.ts: actions are command-context only), which is why there is no
//      self-rewind hook at all.
import { LOAD_READY_CUSTOM_TYPE, WRITER_ID } from "./contract.ts";
import { markerValidity, type ValidityEntry } from "./validity.ts";

export const REWOUND_CUSTOM_TYPE = "og-rewound";
export const REWOUND_VERSION = 1;

export type RewindEntry = ValidityEntry & { customType?: string };

export type RewindTarget =
	| { state: "rewind"; markerId: string; entriesAfterMarker: number }
	| {
			state: "noop";
			reason: "no-marker" | "compacted" | "already-at-marker" | "already-rewound";
			markerId?: string;
	  };

/**
 * Pure decision: is there a rewind to perform on this branch, and to where.
 * The latest `load-ready` marker wins; `markerValidity` decides if it is raw;
 * a branch whose post-marker entries are only `og-rewound` anchors is already
 * rewound (idempotent — a second call must be a no-op).
 */
export function rewindTarget(branch: RewindEntry[]): RewindTarget {
	let markerIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].customType === LOAD_READY_CUSTOM_TYPE) {
			markerIndex = i;
			break;
		}
	}
	if (markerIndex === -1) return { state: "noop", reason: "no-marker" };

	const markerId = branch[markerIndex].id;
	const validity = markerValidity(branch, markerId);
	if (validity.state === "compacted") return { state: "noop", reason: "compacted", markerId };

	const after = branch.slice(markerIndex + 1);
	if (after.length === 0) return { state: "noop", reason: "already-at-marker", markerId };
	if (after.every((entry) => entry.customType === REWOUND_CUSTOM_TYPE)) {
		return { state: "noop", reason: "already-rewound", markerId };
	}
	return { state: "rewind", markerId, entriesAfterMarker: after.length };
}

/** Structural: the real SessionManager satisfies this; tests fake it. */
export type RewindSession = {
	getBranch(): RewindEntry[];
	getLeafId(): string | null;
	/** SessionManager.branch — move the leaf pointer to an earlier entry. */
	branch(entryId: string): void;
	appendCustomEntry(customType: string, data?: unknown): string;
};

export type OpenRewindSession = (sessionFile: string) => RewindSession;

export type RewindResult =
	| { ok: true; rewound: true; markerId: string; anchorId: string; entriesAfterMarker: number }
	| { ok: true; rewound: false; reason: "no-marker" | "compacted" | "already-at-marker" | "already-rewound"; markerId?: string }
	| { ok: false; reason: "lost-to-concurrent-writer"; detail?: string };

/**
 * Lazy rewind of a terminal child session. Call only when the child is not
 * running (the P3 rule: a write racing a live manager is lost, not rejected).
 *
 * Move, anchor, reopen, verify — never trust the writer's own view.
 */
export function rewindSessionFile(
	sessionFile: string,
	options: { open: OpenRewindSession; at?: string }
): RewindResult {
	let session: RewindSession;
	try {
		session = options.open(sessionFile);
	} catch (error) {
		return { ok: false, reason: "lost-to-concurrent-writer", detail: error instanceof Error ? error.message : String(error) };
	}

	const target = rewindTarget(session.getBranch());
	if (target.state === "noop") {
		return target.markerId === undefined
			? { ok: true, rewound: false, reason: target.reason }
			: { ok: true, rewound: false, reason: target.reason, markerId: target.markerId };
	}

	session.branch(target.markerId);
	const anchorId = session.appendCustomEntry(REWOUND_CUSTOM_TYPE, {
		v: REWOUND_VERSION,
		markerId: target.markerId,
		at: options.at ?? new Date().toISOString(),
		by: WRITER_ID,
	});

	// Reopen and require: leaf is the anchor and everything after the marker is
	// anchors. Anything else means a concurrent writer won the race (P3).
	const verify = options.open(sessionFile);
	const branch = verify.getBranch();
	const markerIndex = branch.findIndex((entry) => entry.id === target.markerId);
	const after = markerIndex === -1 ? [] : branch.slice(markerIndex + 1);
	if (
		verify.getLeafId() !== anchorId ||
		after.length === 0 ||
		!after.every((entry) => entry.customType === REWOUND_CUSTOM_TYPE)
	) {
		return { ok: false, reason: "lost-to-concurrent-writer", detail: anchorId };
	}

	return {
		ok: true,
		rewound: true,
		markerId: target.markerId,
		anchorId,
		entriesAfterMarker: target.entriesAfterMarker,
	};
}
