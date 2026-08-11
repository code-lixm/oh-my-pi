import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isRecord } from "@oh-my-pi/pi-utils";
import type { Goal, GoalModeState, GoalStatus } from "../goals/state";
import type { CreateAgentSessionOptions } from "../sdk";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";

const RECOVERY_JOURNAL_VERSION = 1 as const;

export type RecoveryJournalEvent = "create" | "ready" | "crashed" | "recovered";

/** Durable worker lifecycle record. Each write is one JSONL line. */
export interface RecoveryJournalEntry {
	version?: typeof RECOVERY_JOURNAL_VERSION;
	event: RecoveryJournalEvent;
	activeSessionId: string;
	sessionId: string;
	sessionPath: string;
	cwd: string;
	recordedAt?: string;
}

export type RecoveryCreateOptions = Omit<CreateAgentSessionOptions, "cwd" | "sessionManager">;

export interface RecoveryContext {
	activeSessionId: string;
	sessionPath: string;
	sessionManager: SessionManager;
	session: AgentSession;
}

export interface RecoveryCronRuntime {
	ready(): Promise<void>;
	dispose(): void;
}

export interface RecoverSessionOptions {
	/** The daemon identity may differ from the persisted SessionManager ID. */
	activeSessionId?: string;
	/** Fallback cwd used only when the persisted session cwd is unavailable. */
	cwd?: string;
	/**
	 * Process-local creation dependencies (credentials, extensions, registry,
	 * etc.). They are deliberately never inferred from recovery journal data.
	 */
	createOptions?: RecoveryCreateOptions;
	/** Rehydrate durable RLM registry state owned by the worker integration. */
	restoreRlmChildren?: (context: RecoveryContext) => Promise<void>;
	/** Rehydrate autonomous state owned by the worker integration. */
	restoreAutonomousState?: (context: RecoveryContext) => Promise<void>;
	/** Observe a fully reconstructed runtime before it is announced to clients. */
	onRecovered?: (context: RecoveryContext) => Promise<void>;
}

export interface DaemonRecoveryManagerOptions {
	journalPath: string;
	/** Test and embedding seam; production uses SessionManager.open(). */
	openSession?: (sessionPath: string, initialCwd: string | undefined) => Promise<SessionManager>;
	/** Test and embedding seam; production uses createAgentSession(). */
	createSession?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
	/** Reuse the scheduler already owned by the reconstructed AgentSession. */
	createCronRuntime?: (session: AgentSession) => RecoveryCronRuntime | undefined;
	restoreRlmChildren?: (context: RecoveryContext) => Promise<void>;
	restoreAutonomousState?: (context: RecoveryContext) => Promise<void>;
}

export interface RecoveredSessionRuntime extends RecoveryContext {
	cronRuntime?: RecoveryCronRuntime;
}

/**
 * Rehydrates a crashed worker from the durable SessionManager transcript and
 * artifacts. Runtime-only dependencies are explicit inputs instead of being
 * guessed from a recovery journal.
 */
export class DaemonRecoveryManager {
	readonly #journalPath: string;
	readonly #openSession: (sessionPath: string, initialCwd: string | undefined) => Promise<SessionManager>;
	readonly #createSession: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
	readonly #createCronRuntime: (session: AgentSession) => RecoveryCronRuntime | undefined;
	readonly #restoreRlmChildren: ((context: RecoveryContext) => Promise<void>) | undefined;
	readonly #restoreAutonomousState: ((context: RecoveryContext) => Promise<void>) | undefined;
	readonly #recovered = new Map<string, RecoveredSessionRuntime>();
	#journalTail: Promise<void> = Promise.resolve();

	constructor(options: DaemonRecoveryManagerOptions) {
		if (!options.journalPath.trim()) throw new Error("recovery journal path is required");
		this.#journalPath = options.journalPath;
		this.#openSession =
			options.openSession ??
			(async (sessionPath, initialCwd) =>
				await SessionManager.open(sessionPath, undefined, undefined, { initialCwd }));
		this.#createSession =
			options.createSession ??
			(async createOptions => {
				const result = await createAgentSession(createOptions);
				return result.session;
			});
		this.#createCronRuntime = options.createCronRuntime ?? (session => session.getScheduleRuntime());
		this.#restoreRlmChildren = options.restoreRlmChildren;
		this.#restoreAutonomousState = options.restoreAutonomousState;
	}

	/** Append a durable lifecycle record without retaining process-local secrets. */
	async writeRecoveryEntry(entry: RecoveryJournalEntry): Promise<void> {
		const normalized = normalizeRecoveryEntry(entry);
		await this.#serializeJournalMutation(async () => {
			await fs.mkdir(path.dirname(this.#journalPath), { recursive: true });
			const handle = await fs.open(this.#journalPath, "a", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
	}

	/** Read valid journal records in on-disk order; malformed partial lines are ignored. */
	async readRecoveryJournal(): Promise<RecoveryJournalEntry[]> {
		await this.#journalTail;
		return await readRecoveryEntries(this.#journalPath);
	}

	/**
	 * Open the persisted JSONL session, rebuild AgentSession through the normal
	 * SDK factory, then restore the scheduler and durable integration state.
	 */
	async recoverSession(sessionPath: string, options: RecoverSessionOptions = {}): Promise<AgentSession> {
		if (!sessionPath.trim()) throw new Error("sessionPath is required for recovery");
		const sessionManager = await this.#openSession(sessionPath, options.cwd);
		const session = await this.#createSession({
			...options.createOptions,
			cwd: sessionManager.getCwd(),
			sessionManager,
		});
		const activeSessionId = options.activeSessionId ?? sessionManager.getSessionId();
		const context: RecoveryContext = {
			activeSessionId,
			sessionPath: sessionManager.getSessionFile() ?? sessionPath,
			sessionManager,
			session,
		};
		let cronRuntime: RecoveryCronRuntime | undefined;

		try {
			await restoreGoalState(context);
			await (options.restoreRlmChildren ?? this.#restoreRlmChildren)?.(context);
			await (options.restoreAutonomousState ?? this.#restoreAutonomousState)?.(context);
			cronRuntime = this.#createCronRuntime(session);
			await cronRuntime?.ready();
			const previous = this.#recovered.get(activeSessionId);
			previous?.cronRuntime?.dispose();
			this.#recovered.set(activeSessionId, { ...context, ...(cronRuntime === undefined ? {} : { cronRuntime }) });
			await this.writeRecoveryEntry({
				event: "recovered",
				activeSessionId,
				sessionId: sessionManager.getSessionId(),
				sessionPath: context.sessionPath,
				cwd: sessionManager.getCwd(),
			});
			await options.onRecovered?.(context);
			return session;
		} catch (error) {
			cronRuntime?.dispose();
			await session.dispose().catch(() => undefined);
			throw error;
		}
	}

	/** Remove all completed lifecycle records for one persisted or active session identity. */
	async cleanRecoveryJournal(sessionId: string): Promise<void> {
		if (!sessionId.trim()) throw new Error("sessionId is required");
		await this.#serializeJournalMutation(async () => {
			const retained = (await readRecoveryEntries(this.#journalPath)).filter(
				entry => entry.sessionId !== sessionId && entry.activeSessionId !== sessionId,
			);
			const contents = retained.map(entry => JSON.stringify(entry)).join("\n");
			await Bun.write(this.#journalPath, contents ? `${contents}\n` : "", { createPath: true });
		});
	}

	getRecoveredSession(activeSessionId: string): RecoveredSessionRuntime | undefined {
		return this.#recovered.get(activeSessionId);
	}

	disposeRecoveredSession(activeSessionId: string): void {
		const recovered = this.#recovered.get(activeSessionId);
		if (!recovered) return;
		this.#recovered.delete(activeSessionId);
		recovered.cronRuntime?.dispose();
	}

	#serializeJournalMutation(operation: () => Promise<void>): Promise<void> {
		const run = this.#journalTail.then(operation);
		this.#journalTail = run.catch(() => undefined);
		return run;
	}
}

async function readRecoveryEntries(journalPath: string): Promise<RecoveryJournalEntry[]> {
	let contents: string;
	try {
		contents = await Bun.file(journalPath).text();
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
	const entries: RecoveryJournalEntry[] = [];
	for (const line of contents.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			const entry = parseRecoveryEntry(parsed);
			if (entry) entries.push(entry);
		} catch {
			// A crash can leave one final partial JSONL line; earlier durable lines
			// remain valid recovery evidence.
		}
	}
	return entries;
}

function normalizeRecoveryEntry(entry: RecoveryJournalEntry): RecoveryJournalEntry {
	if (!isRecoveryJournalEvent(entry.event)) throw new Error(`Unknown recovery event: ${entry.event}`);
	if (!entry.activeSessionId.trim()) throw new Error("activeSessionId is required");
	if (!entry.sessionId.trim()) throw new Error("sessionId is required");
	if (!entry.sessionPath.trim()) throw new Error("sessionPath is required");
	if (!entry.cwd.trim()) throw new Error("cwd is required");
	return {
		version: RECOVERY_JOURNAL_VERSION,
		event: entry.event,
		activeSessionId: entry.activeSessionId,
		sessionId: entry.sessionId,
		sessionPath: entry.sessionPath,
		cwd: entry.cwd,
		recordedAt: new Date().toISOString(),
	};
}

function parseRecoveryEntry(value: unknown): RecoveryJournalEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== RECOVERY_JOURNAL_VERSION || !isRecoveryJournalEvent(value.event)) return undefined;
	if (
		typeof value.activeSessionId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionPath !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.recordedAt !== "string"
	) {
		return undefined;
	}
	return {
		version: RECOVERY_JOURNAL_VERSION,
		event: value.event,
		activeSessionId: value.activeSessionId,
		sessionId: value.sessionId,
		sessionPath: value.sessionPath,
		cwd: value.cwd,
		recordedAt: value.recordedAt,
	};
}

async function restoreGoalState(context: RecoveryContext): Promise<void> {
	const sessionContext = context.sessionManager.buildSessionContext();
	if (sessionContext.mode !== "goal" && sessionContext.mode !== "goal_paused") return;
	const goal = goalFromModeData(sessionContext.modeData);
	if (!goal) return;

	const state: GoalModeState = {
		enabled: sessionContext.mode === "goal",
		mode: "active",
		goal,
	};
	context.session.setGoalModeState(state);
	const restored = await context.session.goalRuntime.onThreadResumed({ preserveActiveGoal: true });
	if (!restored?.goal || context.session.settings.get("goal.enabled") !== true) return;
	const activeTools = context.session.getActiveToolNames();
	if (!activeTools.includes("goal")) await context.session.setActiveToolsByName([...activeTools, "goal"]);
}

function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
	const candidate = modeData?.goal;
	if (!isRecord(candidate)) return undefined;
	if (
		typeof candidate.id !== "string" ||
		typeof candidate.objective !== "string" ||
		!isGoalStatus(candidate.status) ||
		typeof candidate.tokensUsed !== "number" ||
		typeof candidate.timeUsedSeconds !== "number" ||
		typeof candidate.createdAt !== "number" ||
		typeof candidate.updatedAt !== "number"
	) {
		return undefined;
	}
	if (candidate.tokenBudget !== undefined && typeof candidate.tokenBudget !== "number") return undefined;
	return {
		id: candidate.id,
		objective: candidate.objective,
		status: candidate.status,
		tokensUsed: candidate.tokensUsed,
		timeUsedSeconds: candidate.timeUsedSeconds,
		createdAt: candidate.createdAt,
		updatedAt: candidate.updatedAt,
		...(candidate.tokenBudget === undefined ? {} : { tokenBudget: candidate.tokenBudget }),
	};
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "budget-limited" ||
		value === "complete" ||
		value === "dropped"
	);
}

function isRecoveryJournalEvent(value: unknown): value is RecoveryJournalEvent {
	return value === "create" || value === "ready" || value === "crashed" || value === "recovered";
}
