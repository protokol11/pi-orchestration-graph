// orchestration-graph — wave 3 entry point.
//
// Nothing here is model-facing: no tools, no context injection, no turns. The
// commands are parent-facing ops and diagnostics; wave 4 calls the exported
// functions from the dispatcher.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readMarker } from "./core/contract.ts";
import {
	appendRunLog,
	buildTaskText,
	DEFAULT_MAX_ATTEMPTS,
	deriveDone,
	fsProbe,
	mapFromNode,
	nextStep,
	renderLoadMap,
	runLogPath,
	sizeProbe,
} from "./core/dispatcher.ts";
import { resolvePlanPath } from "./core/contract.ts";
import { defaultMapPath, dispatchable, ensureOgDirs, lintPlan, ogDirs, type Plan } from "./core/plan.ts";
import {
	applyPatch,
	classifyPatch,
	findRepoRoot,
	parsePatchPaths,
	type PatchClass,
} from "./core/isolation.ts";
import {
	attemptsPath,
	bumpAttempts,
	clearAttempts,
	nextBatch,
	readAttempts,
	settleWarnings,
	verifyBatch,
	type Batch,
	type PathSnapshot,
	type Refusal,
} from "./core/pool.ts";
import { scanRoot, type RootScan } from "./core/root.ts";
import { buildRfitQuestions, mapVerdicts, type CatalogEntry, type RfitVerdict } from "./core/rfit.ts";
import { rewindSessionFile, type RewindSession } from "./core/rewind.ts";
import { candidatesFromBranch } from "./core/candidates.ts";
import { markerValidity } from "./core/validity.ts";
import { appendLoadMarker, type MarkerSession } from "./core/warm-load.ts";

export { appendLoadMarker, checkLoadMap, loadPrompt } from "./core/warm-load.ts";
export { markerValidity } from "./core/validity.ts";
export { rewindSessionFile, rewindTarget } from "./core/rewind.ts";
export { candidatesFromBranch } from "./core/candidates.ts";
export { dispatchable, fitPaths, lintPlan } from "./core/plan.ts";
export {
	buildTaskText,
	deriveDone,
	disjointWriteSets,
	mapFromNode,
	nextStep,
	writeCollisions,
} from "./core/dispatcher.ts";

export { nextBatch, verifyBatch } from "./core/pool.ts";
export { bandOf, buildRfitQuestions, familyOf, mapVerdicts } from "./core/rfit.ts";
export { checkRepoClean, classifyPatch, applyPatch, findRepoRoot } from "./core/isolation.ts";

type SerializedScan = {
	root: string;
	count: number;
	bytes: number;
	truncated: boolean;
	files: Array<[string, { hash: string | null; size: number }]>;
};

type BatchStateFile = {
	batch: { ids: string[]; deferred: Refusal[]; widthCap: number; snapshot: PathSnapshot[] };
	scan: SerializedScan;
	at: string;
};

function serializeScan(scan: RootScan): SerializedScan {
	return {
		root: scan.root,
		count: scan.count,
		bytes: scan.bytes,
		truncated: scan.truncated,
		files: [...scan.files.entries()],
	};
}

function deserializeScan(data: SerializedScan): RootScan {
	return {
		root: data.root,
		count: data.count,
		bytes: data.bytes,
		truncated: data.truncated,
		files: new Map(data.files),
	};
}

/** Audit state for the post-batch verdict. Scheduling never reads it (spec-7 decision 8). */
function readBatchState(path: string): { batch: BatchStateFile["batch"]; scan: RootScan } | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as BatchStateFile;
		if (!parsed || typeof parsed !== "object" || !parsed.batch || !Array.isArray(parsed.batch.ids) || !parsed.scan) return null;
		return { batch: parsed.batch, scan: deserializeScan(parsed.scan) };
	} catch {
		return null;
	}
}

/**
 * spec-14 catalog injection. The catalog is injected, never discovered by the
 * pure modules: this reader is the seam, and it accepts the two shapes a
 * producer writes — `[{ role, holds }]` and `{ role: holds[] }`.
 */
function readCatalog(path: string): CatalogEntry[] | undefined {
	const holdsOf = (value: unknown): string[] => {
		if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
		const nested = value && typeof value === "object" ? (value as { holds?: unknown }).holds : undefined;
		return Array.isArray(nested) ? nested.filter((item): item is string => typeof item === "string") : [];
	};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (Array.isArray(parsed)) {
			return parsed
				.filter((entry): entry is { role: string } => Boolean(entry) && typeof entry === "object" && typeof (entry as { role?: unknown }).role === "string")
				.map((entry) => ({ role: entry.role, holds: holdsOf(entry) }));
		}
		if (parsed && typeof parsed === "object") {
			return Object.entries(parsed as Record<string, unknown>).map(([role, value]) => ({ role, holds: holdsOf(value) }));
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** `/og-band <plan> [--catalog <file>] [--verdicts <json>]`; verdicts take the rest of the line. */
function splitBandArgs(raw: string): { plan: string; catalog?: string; verdicts?: string } {
	const at = raw.indexOf("--verdicts");
	const head = at === -1 ? raw : raw.slice(0, at);
	const tail = at === -1 ? "" : raw.slice(at + "--verdicts".length).trim();
	// Verdicts take the rest of the line. A quoted value ends at its closing quote,
	// so `/og-band p.md --verdicts '{"k": ...}'` works as typed.
	const quoted = /^(['"])([\s\S]*?)\1/.exec(tail);
	const tokens = head.trim().split(/\s+/).filter(Boolean);
	const rest: string[] = [];
	let catalog: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--catalog") {
			catalog = tokens[++i];
			continue;
		}
		rest.push(tokens[i]);
	}
	return {
		plan: rest.join(" "),
		...(catalog !== undefined ? { catalog } : {}),
		...(tail !== "" ? { verdicts: quoted ? quoted[2] : tail } : {}),
	};
}

/** `--verdicts` takes inline JSON or a path; the mapping stays in `core/rfit.ts`. */
function readVerdicts(value: string): Record<string, RfitVerdict> | undefined {
	const text = value.trim();
	const raw = text.startsWith("{") ? text : (() => {
		try {
			return readFileSync(text, "utf-8");
		} catch {
			return "";
		}
	})();
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RfitVerdict>) : undefined;
	} catch {
		return undefined;
	}
}

/** One `runs.all` call for the batch: stable keys, one item per node. */
function renderRunsAll(plan: Plan, batch: Batch): string {
	const items = batch.ids.map((id) => {
		const node = plan.nodes.find((candidate) => candidate.id === id)!;
		const task = buildTaskText(node).trimEnd();
		return `  { key: ${JSON.stringify(id)}, agent: ${JSON.stringify(node.role)}, task: ${JSON.stringify(task)} },`;
	});
	return [`const results = await runs.all([`, ...items, `]);`, `// results[i] is ordered like the ids above; it is an array, not a key map.`].join("\n");
}

export default function orchestrationGraph(pi: ExtensionAPI): void {
	pi.registerCommand("og-markers", {
		description: "List load-ready markers on the current branch (diagnostic)",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const markers = branch.map((entry) => ({ entry, marker: readMarker(entry) })).filter((row) => row.marker);

			if (markers.length === 0) {
				ctx.ui.notify("og: no load-ready markers on this branch", "info");
				return;
			}

			const lines = markers.map(({ entry, marker }) => {
				const validity = markerValidity(branch, entry.id).state;
				return `${entry.id} ${marker!.role} ${marker!.files.length}f ${validity}`;
			});
			ctx.ui.notify(`og: ${lines.join(" | ")}`, "info");
		},
	});

	pi.registerCommand("og-rewind", {
		description: "Rewind a child session file to its latest load-ready marker (parent-side)",
		handler: async (args, ctx) => {
			const sessionFile = (args ?? "").trim();
			if (!sessionFile) {
				ctx.ui.notify("og: usage /og-rewind <sessionFile>", "warning");
				return;
			}
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const result = rewindSessionFile(sessionFile, {
				open: (file) => SessionManager.open(file) as unknown as RewindSession,
			});
			if (!result.ok) {
				ctx.ui.notify(`og: rewind refused (${result.reason}) ${result.detail ?? ""}`, "error");
				return;
			}
			if (!result.rewound) {
				ctx.ui.notify(`og: nothing to rewind (${result.reason})`, "info");
				return;
			}
			ctx.ui.notify(
				`og: rewound → ${result.markerId} (anchor ${result.anchorId}, ${result.entriesAfterMarker} entries dropped from the window)`,
				"info"
			);
		},
	});

	pi.registerCommand("og-plan", {
		description: "Lint a plan file (or the whole plans/ dir without an argument); --strict promotes write ⊆ task-text to an error",
		handler: async (args, ctx) => {
			const strict = (args ?? "").includes("--strict");
			const target = (args ?? "").replace("--strict", "").trim();
			const files: Array<{ name: string; text: string }> = [];
			try {
				if (target) {
					files.push({ name: target, text: readFileSync(target, "utf-8") });
				} else {
					const plansDir = ogDirs(ctx.cwd).plans;
					for (const entry of readdirSync(plansDir)) {
						if (!entry.endsWith(".md")) continue;
						files.push({ name: entry, text: readFileSync(`${plansDir}/${entry}`, "utf-8") });
					}
				}
			} catch (error) {
				ctx.ui.notify(`og: cannot read plan: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			if (files.length === 0) {
				ctx.ui.notify("og: no plan files found", "info");
				return;
			}

			const failures: string[] = [];
			const allWarnings: string[] = [];
			const allNotes: string[] = [];
			let passed = 0;
			for (const file of files) {
				const result = lintPlan(file.text, { cwd: ctx.cwd, strict });
				for (const note of result.notes ?? []) {
					if (!allNotes.includes(note)) allNotes.push(note);
				}
				for (const w of result.warnings) {
					allWarnings.push(`${file.name}: ${w.code}${w.node ? `(${w.node})` : ""}${w.detail ? ` ${w.detail}` : ""}`);
				}
				if (result.ok) {
					passed++;
				} else {
					failures.push(
						`${file.name}: ` + result.errors.map((e) => `${e.code}${e.node ? `(${e.node})` : ""}${e.detail ? ` ${e.detail}` : ""}`).join(", ")
					);
				}
			}
			if (allWarnings.length > 0) {
				ctx.ui.notify(`og: warnings:\n${allWarnings.join("\n")}`, "warning");
			}
			// spec-13: a skipped rule is stated, never silent — and never a failure.
			if (allNotes.length > 0) {
				ctx.ui.notify(`og: notes:\n${allNotes.join("\n")}`, "info");
			}
			if (failures.length === 0) {
				ctx.ui.notify(`og: ${passed}/${files.length} plans ok`, "info");
			} else {
				ctx.ui.notify(`og: ${failures.length} failing:\n${failures.join("\n")}`, "error");
			}
		},
	});

	pi.registerCommand("og-dispatch", {
		description: "One pool step: state from disk, next batch (or one serial node), spawn or resume",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const serial = /(^|\s)--serial(?=\s|$)/.test(raw);
			const target = raw.replace(/(^|\s)--serial(?=\s|$)/g, " ").trim();
			let planPath = target;
			if (!planPath) {
				const plansDir = ogDirs(ctx.cwd).plans;
				let names: string[] = [];
				try {
					names = readdirSync(plansDir).filter((name) => name.endsWith(".md"));
				} catch {
					names = [];
				}
				if (names.length !== 1) {
					ctx.ui.notify(
						`og: usage /og-dispatch <plan.md> [--serial] (${names.length} plans in ${plansDir})`,
						"warning"
					);
					return;
				}
				planPath = `${plansDir}/${names[0]}`;
			}

			let text: string;
			try {
				text = readFileSync(planPath, "utf-8");
			} catch (error) {
				ctx.ui.notify(`og: cannot read plan: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const linted = lintPlan(text, { cwd: ctx.cwd });
			if (!linted.ok) {
				ctx.ui.notify(
					`og: plan refused — ${linted.errors.map((e) => `${e.code}${e.node ? `(${e.node})` : ""}`).join(", ")}`,
					"error"
				);
				return;
			}

			const plan = linted.plan;
			const pool = candidatesFromBranch(ctx.sessionManager.getBranch());
			const slug = basename(planPath, ".md");
			const logPath = runLogPath(ctx.cwd, slug);
			const statePath = join(ogDirs(ctx.cwd).runs, `${slug}.batch.json`);
			const fs = fsProbe(ctx.cwd);
			const now = () => new Date().toISOString();

			// One scan per step: the after-scan settles the previous batch, and the
			// same scan is the pre-scan of the batch decided below (spec-9). A serial
			// step with no outstanding batch never walks the root.
			let scanned: RootScan | undefined;
			const readScan = (): RootScan => (scanned ??= scanRoot(plan.writeRoot));
			const prior = readBatchState(statePath);
			if (prior) {
				const verdict = verifyBatch(prior.batch, prior.scan, readScan(), plan, { cwd: ctx.cwd });
				appendRunLog(logPath, {
					kind: "batch-verdict",
					plan: slug,
					accepted: verdict.accepted,
					missing: verdict.missing,
					unchanged: verdict.unchanged,
					stray: verdict.stray,
					strayCheck: verdict.strayCheck,
					at: now(),
				});
				clearAttempts(attemptsPath(ctx.cwd, slug), verdict.accepted);
				for (const id of verdict.missing) bumpAttempts(attemptsPath(ctx.cwd, slug), id);
				rmSync(statePath, { force: true });

				const stray = verdict.stray.length > 0
					? ` stray ${verdict.stray.map((change) => `${change.kind}:${change.change}:${basename(change.path)}`).join(", ")} (${verdict.strayCheck})`
					: "";
				ctx.ui.notify(
					`og: verdict accepted ${verdict.accepted.length} / missing ${verdict.missing.length} / unchanged ${verdict.unchanged.length}${stray}`,
					verdict.missing.length > 0 ? "warning" : "info"
				);

				// spec-12: an accepted verdict that make-semantics still derives undone
				// (over-declared writes) must be visible NOW, not on a later session resume.
				for (const warning of settleWarnings(plan, fs, verdict.accepted)) {
					const why = [
						warning.missing.length > 0 ? `missing: ${warning.missing.join(", ")}` : "",
						warning.stale.length > 0 ? `stale: ${warning.stale.join(", ")}` : "",
						warning.blockedByDep.length > 0 ? `blocked by: ${warning.blockedByDep.join(", ")}` : "",
					].filter(Boolean).join("; ");
					ctx.ui.notify(
						`og: ${warning.id} verdict accepted but NOT done — ${why}. Fix the plan's writes, never touch untouched files.`,
						"warning"
					);
				}

				if (verdict.intrusion && prior.batch.ids.length > 1) {
					ctx.ui.notify(
						`og: stray-intrusion — batch stopped, nothing else dispatched. Inspect: ${verdict.stray.map((change) => change.path).join(", ")}`,
						"error"
					);
					return;
				}
				if (verdict.intrusion && prior.batch.ids.length === 1) {
					const failedId = prior.batch.ids[0];
					const attempts = bumpAttempts(attemptsPath(ctx.cwd, slug), failedId);
					if (attempts >= DEFAULT_MAX_ATTEMPTS) {
						ctx.ui.notify(`og: node-failed ${failedId} after ${attempts} attempts — intrusion`, "error");
					} else {
						ctx.ui.notify(`og: intrusion by ${failedId} — retry ${attempts}/${DEFAULT_MAX_ATTEMPTS}`, "warning");
					}
					return;
				}
			}

			if (serial) {
				const step = nextStep(plan, fs, { sizeOf: sizeProbe(ctx.cwd), candidates: pool, now: Date.now() });
				if (step.kind === "finished") {
					ctx.ui.notify(`og: plan finished (${step.done.length}/${plan.nodes.length} nodes)`, "info");
					return;
				}
				if (step.kind === "blocked") {
					ctx.ui.notify(`og: blocked — ${step.detail}`, "error");
					return;
				}

				const action =
					step.action.kind === "resume"
						? `resume ${step.action.candidate} (score ${step.action.score.toFixed(2)})`
						: "spawn (cold pool)";
				const load = `${step.load.kept.length} kept / ${step.load.dropped.length} dropped / ${step.load.missing.length} missing`;
				const reads = `${step.reads.length}f ~${step.readsTokens} tok${step.readWarn ? " OVER-BUDGET" : ""}`;

				appendRunLog(logPath, {
					step: step.done.length + 1,
					node: step.node.id,
					action: step.action.kind,
					...(step.action.kind === "resume" ? { candidate: step.action.candidate, score: step.action.score } : {}),
					kept: step.load.kept,
					dropped: step.load.dropped,
					missing: step.load.missing,
					readsTokens: step.readsTokens,
					readWarn: step.readWarn,
					declaredWidth: step.declaredWidth,
					writesVerified: false,
					at: now(),
				});

				ctx.ui.notify(
					[
						`og: next ${step.node.id} (${step.node.role}) ${action}`,
						`preload ${load} | reads ${reads} | width ${step.declaredWidth} (serial)`,
						buildTaskText(step.node).trimEnd(),
					].join("\n"),
					"info"
				);
				return;
			}

			const scan = readScan();
			const result = nextBatch(plan, fs, {
				attempts: readAttempts(attemptsPath(ctx.cwd, slug)),
				scan,
				cwd: ctx.cwd,
				candidates: pool,
				now: Date.now(),
			});
			if (result.kind === "finished") {
				ctx.ui.notify(`og: plan finished (${result.done.length}/${plan.nodes.length} nodes)`, "info");
				return;
			}
			if (result.kind === "blocked") {
				ctx.ui.notify(`og: blocked — ${result.detail}`, "error");
				return;
			}
			if (result.kind === "node-failed") {
				ctx.ui.notify(`og: node-failed ${result.node} after ${result.attempts} attempts`, "error");
				return;
			}
			if (result.kind === "batch" && result.refused) {
				appendRunLog(logPath, {
					kind: "batch-refused",
					plan: slug,
					reason: result.refused.reason,
					dirty: result.refused.dirty,
					at: now(),
				});
				ctx.ui.notify(
					`og: batch refused (${result.refused.reason}) — ${result.refused.dirty.length} dirty path(s): ${result.refused.dirty.slice(0, 5).join(", ")}${result.refused.dirty.length > 5 ? " …" : ""}. Commit or stash; isolation is never dropped automatically.`,
					"error"
				);
				return;
			}

			const batch = result.batch;
			if (batch.ids.length === 0) {
				ctx.ui.notify("og: no dispatchable node", "warning");
				return;
			}

			ensureOgDirs(ctx.cwd);
			const state: BatchStateFile = {
				batch: {
					ids: batch.ids,
					deferred: batch.deferred,
					widthCap: batch.widthCap,
					snapshot: batch.snapshot,
				},
				scan: serializeScan(scan),
				at: now(),
			};
			writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf-8");
			appendRunLog(logPath, {
				kind: "batch",
				plan: slug,
				ids: batch.ids,
				widthCap: batch.widthCap,
				deferred: batch.deferred,
				rootScan: { files: scan.count, bytes: scan.bytes, truncated: scan.truncated },
				snapshot: batch.snapshot,
				at: now(),
			});

			const deferred = batch.deferred.length > 0
				? ` | deferred ${batch.deferred.map((refusal) => `${refusal.id}(${refusal.why})`).join(", ")}`
				: "";
			ctx.ui.notify(
				[
					`og: batch ${batch.ids.join(", ")} (width ${batch.widthCap}${deferred})`,
					`root scan ${scan.count}f / ${scan.bytes}B${scan.truncated ? " TRUNCATED → strayCheck skipped" : ""}`,
					// spec-13: the fit buckets are the audit trail for this dispatch decision.
					...(batch.fit !== undefined ? [batch.fit.summary] : []),
					// spec-14: band nodes stay dispatchable; the band is named, never guessed.
					...(batch.fitBand ?? []).map(
						(row) => `fit-band: ${row.id} -> candidates ${row.candidates.join(", ")} (run: og-band ${basename(planPath)})`
					),
					renderRunsAll(plan, batch),
				].join("\n"),
				"info"
			);
		},
	});

	pi.registerCommand("og-band", {
		description: "Print the spec-14 rfit judgment batch for a plan; --verdicts maps the judge answers to buckets",
		handler: async (args, ctx) => {
			const options = splitBandArgs((args ?? "").trim());
			if (!options.plan) {
				ctx.ui.notify("og: usage /og-band <plan.md> --catalog <catalog.json> [--verdicts <json|file>]", "warning");
				return;
			}
			if (options.catalog === undefined) {
				ctx.ui.notify("og: no catalog injected — pass --catalog <catalog.json>. Nothing asked; the band never guesses.", "warning");
				return;
			}
			const catalog = readCatalog(options.catalog);
			if (catalog === undefined) {
				ctx.ui.notify(`og: cannot read catalog ${options.catalog}`, "error");
				return;
			}

			let text: string;
			try {
				text = readFileSync(options.plan, "utf-8");
			} catch (error) {
				ctx.ui.notify(`og: cannot read plan: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const linted = lintPlan(text, { cwd: ctx.cwd, catalog });
			if (!linted.ok) {
				ctx.ui.notify(
					`og: plan refused — ${linted.errors.map((e) => `${e.code}${e.node ? `(${e.node})` : ""}`).join(", ")}`,
					"error"
				);
				return;
			}

			const plan = linted.plan;
			const slug = basename(options.plan, ".md");
			const state = deriveDone(plan, fsProbe(ctx.cwd));
			const questions = buildRfitQuestions(dispatchable(plan, state.done), catalog);
			const keys = Object.keys(questions);
			if (keys.length === 0) {
				ctx.ui.notify("og: no band nodes — every dispatchable node's fit is settled", "info");
				return;
			}

			const nodes = new Set(Object.values(questions).map((question) => question.node));
			// The conductor copies this JSON into the judge tool; the model call is
			// outside this process, so the shipped lint gates it before money is spent.
			ctx.ui.notify(
				`og: band batch ${keys.length} question(s) for ${nodes.size} node(s)\n${JSON.stringify(questions, null, 2)}`,
				"info"
			);

			if (options.verdicts === undefined) {
				ctx.ui.notify("og: copy the batch into the judge tool, then rerun with --verdicts <json|file>", "info");
				return;
			}
			const verdicts = readVerdicts(options.verdicts);
			if (verdicts === undefined) {
				ctx.ui.notify("og: cannot read verdicts — expected a JSON object keyed by cp_key", "error");
				return;
			}

			const mapping = mapVerdicts(questions, verdicts);
			const batchId = createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 12);
			ensureOgDirs(ctx.cwd);
			appendRunLog(runLogPath(ctx.cwd, slug), {
				kind: "fit-judgment",
				plan: slug,
				batch: batchId,
				questions: keys,
				verdicts,
				moves: mapping.moves,
				unresolved: mapping.unresolved,
				at: new Date().toISOString(),
			});

			const moves = mapping.moves.map((move) => `${move.id} -> ${move.agent} ${move.fit}`);
			const unresolved = mapping.unresolved.length > 0 ? [`unresolved ${mapping.unresolved.length} (${mapping.unresolved.join(", ")})`] : [];
			ctx.ui.notify(
				[`og: band ${batchId}`, ...moves, ...unresolved].join("\n"),
				unresolved.length > 0 ? "warning" : "info"
			);
		},
	});

	pi.registerCommand("og-mark", {
		description: "Write the post-task load map and marker for a finished plan node",
		handler: async (args, ctx) => {
			const [sessionFile, planPath, nodeId] = (args ?? "").trim().split(/\s+/);
			if (!sessionFile || !planPath || !nodeId) {
				ctx.ui.notify("og: usage /og-mark <childSessionFile> <plan.md> <nodeId>", "warning");
				return;
			}

			let text: string;
			try {
				text = readFileSync(planPath, "utf-8");
			} catch (error) {
				ctx.ui.notify(`og: cannot read plan: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const linted = lintPlan(text, { cwd: ctx.cwd });
			if (!linted.ok) {
				ctx.ui.notify(`og: plan refused — ${linted.errors.map((e) => e.code).join(", ")}`, "error");
				return;
			}
			const node = linted.plan.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) {
				ctx.ui.notify(`og: no node ${nodeId} in ${planPath}`, "error");
				return;
			}

			ensureOgDirs(ctx.cwd);
			const mapPath = defaultMapPath(ctx.cwd, node.role, node.id);
			const files = mapFromNode(node);
			const gaps = files.length === 0 ? "nothing declared" : undefined;
			writeFileSync(
				mapPath,
				renderLoadMap({
					role: node.role,
					node: node.id,
					plan: planPath,
					files,
					...(gaps ? { gaps } : {}),
				}),
				"utf-8"
			);

			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const result = appendLoadMarker(
				sessionFile,
				{ role: node.role, files, mapPath },
				{ open: (file) => SessionManager.open(file) as unknown as MarkerSession, checkMap: true }
			);
			if (!result.ok) {
				ctx.ui.notify(
					`og: marker refused (${result.reason}) ${result.detail ?? ""} — map ${mapPath}`,
					"error"
				);
				return;
			}
			ctx.ui.notify(`og: marker ${result.markerId} for ${node.id} (${files.length} files, map ${basename(mapPath)})`, "info");
		},
	});

	pi.registerCommand("og-apply", {
		description: "Classify a child's patch and apply it to the main tree at the one seam (spec-10)",
		handler: async (args, ctx) => {
			const [patchFile, planPath, nodeId] = (args ?? "").trim().split(/\s+/);
			if (!patchFile || !planPath || !nodeId) {
				ctx.ui.notify("og: usage /og-apply <child.patch> <plan.md> <nodeId>", "warning");
				return;
			}

			let text: string;
			let patch: string;
			try {
				text = readFileSync(planPath, "utf-8");
				patch = readFileSync(patchFile, "utf-8");
			} catch (error) {
				ctx.ui.notify(`og: cannot read input: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const linted = lintPlan(text, { cwd: ctx.cwd });
			if (!linted.ok) {
				ctx.ui.notify(`og: plan refused — ${linted.errors.map((e) => `${e.code}${e.node ? `(${e.node})` : ""}`).join(", ")}`, "error");
				return;
			}
			const plan = linted.plan;
			const node = plan.nodes.find((candidate) => candidate.id === nodeId);
			if (!node) {
				ctx.ui.notify(`og: no node ${nodeId} in ${planPath}`, "error");
				return;
			}
			if (node.isolation !== "worktree") {
				ctx.ui.notify(`og: isolation-refused — node ${nodeId} declares no worktree isolation; patches apply only at the seam`, "error");
				return;
			}

			const repo = findRepoRoot(resolvePlanPath(ctx.cwd, node.writes[0]));
			if (repo === null) {
				ctx.ui.notify(`og: isolation-refused — no repository at ${node.writes[0]}`, "error");
				return;
			}

			const files = parsePatchPaths(patch);
			if (files.length === 0) {
				ctx.ui.notify(`og: ${patchFile} has no file entries — nothing to apply`, "warning");
				return;
			}
			const classes: PatchClass[] = classifyPatch({ files }, plan, nodeId, ctx.cwd);
			const verdict = applyPatch({ patch, files }, repo, plan, nodeId, { cwd: ctx.cwd });

			const slug = basename(planPath, ".md");
			const logPath = runLogPath(ctx.cwd, slug);
			appendRunLog(logPath, {
				kind: "patch-apply",
				plan: slug,
				node: nodeId,
				repo,
				patchFile,
				classes,
				ok: verdict.ok,
				...(verdict.ok ? { applied: verdict.applied.map((entry) => entry.path) } : { reason: verdict.reason, detail: verdict.detail, refused: verdict.refused.map((entry) => `${entry.kind}:${entry.path}`) }),
				at: new Date().toISOString(),
			});

			if (!verdict.ok && verdict.reason === "other-declared") {
				ctx.ui.notify(
					`og: patch refused (other-declared) — nothing applied: ${verdict.refused.map((entry) => entry.path).join(", ")}`,
					"error"
				);
				return;
			}
			if (!verdict.ok && verdict.reason === "patch-conflict") {
				ctx.ui.notify(`og: patch-conflict — node ${nodeId} stays undone, manifest keeps the patch. ${verdict.detail ?? ""}`, "error");
				return;
			}

			const garbage = verdict.applied.filter((entry) => entry.kind === "undeclared");
			const done = deriveDone(plan, fsProbe(ctx.cwd));
			const settled = done.done.includes(nodeId) ? `, node ${nodeId} done` : `, node ${nodeId} NOT done yet`;
			ctx.ui.notify(
				`og: patch applied for ${nodeId} at ${repo} — ${verdict.applied.length} path(s)${garbage.length > 0 ? `, garbage: ${garbage.map((entry) => entry.path).join(", ")}` : ""}${settled}`,
				"info"
			);
		},
	});
}
