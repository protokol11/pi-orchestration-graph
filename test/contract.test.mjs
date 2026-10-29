// Run: node --test test/contract.test.mjs
// Shape, normalization and rejection cases for the load-ready marker (spec-2).
import assert from "node:assert/strict";
import test from "node:test";
import {
	LOAD_READY_CUSTOM_TYPE,
	MARKER_VERSION,
	WRITER_ID,
	markerAge,
	normalizePath,
	readMarker,
	uniquePaths,
	writeMarker,
} from "../core/contract.ts";

function fakeManager() {
	const calls = [];
	return {
		calls,
		appendCustomEntry(customType, data) {
			calls.push({ customType, data });
			return `entry-${calls.length}`;
		},
	};
}

function entryFrom(call, id = "entry-1") {
	return { type: "custom", id, customType: call.customType, data: call.data, timestamp: call.data.at };
}

const AT = "2026-10-17T21:49:58.555Z";

test("marker round-trips: write → tree entry → read returns identical fields", () => {
	const manager = fakeManager();
	const id = writeMarker(manager, {
		role: "explore",
		files: ["C:\\repo\\src\\a.ts", "C:/repo/src/./b.ts"],
		mapPath: "C:/repo/maps/load-map-explore.md",
		requires: ["C:/repo/src/a.ts"],
		at: AT,
	});

	assert.equal(id, "entry-1");
	assert.equal(manager.calls.length, 1);
	assert.equal(manager.calls[0].customType, LOAD_READY_CUSTOM_TYPE);

	const payload = readMarker(entryFrom(manager.calls[0], id));
	assert.deepEqual(payload, {
		v: MARKER_VERSION,
		role: "explore",
		files: ["C:/repo/src/a.ts", "C:/repo/src/b.ts"],
		mapPath: "C:/repo/maps/load-map-explore.md",
		requires: ["C:/repo/src/a.ts"],
		at: AT,
		by: WRITER_ID,
	});
});

test("readMarker rejects a different customType", () => {
	const entry = { type: "custom", customType: "other", data: { v: 1, role: "x", files: [], mapPath: "/m", at: AT } };
	assert.equal(readMarker(entry), undefined);
});

test("readMarker rejects a non-array files field", () => {
	const entry = { type: "custom", customType: LOAD_READY_CUSTOM_TYPE, data: { v: 1, role: "x", files: "a.ts", mapPath: "/m", at: AT } };
	assert.equal(readMarker(entry), undefined);
});

test("readMarker rejects a missing version", () => {
	const entry = { type: "custom", customType: LOAD_READY_CUSTOM_TYPE, data: { role: "x", files: ["a.ts"], mapPath: "/m", at: AT } };
	assert.equal(readMarker(entry), undefined);
});

test("readMarker rejects a future version instead of guessing", () => {
	const entry = { type: "custom", customType: LOAD_READY_CUSTOM_TYPE, data: { v: 2, role: "x", files: ["a.ts"], mapPath: "/m", at: AT } };
	assert.equal(readMarker(entry), undefined);
});

test("readMarker rejects a non-custom entry and a broken timestamp", () => {
	assert.equal(readMarker({ type: "message", customType: LOAD_READY_CUSTOM_TYPE, data: { v: 1 } }), undefined);
	const broken = { type: "custom", customType: LOAD_READY_CUSTOM_TYPE, data: { v: 1, role: "x", files: ["a.ts"], mapPath: "/m", at: "not-a-date" } };
	assert.equal(readMarker(broken), undefined);
	assert.equal(readMarker(null), undefined);
	assert.equal(readMarker(undefined), undefined);
});

test("normalizePath unifies separators and resolves dot segments", () => {
	assert.equal(normalizePath("C:\\repo\\src\\a.ts"), "C:/repo/src/a.ts");
	assert.equal(normalizePath("C:/repo/./src//a.ts"), "C:/repo/src/a.ts");
	assert.equal(normalizePath("C:/repo/src/../lib/a.ts"), "C:/repo/lib/a.ts");
	assert.equal(normalizePath("C:/repo/src/../../a.ts"), "C:/a.ts");
	assert.equal(normalizePath("/home/me/./a.ts"), "/home/me/a.ts");
	assert.equal(normalizePath(""), "");
});

test("normalizePath is idempotent", () => {
	const samples = ["C:\\repo\\a\\.\\b.ts", "C:/repo/../a.ts", "/tmp//x/../y.md", "relative/./path"];
	for (const sample of samples) {
		const once = normalizePath(sample);
		assert.equal(normalizePath(once), once, `not idempotent for ${sample}`);
	}
});

test("normalizePath preserves case (session files stay byte-faithful)", () => {
	assert.equal(normalizePath("C:/Repo/SRC/A.Ts"), "C:/Repo/SRC/A.Ts");
});

test("uniquePaths deduplicates after normalization", () => {
	assert.deepEqual(uniquePaths(["C:\\a\\b.ts", "C:/a/b.ts", "C:/a/./c.ts", ""]), ["C:/a/b.ts", "C:/a/c.ts"]);
});

test("markerAge is measured from the marker timestamp", () => {
	const manager = fakeManager();
	writeMarker(manager, { role: "coder", files: [], mapPath: "C:/m.md", at: AT });
	const age = markerAge(entryFrom(manager.calls[0]), Date.parse(AT) + 5000);
	assert.equal(age, 5000);
	assert.equal(markerAge({ type: "custom", customType: "other", data: {} }), undefined);
});

test("writeMarker refuses input it cannot represent", () => {
	const manager = fakeManager();
	assert.throws(() => writeMarker(manager, { role: "", files: [], mapPath: "C:/m.md" }), /role/);
	assert.throws(() => writeMarker(manager, { role: "coder", files: "a.ts", mapPath: "C:/m.md" }), /files/);
	assert.throws(() => writeMarker(manager, { role: "coder", files: [], mapPath: "" }), /mapPath/);
	assert.equal(manager.calls.length, 0);
});
