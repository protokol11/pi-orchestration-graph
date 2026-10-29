// Run: node --test core/validity.test.mjs
// Three codes: ok / compacted / missing (spec-4, decision 7).
import assert from "node:assert/strict";
import test from "node:test";
import { markerValidity } from "./validity.ts";

const branch = (...entries) => entries.map(([id, type]) => ({ id, type }));

test("a marker with a raw branch after it is ok", () => {
	const rows = branch(["u1", "message"], ["m1", "custom"], ["u2", "message"]);
	assert.deepEqual(markerValidity(rows, "m1"), { state: "ok" });
});

test("a compaction above the marker invalidates it", () => {
	const rows = branch(["u1", "message"], ["m1", "custom"], ["u2", "message"], ["c1", "compaction"]);
	assert.deepEqual(markerValidity(rows, "m1"), { state: "compacted", by: "c1" });
});

test("a compaction below the marker does not invalidate it", () => {
	const rows = branch(["c1", "compaction"], ["m1", "custom"], ["u2", "message"]);
	assert.deepEqual(markerValidity(rows, "m1"), { state: "ok" });
});

test("an unknown marker id is missing", () => {
	assert.deepEqual(markerValidity(branch(["u1", "message"]), "nope"), { state: "missing" });
	assert.deepEqual(markerValidity([], "nope"), { state: "missing" });
});
