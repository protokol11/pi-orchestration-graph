// Run: node --test test/warm-load.test.mjs
// Map checks, duplicate refusal, post-write verification and the load prompt (spec-4).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendLoadMarker, checkLoadMap, loadPrompt } from "../core/warm-load.ts";

const AT = "2026-10-18T01:00:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "og-warm-load-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function mapWith(body) {
	const path = join(dir, `map-${Math.random().toString(36).slice(2)}.md`);
	writeFileSync(path, body);
	return path;
}

const GOOD_MAP = () => mapWith("# load-map — coder\n- read: C:/repo/src/a.ts\n  - contains: helpers\n  - symbols: a, b\n- gaps: none\n");
const NO_GAPS = () => mapWith("# load-map — coder\n- read: C:/repo/src/a.ts\n  - contains: helpers\n");

function fakeSession(entries = [], leaf = null) {
	const session = {
		entries,
		leaf,
		getBranch() {
			return session.entries;
		},
		getLeafId() {
			return session.leaf;
		},
		appendCustomEntry(customType, data) {
			const id = `m${session.entries.length + 1}`;
			session.entries = [...session.entries, { id, type: "custom", customType, data, parentId: session.leaf }];
			session.leaf = id;
			return id;
		},
	};
	return session;
}

function openAlways(sessionFactory) {
	return () => sessionFactory();
}

test("loadPrompt keeps the order, lists each path once, and names the map", () => {
	const prompt = loadPrompt(
		["C:\\repo\\b.ts", "C:/repo/a.ts", "C:/repo/./b.ts"],
		"C:\\repo\\maps\\load-map-coder-abcd1234.md",
		"coder"
	);
	const lines = prompt.split("\n");
	assert.equal(lines[0].startsWith("[load-only]"), true);
	assert.deepEqual(
		lines.filter((line) => /^\d+\.\s/.test(line)),
		["1. C:/repo/b.ts", "2. C:/repo/a.ts"]
	);
	assert.equal(prompt.includes("C:/repo/maps/load-map-coder-abcd1234.md"), true);
	assert.equal(prompt.includes("# load-map — coder"), true);
	assert.equal(prompt.includes("- gaps:"), true);
});

test("checkLoadMap reports a missing file", () => {
	assert.deepEqual(checkLoadMap(join(dir, "does-not-exist.md")), { ok: false, reason: "map-missing" });
});

test("checkLoadMap reports a map without gaps", () => {
	assert.deepEqual(checkLoadMap(NO_GAPS()), { ok: false, reason: "map-incomplete" });
});

test("checkLoadMap accepts a complete map", () => {
	assert.deepEqual(checkLoadMap(GOOD_MAP()), { ok: true });
});

test("appendLoadMarker refuses a missing map and writes nothing", () => {
	const session = fakeSession();
	const result = appendLoadMarker(
		"C:/fake/session.jsonl",
		{ role: "coder", files: ["C:/repo/a.ts"], mapPath: join(dir, "nope.md"), at: AT },
		{ open: openAlways(() => session) }
	);
	assert.deepEqual(result, { ok: false, reason: "map-missing", detail: join(dir, "nope.md").replace(/\\/g, "/") });
	assert.equal(session.entries.length, 0);
});

test("appendLoadMarker refuses an incomplete map", () => {
	const mapPath = NO_GAPS();
	const session = fakeSession();
	const result = appendLoadMarker(
		"C:/fake/session.jsonl",
		{ role: "coder", files: ["C:/repo/a.ts"], mapPath, at: AT },
		{ open: openAlways(() => session) }
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "map-incomplete");
	assert.equal(session.entries.length, 0);
});

test("appendLoadMarker writes one marker parented to the previous leaf", () => {
	const mapPath = GOOD_MAP();
	const session = fakeSession([{ id: "u1", type: "message" }], "u1");
	const result = appendLoadMarker(
		"C:/fake/session.jsonl",
		{ role: "coder", files: ["C:\\repo\\a.ts", "C:/repo/./a.ts"], mapPath, at: AT },
		{ open: openAlways(() => session) }
	);

	assert.equal(result.ok, true);
	assert.equal(result.markerId, "m2");
	assert.deepEqual(result.payload.files, ["C:/repo/a.ts"]);
	assert.equal(result.payload.mapPath, mapPath.replace(/\\/g, "/"));
	assert.equal(result.payload.at, AT);
	assert.equal(session.entries[1].parentId, "u1");
});

test("appendLoadMarker refuses a duplicate and adds no entry", () => {
	const mapPath = GOOD_MAP();
	const session = fakeSession();
	const input = { role: "coder", files: ["C:/repo/a.ts"], mapPath, at: AT };
	const open = openAlways(() => session);

	assert.equal(appendLoadMarker("C:/fake/session.jsonl", input, { open }).ok, true);
	const afterFirst = session.entries.length;

	const second = appendLoadMarker("C:/fake/session.jsonl", input, { open });
	assert.equal(second.ok, false);
	assert.equal(second.reason, "duplicate");
	assert.equal(session.entries.length, afterFirst);
});

test("appendLoadMarker reports lost-to-concurrent-writer when the reopen leaf moved", () => {
	const mapPath = GOOD_MAP();
	const writer = fakeSession();
	const staleView = fakeSession([{ id: "other", type: "message" }], "other");
	let call = 0;
	const open = () => {
		call++;
		return call === 1 ? writer : staleView;
	};

	const result = appendLoadMarker(
		"C:/fake/session.jsonl",
		{ role: "coder", files: ["C:/repo/a.ts"], mapPath, at: AT },
		{ open }
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "lost-to-concurrent-writer");
	assert.equal(result.detail, "m1");
});

test("appendLoadMarker rejects input it cannot represent", () => {
	const mapPath = GOOD_MAP();
	const session = fakeSession();
	const open = openAlways(() => session);
	assert.equal(appendLoadMarker("C:/s.jsonl", { role: "", files: ["a"], mapPath }, { open }).reason, "invalid-input");
	assert.equal(appendLoadMarker("C:/s.jsonl", { role: "coder", files: [], mapPath }, { open }).reason, "invalid-input");
	assert.equal(appendLoadMarker("C:/s.jsonl", { role: "coder", files: ["a"], mapPath: "" }, { open }).reason, "invalid-input");
	assert.equal(session.entries.length, 0);
});
