import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { CURRENT_SESSION_VERSION } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { FileSessionStorage, type SessionStorageWriter } from "../session/session-storage";

/**
 * Reserved transcript stem for advisor session files. Chosen so it cannot
 * collide with a task subagent's `<id>.jsonl` (task ids are reserved against
 * this exact stem in {@link AgentOutputManager}).
 */
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";
export const ADVISOR_TRANSCRIPT_FILENAME = `${ADVISOR_TRANSCRIPT_STEM}.jsonl`;

const JSONL_SUFFIX = ".jsonl";
const COST_LEDGER_SUFFIX = ".cost.json";
const COST_LEDGER_VERSION = 1;
const MAX_PERSISTED_ADVISOR_USER_BYTES = 64 * 1024;

/**
 * Transcript filename for an advisor: `__advisor.jsonl` for the legacy/default
 * advisor (empty slug), `__advisor.<slug>.jsonl` for a named advisor. The `.`
 * separator keeps named files out of the output manager's `-<n>` bump namespace.
 */
export function advisorTranscriptFilename(slug: string): string {
	return slug ? `${ADVISOR_TRANSCRIPT_STEM}.${slug}${JSONL_SUFFIX}` : ADVISOR_TRANSCRIPT_FILENAME;
}

/** Whether a filename is any advisor transcript (`__advisor.jsonl` or `__advisor.<slug>.jsonl`). */
export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

export function advisorCostLedgerFilename(transcriptFilename: string): string {
	if (!isAdvisorTranscriptName(transcriptFilename)) {
		throw new Error(`Invalid advisor transcript filename: ${transcriptFilename}`);
	}
	return `${transcriptFilename.slice(0, -JSONL_SUFFIX.length)}${COST_LEDGER_SUFFIX}`;
}

function isAdvisorCostLedgerName(name: string): boolean {
	return (
		name === `${ADVISOR_TRANSCRIPT_STEM}${COST_LEDGER_SUFFIX}` ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(COST_LEDGER_SUFFIX))
	);
}

function advisorSlugFromFilename(name: string, suffix: string): string {
	return name === `${ADVISOR_TRANSCRIPT_STEM}${suffix}`
		? ""
		: name.slice(`${ADVISOR_TRANSCRIPT_STEM}.`.length, -suffix.length);
}

interface AdvisorCostLedger {
	version: typeof COST_LEDGER_VERSION;
	total: number;
}

function advisorCostLedgerTotal(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const ledger = value as Partial<AdvisorCostLedger>;
	return ledger.version === COST_LEDGER_VERSION && typeof ledger.total === "number" && Number.isFinite(ledger.total)
		? ledger.total
		: undefined;
}

async function readAdvisorCostLedger(file: string): Promise<number | undefined> {
	try {
		return advisorCostLedgerTotal(await Bun.file(file).json());
	} catch (err) {
		if (!isEnoent(err))
			logger.debug("advisor cost ledger read failed", { file: path.basename(file), err: String(err) });
		return undefined;
	}
}

const ledgerStorage = new FileSessionStorage();

async function writeAdvisorCostLedger(file: string, total: number): Promise<void> {
	const ledger: AdvisorCostLedger = { version: COST_LEDGER_VERSION, total };
	await ledgerStorage.writeTextAtomic(file, `${JSON.stringify(ledger)}\n`);
}

/** Load advisor spend from constant-size ledgers without scanning transcripts. */
export async function loadAdvisorTranscriptCosts(sessionFile: string | undefined): Promise<Map<string, number>> {
	const costs = new Map<string, number>();
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return costs;
	const directory = sessionFile.slice(0, -JSONL_SUFFIX.length);
	const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirents) {
		if (!dirent.isFile() || !isAdvisorCostLedgerName(dirent.name)) continue;
		const total = await readAdvisorCostLedger(path.join(directory, dirent.name));
		if (total !== undefined && total > 0) {
			costs.set(advisorSlugFromFilename(dirent.name, COST_LEDGER_SUFFIX), total);
		}
	}
	return costs;
}

/**
 * One-time offline migration for legacy advisor transcripts. Runtime resume
 * deliberately never calls this because a transcript may be arbitrarily large.
 */
export async function migrateAdvisorTranscriptCostLedgers(
	sessionFile: string | undefined,
): Promise<Map<string, number>> {
	const costs = new Map<string, number>();
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return costs;
	const directory = sessionFile.slice(0, -JSONL_SUFFIX.length);
	const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirents) {
		if (!dirent.isFile() || !isAdvisorTranscriptName(dirent.name)) continue;
		const transcript = path.join(directory, dirent.name);
		const ledger = path.join(directory, advisorCostLedgerFilename(dirent.name));
		let total = await readAdvisorCostLedger(ledger);
		if (total === undefined) {
			let migratedTotal = 0;
			try {
				await visitEntriesFromFileStream(transcript, entry => {
					if (typeof entry !== "object" || entry === null || entry.type !== "message") return;
					const message = entry.message;
					if (!message || typeof message !== "object" || message.role !== "assistant") return;
					const cost = message.usage?.cost?.total;
					if (typeof cost === "number" && Number.isFinite(cost)) migratedTotal += cost;
				});
			} catch (err) {
				logger.debug("advisor transcript migration read failed", {
					file: path.basename(transcript),
					err: String(err),
				});
			}
			total = migratedTotal;
			await writeAdvisorCostLedger(ledger, total);
		}
		if (total > 0) costs.set(advisorSlugFromFilename(dirent.name, JSONL_SUFFIX), total);
	}
	return costs;
}

/**
 * Append-only persister for an advisor agent's transcript.
 *
 * The advisor is a passive reviewer with its own model usage, so — like a task
 * subagent — its turns are written to a JSONL inside the owning session's
 * artifacts dir (`<session>/__advisor.jsonl`, `<session>/<SubId>/__advisor.jsonl`
 * for subagent advisors). That single file gives the advisor model proper usage
 * attribution in `omp stats` (the stats parser scans the session dir
 * recursively) and a read-only transcript in the Agent Hub, without making the
 * advisor a registered, messageable peer.
 *
 * The target is derived from the *session file* (`getSessionFile()`), never
 * `getArtifactsDir()` — subagents adopt the parent's artifact manager, so the
 * artifacts dir points at the parent root and every subagent advisor would
 * collide. The file path is resolved synchronously when a message finalizes and
 * captured for the queued write, so a `/new`, resume, or session switch in
 * flight can never misattribute an old advisor turn into the new session's file.
 * On such a switch the previous writer is closed and the new file opened on the
 * next recorded turn. The recorder never truncates: the advisor's in-memory
 * context resets/compacts independently, but every billed turn is appended here.
 *
 * Writes go through a raw append-mode storage writer, never a SessionManager:
 * a resumed transcript can be gigabytes, and opening a SessionManager on it
 * would parse and pin every historical entry in resident memory just to append
 * one line. When the writer first targets an existing file it recovers the
 * session id (head slice) and last entry id (tail slice) with bounded byte
 * reads, so the `session` header stays stable across runs and the `parentId`
 * chain continues — both without scanning the body.
 */
export class AdvisorTranscriptRecorder {
	#storage = new FileSessionStorage();
	#writer: SessionStorageWriter | undefined;
	#file: string | undefined;
	#filename: string;
	#lastEntryId: string | null = null;
	#pendingUser: { file: string; cwd: string; message: UserMessage } | undefined;
	#ledgerTotals = new Map<string, number>();
	/** Serializes the async open/close against synchronous appends so records land in order. */
	#queue: Promise<void>;

	/**
	 * @param filename Transcript filename within the session dir. Defaults to
	 *   `__advisor.jsonl`; named advisors pass `__advisor.<slug>.jsonl` via
	 *   {@link advisorTranscriptFilename}.
	 * @param after Optional barrier the queue starts behind — used on the advisor
	 *   on→off→on toggle so a fresh recorder's first `open` waits for the prior
	 *   recorder's `close` and the two never hold the same file at once.
	 */
	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	/** Persist finalized advisor messages while bounding replayed user batches. */
	record(message: AgentMessage): void {
		if (message.role !== "assistant" && message.role !== "toolResult" && message.role !== "user") return;
		const sessionFile = this.resolveSessionFile();
		if (!sessionFile?.endsWith(JSONL_SUFFIX)) return;
		const file = path.join(sessionFile.slice(0, -JSONL_SUFFIX.length), this.#filename);
		const cwd = this.resolveCwd();

		if (message.role === "user") {
			const persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" as const };
			if (this.#pendingUser && this.#pendingUser.file !== file) this.#enqueuePendingUser();
			this.#pendingUser = { file, cwd, message: persisted };
			return;
		}

		const pendingUser = this.#pendingUser;
		this.#pendingUser = undefined;
		const persisted = message as Message;
		const cost = message.role === "assistant" ? message.usage.cost.total : undefined;
		this.#enqueue(async () => {
			if (pendingUser) {
				await this.#append(pendingUser.file, pendingUser.cwd, this.#boundedUserMessage(pendingUser.message));
			}
			await this.#append(file, cwd, persisted);
			if (typeof cost === "number" && Number.isFinite(cost)) await this.#recordCost(file, cost);
		});
	}

	/** Flush pending writes (best-effort). */
	flush(): Promise<void> {
		this.#enqueuePendingUser();
		return this.#enqueueResult(async () => {
			this.#reportWriterError();
		});
	}

	/** Flush and close the writer, releasing the session file. */
	close(): Promise<void> {
		this.#enqueuePendingUser();
		return this.#enqueueResult(() => this.#closeWriter());
	}

	#enqueuePendingUser(): void {
		const pending = this.#pendingUser;
		if (!pending) return;
		this.#pendingUser = undefined;
		this.#enqueue(() => this.#append(pending.file, pending.cwd, this.#boundedUserMessage(pending.message)));
	}

	#boundedUserMessage(message: UserMessage): UserMessage {
		const serializedBytes = Buffer.byteLength(JSON.stringify(message));
		if (serializedBytes <= MAX_PERSISTED_ADVISOR_USER_BYTES) return message;
		return {
			...message,
			content: [
				{
					type: "text",
					text: `[advisor input omitted: ${serializedBytes} bytes]`,
				},
			],
		};
	}

	async #append(file: string, cwd: string, message: Message): Promise<void> {
		if (file !== this.#file) {
			await this.#closeWriter();
			this.#writer = await this.#openWriter(file, cwd);
			this.#file = file;
		}
		const writer = this.#writer;
		if (!writer) return;
		const entry = {
			type: "message",
			id: crypto.randomUUID().slice(-8),
			parentId: this.#lastEntryId,
			timestamp: new Date().toISOString(),
			message,
		};
		this.#lastEntryId = entry.id;
		this.#appendLine(writer, `${JSON.stringify(entry)}\n`);
		this.#reportWriterError();
	}

	/** Open an append-mode writer, creating the session-header line on first write. */
	async #openWriter(file: string, cwd: string): Promise<SessionStorageWriter | undefined> {
		let sessionId = Bun.randomUUIDv7();
		// Decided before openWriter: opening an append writer creates the file.
		const exists = this.#storage.existsSync(file);
		if (exists) {
			try {
				// Bounded head/tail reads: never parse the transcript body, which may
				// be gigabytes of prior turns.
				const [head, tail] = await this.#storage.readTextSlices(file, 4096, 8192);
				sessionId = parseHeadSessionId(head) ?? sessionId;
				this.#lastEntryId = parseTailEntryId(tail);
			} catch (err) {
				logger.debug("advisor transcript open failed", { file: path.basename(file), err: String(err) });
			}
		} else {
			this.#lastEntryId = null;
		}
		const writer = this.#storage.openWriter(file, {
			flags: "a",
			onError: err => logger.debug("advisor transcript append failed", { err: String(err) }),
		});
		if (!exists) {
			const header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd,
			};
			this.#appendLine(writer, `${JSON.stringify(header)}\n`);
		}
		return writer;
	}

	/**
	 * Append one line through the writer's synchronous path when it has one.
	 * `appendSync` is optional on {@link SessionStorageWriter} (indexed
	 * backends queue remote I/O and only expose the async `append`), so an
	 * unguarded call would crash the recorder on those backends.
	 */
	#appendLine(writer: SessionStorageWriter, line: string): void {
		if (writer.appendSync) {
			writer.appendSync(line);
			return;
		}
		void writer.append(line).catch(err => logger.debug("advisor transcript append failed", { err: String(err) }));
	}

	#reportWriterError(): void {
		const err = this.#writer?.getError();
		if (err)
			logger.debug("advisor transcript write failed", { file: path.basename(this.#file ?? ""), err: String(err) });
	}

	async #recordCost(transcript: string, increment: number): Promise<void> {
		const ledger = path.join(path.dirname(transcript), advisorCostLedgerFilename(path.basename(transcript)));
		const current = this.#ledgerTotals.get(ledger) ?? (await readAdvisorCostLedger(ledger)) ?? 0;
		const total = current + increment;
		await writeAdvisorCostLedger(ledger, total);
		this.#ledgerTotals.set(ledger, total);
	}

	async #closeWriter(): Promise<void> {
		const writer = this.#writer;
		this.#writer = undefined;
		this.#file = undefined;
		this.#lastEntryId = null;
		if (!writer) return;
		try {
			const err = writer.getError();
			if (err) logger.debug("advisor transcript write failed", { err: String(err) });
			await writer.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => {});
		return next;
	}
}

/** Find the `session` header id in a bounded head slice (skips the title slot line). */
function parseHeadSessionId(head: string): string | undefined {
	for (const line of head.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry: unknown = JSON.parse(trimmed);
			if (
				typeof entry === "object" &&
				entry !== null &&
				(entry as { type?: unknown }).type === "session" &&
				typeof (entry as { id?: unknown }).id === "string"
			) {
				return (entry as { id: string }).id;
			}
		} catch {
			// Non-JSON lines (e.g. a legacy padded title slot) are skipped.
		}
	}
	return undefined;
}

/** Find the last parseable entry id in a bounded tail slice (first line may be mid-line). */
function parseTailEntryId(tail: string): string | null {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i]?.trim();
		if (!trimmed) continue;
		try {
			const entry: unknown = JSON.parse(trimmed);
			if (typeof entry === "object" && entry !== null) {
				const id = (entry as { id?: unknown }).id;
				if (typeof id === "string" && id) return id;
			}
		} catch {
			// Partial or corrupt line — keep scanning backwards.
		}
	}
	return null;
}
