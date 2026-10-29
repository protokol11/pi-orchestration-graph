// candidatesFromBranch — markers on a branch become rank candidates (spec-3).
// Mirrors the harness path: the same getBranch() dump the harness feeds headless.
import assert from "node:assert/strict";
import test from "node:test";
import { candidatesFromBranch } from "../core/candidates.ts";
import { writeMarker } from "../core/contract.ts";

function fakeSession() {
	const entries = [];
	return {
		entries,
		getBranch: () => entries,
		getLeafId: () => (entries.length > 0 ? entries[entries.length - 1].id : null),
		appendCustomEntry: (customType, data) => {
			const id = `e${entries.length}`;
			entries.push({ id, type: "custom", customType, data });
			return id;
		},
	};
}

test("two valid markers become two candidates with held-file union", () => {
	const session = fakeSession();
	writeMarker(session, { role: "coder", files: ["a.ts", "b.ts"], requires: ["c.ts"], mapPath: "m1.md", at: "2026-10-22T00:00:00Z" });
	writeMarker(session, { role: "reviewer", files: ["d.ts"], mapPath: "m2.md", at: "2026-10-22T00:01:00Z" });

	const pool = candidatesFromBranch(session.getBranch());
	assert.equal(pool.length, 2);
	assert.equal(pool[0].nodeId, "e0");
	assert.equal(pool[0].role, "coder");
	assert.deepEqual(pool[0].files, ["a.ts", "b.ts", "c.ts"]);
	assert.equal(pool[0].compactedAfterMarker, false);
	assert.equal(pool[0].entriesAfterMarker, 1);
	assert.equal(pool[1].role, "reviewer");
});

test("a compaction entry after the marker drops it from the pool", () => {
	const session = fakeSession();
	writeMarker(session, { role: "coder", files: ["a.ts"], mapPath: "m1.md", at: "2026-10-22T00:00:00Z" });
	session.entries.push({ id: "comp1", type: "compaction" });

	const pool = candidatesFromBranch(session.getBranch());
	assert.equal(pool.length, 0);
});

test("non-marker and id-less entries are skipped; non-array branch tolerated", () => {
	const session = fakeSession();
	session.entries.push({ id: "x1", type: "message" });
	session.entries.push({ type: "custom", customType: "other", data: {} });
	writeMarker(session, { role: "coder", files: ["a.ts"], mapPath: "m1.md", at: "2026-10-22T00:00:00Z" });

	assert.equal(candidatesFromBranch(session.getBranch()).length, 1);
	assert.deepEqual(candidatesFromBranch(undefined), []);
});
