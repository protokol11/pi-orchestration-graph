// Run: node --test test/rewind.test.mjs
// The pure rewind decision and the parent-side file rewind (spec-5, R6 verdict).
import assert from "node:assert/strict";
import test from "node:test";
import { rewindSessionFile, rewindTarget, REWOUND_CUSTOM_TYPE } from "../core/rewind.ts";

const AT = "2026-10-18T02:00:00.000Z";

const msg = (id) => ({ id, type: "message" });
const marker = (id) => ({ id, type: "custom", customType: "load-ready" });
const anchor = (id) => ({ id, type: "custom", customType: REWOUND_CUSTOM_TYPE });
const compaction = (id) => ({ id, type: "compaction" });

test("rewindTarget: no marker → noop no-marker", () => {
	assert.deepEqual(rewindTarget([msg("a"), msg("b")]), { state: "noop", reason: "no-marker" });
});

test("rewindTarget: marker at the leaf → noop already-at-marker", () => {
	assert.deepEqual(rewindTarget([msg("a"), marker("m1")]), {
		state: "noop",
		reason: "already-at-marker",
		markerId: "m1",
	});
});

test("rewindTarget: entries after the marker → rewind with the count", () => {
	assert.deepEqual(rewindTarget([msg("a"), marker("m1"), msg("t1"), msg("t2")]), {
		state: "rewind",
		markerId: "m1",
		entriesAfterMarker: 2,
	});
});

test("rewindTarget: compaction above the marker → noop compacted", () => {
	assert.deepEqual(rewindTarget([msg("a"), marker("m1"), msg("t1"), compaction("c1")]), {
		state: "noop",
		reason: "compacted",
		markerId: "m1",
	});
});

test("rewindTarget: two markers — the latest wins", () => {
	assert.deepEqual(rewindTarget([marker("m1"), msg("t1"), marker("m2"), msg("t2")]), {
		state: "rewind",
		markerId: "m2",
		entriesAfterMarker: 1,
	});
});

test("rewindTarget: only anchors after the marker → noop already-rewound", () => {
	assert.deepEqual(rewindTarget([msg("a"), marker("m1"), anchor("r1")]), {
		state: "noop",
		reason: "already-rewound",
		markerId: "m1",
	});
});

// An in-memory session graph that mimics SessionManager: branch() moves the
// leaf pointer, appends land on the current branch, reopening recomputes the
// leaf as the last entry of the active branch's file order — the measured
// mechanics from warm-load P1/P3 and rewind-probe finding 1.
function graphSession(initialEntries) {
	const chained = initialEntries.map((entry, index) => ({
		...entry,
		parentId: index === 0 ? null : initialEntries[index - 1].id,
	}));
	const store = {
		entries: chained,
		leaf: chained.length ? chained[chained.length - 1].id : null,
	};
	return {
		store,
		getBranch() {
			const byId = new Map(store.entries.map((e) => [e.id, e]));
			const branch = [];
			let cursor = store.leaf;
			while (cursor && byId.has(cursor)) {
				const entry = byId.get(cursor);
				branch.unshift(entry);
				cursor = entry.parentId ?? null;
			}
			return branch;
		},
		getLeafId() {
			return store.leaf;
		},
		branch(entryId) {
			if (!store.entries.some((e) => e.id === entryId)) throw new Error(`Entry ${entryId} not found`);
			store.leaf = entryId;
		},
		appendCustomEntry(customType, data) {
			const id = `e${store.entries.length + 1}`;
			store.entries.push({ id, type: "custom", customType, data, parentId: store.leaf });
			store.leaf = id;
			return id;
		},
	};
}

test("rewindSessionFile: branch + anchor + verify, leaf lands on the anchor", () => {
	const session = graphSession([msg("a"), msg("b"), marker("m1"), msg("t1"), msg("t2")]);
	const result = rewindSessionFile("fake.jsonl", { open: () => session, at: AT });

	assert.equal(result.ok, true);
	assert.equal(result.rewound, true);
	assert.equal(result.markerId, "m1");
	assert.equal(result.entriesAfterMarker, 2);

	const branch = session.getBranch().map((e) => e.id);
	assert.deepEqual(branch, ["a", "b", "m1", result.anchorId]);
	assert.equal(session.getLeafId(), result.anchorId);

	// The anchor carries the durability payload.
	const anchorEntry = session.store.entries.find((e) => e.id === result.anchorId);
	assert.equal(anchorEntry.parentId, "m1");
	assert.equal(anchorEntry.data.markerId, "m1");
	assert.equal(anchorEntry.data.at, AT);
});

test("rewindSessionFile: a second call is a no-op (already-rewound)", () => {
	const session = graphSession([msg("a"), marker("m1"), msg("t1")]);
	const first = rewindSessionFile("fake.jsonl", { open: () => session, at: AT });
	assert.equal(first.rewound, true);

	const second = rewindSessionFile("fake.jsonl", { open: () => session, at: AT });
	assert.deepEqual(second, { ok: true, rewound: false, reason: "already-rewound", markerId: "m1" });
	assert.equal(session.store.entries.length, 4); // no extra anchor
});

test("rewindSessionFile: no marker → noop, nothing written", () => {
	const session = graphSession([msg("a"), msg("b")]);
	const result = rewindSessionFile("fake.jsonl", { open: () => session, at: AT });
	assert.deepEqual(result, { ok: true, rewound: false, reason: "no-marker" });
	assert.equal(session.store.entries.length, 2);
});

test("rewindSessionFile: compacted marker → noop compacted", () => {
	const session = graphSession([msg("a"), marker("m1"), msg("t1"), compaction("c1")]);
	const result = rewindSessionFile("fake.jsonl", { open: () => session, at: AT });
	assert.deepEqual(result, { ok: true, rewound: false, reason: "compacted", markerId: "m1" });
	assert.equal(session.store.entries.length, 4);
});

test("rewindSessionFile: reopen mismatch → lost-to-concurrent-writer", () => {
	// The verify open sees a different file where our anchor is not the leaf —
	// the P3 silent loss turned into a refusal.
	const writer = graphSession([msg("a"), marker("m1"), msg("t1")]);
	let opened = 0;
	const result = rewindSessionFile("fake.jsonl", {
		open: () => {
			opened++;
			return opened === 1 ? writer : graphSession([msg("x"), msg("y")]);
		},
		at: AT,
	});
	assert.deepEqual(result, { ok: false, reason: "lost-to-concurrent-writer", detail: result.detail });
});
