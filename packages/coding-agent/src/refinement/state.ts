import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomically } from "../codegraph/location-fs";
import type {
	HarnessEntry,
	HarnessRefinementEvent,
	HarnessScope,
	HarnessState,
	RefinementKind,
	RefinementResult,
} from "./types";

const HARNESS_DIRECTORY = "harness";
const STATE_FILE_NAME = "harness-state.json";
const HISTORY_FILE_NAME = "refinements.jsonl";
const REFINEMENT_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

type ScopedHarnessEntry = HarnessEntry & { scope?: HarnessScope };

const TRANSACTION_SCHEMA = 1;
const TRANSACTION_FILE_NAME = ".harness-refinement-transaction.json";

type StoredText = string | null;

interface HarnessTransaction {
	schema: number;
	disposition: "commit" | "rollback";
	statePath: string;
	historyPath: string;
	stateBefore: StoredText;
	historyBefore: StoredText;
	stateAfter: string;
	historyAfter: string;
}

function newEntryRecords(): Record<RefinementKind, Record<string, HarnessEntry>> {
	return {
		prompt: Object.create(null) as Record<string, HarnessEntry>,
		memory: Object.create(null) as Record<string, HarnessEntry>,
		skill: Object.create(null) as Record<string, HarnessEntry>,
		subagent: Object.create(null) as Record<string, HarnessEntry>,
	};
}

/** Create an empty, serializable continual-harness state. */
export function createHarnessState(): HarnessState {
	return { schema: 1, entries: newEntryRecords(), refinements: [] };
}

/** Resolve the selected state file from its owning agent or session-artifact directory. */
export function getHarnessStatePath(directory: string, scope: HarnessScope): string {
	return scope === "global"
		? path.join(directory, HARNESS_DIRECTORY, STATE_FILE_NAME)
		: path.join(directory, STATE_FILE_NAME);
}

/** Resolve the selected scope's append-only refinement history. */
export function getRefinementHistoryPath(directory: string, scope: HarnessScope = "global"): string {
	return scope === "global"
		? path.join(directory, HARNESS_DIRECTORY, HISTORY_FILE_NAME)
		: path.join(directory, HISTORY_FILE_NAME);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

async function readTextFileIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function asStoredText(value: unknown): value is StoredText {
	return value === null || typeof value === "string";
}

function parseHarnessTransaction(raw: string, statePath: string, historyPath: string): HarnessTransaction {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Pending refinement transaction is malformed");
	}
	const record = asRecord(parsed);
	if (!record) throw new Error("Pending refinement transaction is malformed");
	const stateBefore = record.stateBefore;
	const historyBefore = record.historyBefore;
	const disposition = record.disposition;
	const recordedStatePath = record.statePath;
	const recordedHistoryPath = record.historyPath;
	const stateAfter = record.stateAfter;
	const historyAfter = record.historyAfter;
	if (
		record.schema !== TRANSACTION_SCHEMA ||
		(disposition !== "commit" && disposition !== "rollback") ||
		typeof recordedStatePath !== "string" ||
		typeof recordedHistoryPath !== "string" ||
		!asStoredText(stateBefore) ||
		!asStoredText(historyBefore) ||
		typeof stateAfter !== "string" ||
		typeof historyAfter !== "string" ||
		path.resolve(recordedStatePath) !== path.resolve(statePath) ||
		path.resolve(recordedHistoryPath) !== path.resolve(historyPath)
	) {
		throw new Error("Pending refinement transaction does not match this harness");
	}
	return {
		schema: TRANSACTION_SCHEMA,
		disposition,
		statePath: recordedStatePath,
		historyPath: recordedHistoryPath,
		stateBefore,
		historyBefore,
		stateAfter,
		historyAfter,
	};
}

async function replaceTextFile(filePath: string, content: StoredText): Promise<void> {
	if (content === null) {
		await fs.rm(filePath, { force: true });
		return;
	}
	await writeTextFileAtomically(filePath, content);
}

async function restorePublishedFiles(
	transaction: HarnessTransaction,
	statePublished: boolean,
	historyPublished: boolean,
): Promise<void> {
	let failure: unknown;
	if (historyPublished) {
		try {
			await replaceTextFile(transaction.historyPath, transaction.historyBefore);
		} catch (error) {
			failure = error;
		}
	}
	if (statePublished) {
		try {
			await replaceTextFile(transaction.statePath, transaction.stateBefore);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

async function recoverHarnessTransaction(directory: string, scope: HarnessScope): Promise<void> {
	const statePath = getHarnessStatePath(directory, scope);
	const historyPath = getRefinementHistoryPath(directory, scope);
	const transactionPath = path.join(path.dirname(statePath), TRANSACTION_FILE_NAME);
	const raw = await readTextFileIfPresent(transactionPath);
	if (raw === undefined) return;
	const transaction = parseHarnessTransaction(raw, statePath, historyPath);
	if (transaction.disposition === "commit") {
		await replaceTextFile(statePath, transaction.stateAfter);
		await replaceTextFile(historyPath, transaction.historyAfter);
	} else {
		await replaceTextFile(statePath, transaction.stateBefore);
		await replaceTextFile(historyPath, transaction.historyBefore);
	}
	await fs.rm(transactionPath, { force: true });
}

function asScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "local" || value === "global" ? value : fallback;
}

function asTimestamp(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry === undefined ? undefined : structuredClone(entry);
}

function normalizeEntry(
	id: string,
	kind: RefinementKind,
	value: unknown,
	scope: HarnessScope,
): HarnessEntry | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const now = Date.now();
	return {
		...record,
		id: typeof record.id === "string" && record.id.length > 0 ? record.id : id,
		kind,
		title: typeof record.title === "string" ? record.title : id,
		content: typeof record.content === "string" ? record.content : "",
		version: typeof record.version === "number" && Number.isFinite(record.version) ? record.version : 1,
		created_at: asTimestamp(record.created_at, now),
		updated_at: asTimestamp(record.updated_at, now),
		scope: asScope(record.scope, scope),
	};
}

function normalizeEvent(value: unknown): HarnessRefinementEvent | undefined {
	const record = asRecord(value);
	if (!record || typeof record.id !== "string" || typeof record.summary !== "string") return undefined;
	return {
		id: record.id,
		summary: record.summary,
		timestamp: asTimestamp(record.timestamp, Date.now()),
		scope: asScope(record.scope, "local"),
		...(typeof record.rollbackOf === "string" ? { rollbackOf: record.rollbackOf } : {}),
	};
}

/**
 * Load selected harness state. Missing, malformed, and non-object files return
 * `undefined`; callers can use {@link createHarnessState} and overwrite them
 * through the atomic saver.
 */
export async function loadHarnessState(directory: string, scope: HarnessScope): Promise<HarnessState | undefined> {
	await recoverHarnessTransaction(directory, scope);
	const statePath = getHarnessStatePath(directory, scope);
	let raw: unknown;
	try {
		raw = await Bun.file(statePath).json();
	} catch {
		return undefined;
	}
	const parsed = asRecord(raw);
	if (!parsed) return undefined;

	const state = createHarnessState();
	state.schema = typeof parsed.schema === "number" && Number.isFinite(parsed.schema) ? parsed.schema : 1;
	const parsedEntries = asRecord(parsed.entries);
	for (const kind of REFINEMENT_KINDS) {
		const entries = asRecord(parsedEntries?.[kind]);
		if (!entries) continue;
		for (const [id, value] of Object.entries(entries)) {
			const entry = normalizeEntry(id, kind, value, scope);
			if (entry) state.entries[kind][id] = entry;
		}
	}
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements.flatMap(event => {
			const normalized = normalizeEvent(event);
			return normalized ? [normalized] : [];
		});
	}
	return state;
}

/**
 * Merge persistent global context with session-local context without hiding an
 * id collision. Global keeps its bare id; local renders under `local:<id>`.
 */
export function mergeHarnessStates(global?: HarnessState, local?: HarnessState): HarnessState {
	const merged = createHarnessState();
	merged.schema = Math.max(global?.schema ?? 1, local?.schema ?? 1);
	for (const kind of REFINEMENT_KINDS) {
		for (const [id, entry] of Object.entries(global?.entries[kind] ?? {})) {
			const copy = cloneEntry(entry);
			if (!copy) continue;
			(merged.entries[kind] as Record<string, ScopedHarnessEntry>)[id] = {
				...copy,
				scope: asScope(copy.scope, "global"),
			};
		}
		for (const [id, entry] of Object.entries(local?.entries[kind] ?? {})) {
			const copy = cloneEntry(entry);
			if (!copy) continue;
			const scoped = { ...copy, scope: asScope(copy.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `local:${id}` : id;
			(merged.entries[kind] as Record<string, ScopedHarnessEntry>)[mergedId] = scoped;
		}
	}
	merged.refinements = [...(global?.refinements ?? []), ...(local?.refinements ?? [])].map(event =>
		structuredClone(event),
	);
	return merged;
}

/** Atomically replace `statePath` through the shared sibling-temp writer. */
export async function saveHarnessState(state: HarnessState, statePath: string): Promise<void> {
	await writeTextFileAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isRefinementResult(value: unknown): value is RefinementResult {
	const record = asRecord(value);
	return Boolean(record && typeof record.id === "string" && Array.isArray(record.appliedEdits));
}

/** Append a durable scope-specific audit record without exposing a partial JSONL line. */
export async function appendRefinementHistory(
	result: RefinementResult,
	scope: HarnessScope,
	directory: string,
): Promise<void> {
	await recoverHarnessTransaction(directory, scope);
	const historyPath = getRefinementHistoryPath(directory, scope);
	const previous = await readTextFileIfPresent(historyPath);
	await writeTextFileAtomically(historyPath, `${previous ?? ""}${JSON.stringify(result)}\n`);
}

/** Commit state and its append-only rollback record as one recoverable transaction. */
export async function commitHarnessStateAndHistory(
	state: HarnessState,
	result: RefinementResult,
	scope: HarnessScope,
	directory: string,
): Promise<void> {
	await recoverHarnessTransaction(directory, scope);
	const statePath = getHarnessStatePath(directory, scope);
	const historyPath = getRefinementHistoryPath(directory, scope);
	const transactionPath = path.join(path.dirname(statePath), TRANSACTION_FILE_NAME);
	result.harnessStatePath = statePath;
	const [stateBefore, historyBefore] = await Promise.all([
		readTextFileIfPresent(statePath),
		readTextFileIfPresent(historyPath),
	]);
	const transaction: HarnessTransaction = {
		schema: TRANSACTION_SCHEMA,
		disposition: "rollback",
		statePath,
		historyPath,
		stateBefore: stateBefore ?? null,
		historyBefore: historyBefore ?? null,
		stateAfter: `${JSON.stringify(state, null, 2)}\n`,
		historyAfter: `${historyBefore ?? ""}${JSON.stringify(result)}\n`,
	};
	await writeTextFileAtomically(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
	let statePublished = false;
	let historyPublished = false;
	try {
		await replaceTextFile(statePath, transaction.stateAfter);
		statePublished = true;
		await replaceTextFile(historyPath, transaction.historyAfter);
		historyPublished = true;
		await writeTextFileAtomically(
			transactionPath,
			`${JSON.stringify({ ...transaction, disposition: "commit" }, null, 2)}\n`,
		);
	} catch (error) {
		try {
			await restorePublishedFiles(transaction, statePublished, historyPublished);
			await fs.rm(transactionPath, { force: true });
		} catch {
			// The durable rollback transaction retains both before-images for recovery.
		}
		throw error;
	}
	// A retained commit marker is safe: the next load idempotently republishes both files.
	await fs.rm(transactionPath, { force: true }).catch(() => undefined);
}
/** Load valid refinement records, skipping malformed JSONL lines. */
export async function loadRefinementHistory(
	directory: string,
	scope: HarnessScope = "global",
): Promise<RefinementResult[]> {
	await recoverHarnessTransaction(directory, scope);
	let contents: string;
	try {
		contents = await Bun.file(getRefinementHistoryPath(directory, scope)).text();
	} catch {
		return [];
	}
	const history: RefinementResult[] = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRefinementResult(parsed)) continue;
			history.push({ ...parsed, scope: asScope(parsed.scope, scope) });
		} catch {
			// A corrupt append must not make all prior refinements unrollbackable.
		}
	}
	return history;
}
