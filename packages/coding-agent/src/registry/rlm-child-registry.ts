import * as fs from "node:fs/promises";
import path from "node:path";
import type { RlmChildRegistryEntry, RlmChildStatus } from "../eval/rlm-types";
import type { AgentSession } from "../session/agent-session";
import { AgentLifecycleManager } from "./agent-lifecycle";
import { AgentRegistry } from "./agent-registry";

const RLM_REGISTRY_FILENAME = "rlm-subagents.jsonl";
const RLM_CHILDREN_DIRECTORY = "rlm";
const RLM_EVENT_VERSION = 1 as const;
const PUBLICATION_POLL_MS = 25;

export type RlmRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "deleted";
export type RlmTerminalNoticeStatus = "none" | "pending" | "sent";

/** One append-only snapshot in a parent's RLM sidecar. */
export interface RlmChildRegistryEvent {
	type: "rlm_child";
	version: typeof RLM_EVENT_VERSION;
	rlm_child_id: string;
	name: string;
	parent_agent_id: string;
	parent_session_file: string | null;
	session_dir: string;
	session_file: string | null;
	session_id: string | null;
	model: string;
	job_id: string | null;
	task_depth: number;
	max_depth: number;
	run_status: RlmRunStatus;
	terminal_notice: RlmTerminalNoticeStatus;
	replied_to_parent: boolean;
	created_at: number;
	updated_at: number;
	error?: string;
}

/** Durable child state enriched with current in-process residency. */
export interface RlmChildInfo {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
	run_status: RlmRunStatus;
	residency: "live" | "parked" | null;
	agent_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_file: string | null;
	job_id: string | null;
	task_depth: number;
	max_depth: number;
	terminal_notice: RlmTerminalNoticeStatus;
	replied_to_parent: boolean;
	error?: string;
}

/** In-process delivery hook for durable terminal notices recovered from the sidecar. */
export type RlmPendingTerminalNoticeRetry = (child: RlmChildInfo) => Promise<void>;

export interface RlmAdmissionRecord {
	rlmChildId: string;
	name: string;
	model: string;
	jobId?: string | null;
	taskDepth: number;
	maxDepth: number;
}

/** Ephemeral admission lease; it reserves an id and name before a job exists. */
export interface RlmAdmissionReservation {
	rlmChildId: string;
	name: string;
}

interface RlmAdmissionReservationState {
	reservation: RlmAdmissionReservation;
	input: RlmAdmissionRecord;
}

export interface RlmSettlement {
	status: "completed" | "failed" | "cancelled";
	error?: string;
}

/** Runtime identity published when a queued child acquires a live session. */
export interface RlmRunningPublication {
	agentId?: string;
	sessionId?: string | null;
	sessionFile?: string | null;
	session?: AgentSession;
}

export interface RlmDeleteSubagentResult {
	rlm_child_id: string;
	name: string;
	deleted: true;
}

export interface RlmParentIdentity {
	parentAgentId: string;
	parentSessionFile: string | null;
	artifactsDir: string;
	/** Testable owner-scoped cancellation hook; production passes AsyncJobManager.cancel. */
	cancelJob?: (jobId: string, parentAgentId: string) => boolean;
	/** Lets integration rehydrate only records it can safely revive. */
	rehydrateChild?: (child: RlmChildInfo) => Promise<void>;
	/** Distinguishes durable stale queued/running records after a process restart. */
	isJobLive?: (jobId: string) => boolean;
	agentRegistry?: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRunStatus(value: unknown): value is RlmRunStatus {
	return (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "deleted"
	);
}

function isSettledRunStatus(status: RlmRunStatus): status is "completed" | "failed" | "cancelled" {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalNoticeStatus(value: unknown): value is RlmTerminalNoticeStatus {
	return value === "none" || value === "pending" || value === "sent";
}

function isRegistryEvent(value: unknown): value is RlmChildRegistryEvent {
	if (!isRecord(value)) return false;
	return (
		value.type === "rlm_child" &&
		value.version === RLM_EVENT_VERSION &&
		typeof value.rlm_child_id === "string" &&
		value.rlm_child_id.length > 0 &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.parent_agent_id === "string" &&
		value.parent_agent_id.length > 0 &&
		isStringOrNull(value.parent_session_file) &&
		typeof value.session_dir === "string" &&
		value.session_dir.length > 0 &&
		isStringOrNull(value.session_file) &&
		isStringOrNull(value.session_id) &&
		typeof value.model === "string" &&
		value.model.length > 0 &&
		isStringOrNull(value.job_id) &&
		isFiniteNumber(value.task_depth) &&
		isFiniteNumber(value.max_depth) &&
		isRunStatus(value.run_status) &&
		isTerminalNoticeStatus(value.terminal_notice) &&
		typeof value.replied_to_parent === "boolean" &&
		isFiniteNumber(value.created_at) &&
		isFiniteNumber(value.updated_at) &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function assertNonEmptyString(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`RLM ${label} must be a non-empty string.`);
	return trimmed;
}

function toPublicStatus(status: RlmRunStatus): RlmChildStatus {
	if (status === "completed") return "completed";
	if (status === "cancelled") return "cancelled";
	if (status === "failed" || status === "deleted") return "failed";
	return "running";
}

async function sleepUntilPublication(signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(PUBLICATION_POLL_MS);
		return;
	}
	if (signal.aborted)
		throw signal.reason instanceof Error ? signal.reason : new Error("RLM message delivery aborted.");
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () =>
		reject(signal.reason instanceof Error ? signal.reason : new Error("RLM message delivery aborted."));
	signal.addEventListener("abort", onAbort, { once: true });
	void Bun.sleep(PUBLICATION_POLL_MS).then(resolve);
	try {
		await promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function hasReadableSessionFile(sessionFile: string | null): Promise<boolean> {
	if (!sessionFile) return false;
	try {
		const handle = await fs.open(sessionFile, "r");
		try {
			const stat = await handle.stat();
			return stat.isFile() && stat.size > 0;
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

/**
 * Parent-owned append-only registry for direct RLM children.
 *
 * Every mutation is serialized per sidecar path. The sidecar is the durable
 * truth; AgentRegistry is only projected residency and can be empty after a
 * restart without making an old queued/running child look live.
 */
export class RlmChildRegistry {
	static readonly #writeChains = new Map<string, Promise<void>>();
	/** Shared current projections prevent a cold-revived nested child from retaining its open-time sibling snapshot. */
	static readonly #recordProjections = new Map<string, Map<string, RlmChildRegistryEvent>>();
	static readonly #admissionReservations = new Map<string, Map<string, RlmAdmissionReservationState>>();

	readonly parent: RlmParentIdentity;
	readonly sidecarPath: string;
	readonly #agentRegistry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	#records = new Map<string, RlmChildRegistryEvent>();
	#pendingTerminalNoticeRetry: RlmPendingTerminalNoticeRetry | undefined;
	readonly #scopeKey: string;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	private constructor(parent: RlmParentIdentity) {
		this.parent = parent;
		this.sidecarPath = path.join(parent.artifactsDir, RLM_REGISTRY_FILENAME);
		this.#agentRegistry = parent.agentRegistry ?? AgentRegistry.global();
		this.#lifecycle = parent.lifecycle ?? AgentLifecycleManager.global();
		this.#scopeKey = `${this.sidecarPath}\u0000${parent.parentAgentId}`;
	}

	static async open(parent: RlmParentIdentity): Promise<RlmChildRegistry> {
		const parentAgentId = assertNonEmptyString(parent.parentAgentId, "parent agent id");
		if (!path.isAbsolute(parent.artifactsDir)) {
			throw new Error("RLM parent artifacts directory must be an absolute path.");
		}
		const registry = new RlmChildRegistry({ ...parent, parentAgentId });
		await registry.#serialized(async () => registry.#reloadUnsafe());
		return registry;
	}

	static sidecarPathFor(artifactsDir: string): string {
		return path.join(artifactsDir, RLM_REGISTRY_FILENAME);
	}

	static childSessionDirFor(artifactsDir: string, childId: string): string {
		return path.join(artifactsDir, RLM_CHILDREN_DIRECTORY, childId);
	}

	/** Stable synchronous projection backed by the latest sidecar mutation in this process. */
	snapshotEntries(): RlmChildRegistryEntry[] {
		const records = RlmChildRegistry.#recordProjections.get(this.#scopeKey) ?? this.#records;
		return [...records.values()]
			.filter(record => record.run_status !== "deleted")
			.map(record => this.#toEntry(record));
	}

	/** Parent teardown blocks new work and notification retries while durable rows remain readable. */
	get isDisposed(): boolean {
		return this.#disposed;
	}

	/** Register the bridge-owned retry path before {@link rehydrate} consumes durable pending notices. */
	setPendingTerminalNoticeRetry(retry: RlmPendingTerminalNoticeRetry): void {
		if (!this.#disposed) this.#pendingTerminalNoticeRetry = retry;
	}

	stopTerminalNoticeRetries(): void {
		this.#pendingTerminalNoticeRetry = undefined;
	}

	async reserveAdmission(input: RlmAdmissionRecord): Promise<RlmAdmissionReservation> {
		const normalized = this.#normalizeAdmission(input);
		return await this.#serialized(async () => {
			if (this.#disposed) throw new Error("RLM parent registry is disposing.");
			await this.#reloadUnsafe();
			this.#assertAdmissionAvailableUnsafe(normalized);
			const reservation: RlmAdmissionReservation = {
				rlmChildId: normalized.rlmChildId,
				name: normalized.name,
			};
			this.#reservationStatesUnsafe().set(reservation.rlmChildId, { reservation, input: normalized });
			return reservation;
		});
	}

	rollbackAdmission(reservation: RlmAdmissionReservation, jobId?: string): void {
		this.#releaseReservationUnsafe(reservation);
		if (jobId) this.parent.cancelJob?.(jobId, this.parent.parentAgentId);
	}

	async commitAdmission(reservation: RlmAdmissionReservation, jobId?: string | null): Promise<RlmChildInfo> {
		return await this.#serialized(async () => {
			const state = this.#reservationStatesUnsafe().get(reservation.rlmChildId);
			if (!state || state.reservation !== reservation) {
				throw new Error(`RLM admission reservation for "${reservation.rlmChildId}" is no longer active.`);
			}
			const sessionDir = RlmChildRegistry.childSessionDirFor(this.parent.artifactsDir, state.input.rlmChildId);
			const markerPath = path.join(sessionDir, ".keep");
			let markerWritten = false;
			try {
				if (this.#disposed) throw new Error("RLM parent registry is disposing.");
				await this.#reloadUnsafe();
				this.#assertAdmissionAvailableUnsafe(state.input, reservation);
				if (await Bun.file(markerPath).exists()) {
					throw new Error(`RLM child session directory "${sessionDir}" is already reserved.`);
				}
				// A marker is deliberately retained: admission has a durable, inspectable
				// directory before the background runner creates its transcript.
				await Bun.write(markerPath, "", { createPath: true });
				markerWritten = true;
				const now = Date.now();
				const record: RlmChildRegistryEvent = {
					type: "rlm_child",
					version: RLM_EVENT_VERSION,
					rlm_child_id: state.input.rlmChildId,
					name: state.input.name,
					parent_agent_id: this.parent.parentAgentId,
					parent_session_file: this.parent.parentSessionFile,
					session_dir: sessionDir,
					session_file: null,
					session_id: null,
					model: state.input.model,
					job_id: jobId ?? state.input.jobId ?? null,
					task_depth: state.input.taskDepth,
					max_depth: state.input.maxDepth,
					run_status: "queued",
					terminal_notice: "none",
					replied_to_parent: false,
					created_at: now,
					updated_at: now,
				};
				await this.#appendUnsafe(record);
				return this.#toInfo(record);
			} catch (error) {
				if (markerWritten) {
					await fs.rm(markerPath, { force: true }).catch(() => undefined);
					await fs.rmdir(sessionDir).catch(() => undefined);
				}
				throw error;
			} finally {
				this.#releaseReservationUnsafe(reservation);
			}
		});
	}

	/** Bind the async job only after durable admission has ruled out id/name collisions. */
	async bindJob(childId: string, jobId: string): Promise<void> {
		const target = assertNonEmptyString(childId, "child id");
		const normalizedJobId = assertNonEmptyString(jobId, "job id");
		await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const current = this.#requireActiveRecordUnsafe(target);
			if (current.job_id === normalizedJobId) return;
			await this.#appendUnsafe({ ...current, job_id: normalizedJobId, updated_at: Date.now() });
		});
	}

	async admit(input: RlmAdmissionRecord): Promise<RlmChildInfo> {
		const reservation = await this.reserveAdmission(input);
		try {
			return await this.commitAdmission(reservation, input.jobId);
		} catch (error) {
			this.rollbackAdmission(reservation);
			throw error;
		}
	}

	async list(): Promise<RlmChildInfo[]> {
		return await this.#serialized(async () => {
			await this.#reloadUnsafe();
			return [...this.#records.values()]
				.filter(record => record.run_status !== "deleted")
				.map(record => this.#toInfo(record));
		});
	}

	/** Refresh this in-memory projection from its durable sidecar. */
	async refresh(): Promise<void> {
		await this.#serialized(async () => this.#reloadUnsafe());
	}

	async resolveDirectChild(selector: string): Promise<RlmChildInfo> {
		const target = assertNonEmptyString(selector, "child selector");
		return await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const matches = [...this.#records.values()].filter(
				record => record.run_status !== "deleted" && (record.rlm_child_id === target || record.name === target),
			);
			if (matches.length !== 1) {
				throw new Error(`No unique direct RLM child matches "${target}".`);
			}
			return this.#toInfo(matches[0]!);
		});
	}

	async awaitPublication(childId: string, signal?: AbortSignal): Promise<RlmChildInfo> {
		const target = assertNonEmptyString(childId, "child id");
		for (;;) {
			const child = await this.resolveDirectChild(target);
			if (child.residency !== null || child.active_session_id !== null || child.session_id !== null) return child;
			if (child.run_status === "failed" || child.run_status === "cancelled" || child.run_status === "deleted") {
				throw new Error(`RLM child ${target} finished before it became messageable.`);
			}
			await sleepUntilPublication(signal);
		}
	}

	async markRunning(childId: string, publication: AgentSession | RlmRunningPublication): Promise<void> {
		const target = assertNonEmptyString(childId, "child id");
		await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const current = this.#requireActiveRecordUnsafe(target);
			if (isSettledRunStatus(current.run_status)) return;
			const ref = this.#agentRegistry.get(target);
			const session = this.#isAgentSession(publication) ? publication : publication.session;
			const sessionId =
				session?.sessionManager.getSessionId() ??
				(this.#isAgentSession(publication) ? null : (publication.sessionId ?? null));
			const sessionFile =
				session?.sessionManager.getSessionFile() ??
				(this.#isAgentSession(publication)
					? (ref?.sessionFile ?? current.session_file)
					: (publication.sessionFile ?? current.session_file));
			await this.#appendUnsafe({
				...current,
				session_id: sessionId,
				session_file: sessionFile,
				run_status: "running",
				updated_at: Date.now(),
			});
		});
	}

	async markSettled(childId: string, result: RlmSettlement): Promise<void> {
		const target = assertNonEmptyString(childId, "child id");
		await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const current = this.#requireActiveRecordUnsafe(target);
			if (isSettledRunStatus(current.run_status)) return;
			await this.#appendUnsafe({
				...current,
				terminal_notice: current.terminal_notice === "sent" ? "sent" : "pending",
				run_status: result.status,
				...(result.error ? { error: result.error } : {}),
				updated_at: Date.now(),
			});
		});
	}

	async markParentReply(childId: string): Promise<void> {
		const target = assertNonEmptyString(childId, "child id");
		await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const current = this.#requireActiveRecordUnsafe(target);
			if (current.replied_to_parent) return;
			await this.#appendUnsafe({ ...current, replied_to_parent: true, updated_at: Date.now() });
		});
	}

	async markTerminalNotice(childId: string, status: "pending" | "sent"): Promise<void> {
		const target = assertNonEmptyString(childId, "child id");
		await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const current = this.#requireActiveRecordUnsafe(target);
			if (current.terminal_notice === "sent" || current.terminal_notice === status) return;
			await this.#appendUnsafe({ ...current, terminal_notice: status, updated_at: Date.now() });
		});
	}

	async deleteDirectChild(selector: string, reason: string): Promise<RlmDeleteSubagentResult> {
		const target = assertNonEmptyString(selector, "child selector");
		const deletion = await this.#serialized(async () => {
			await this.#reloadUnsafe();
			const matches = [...this.#records.values()].filter(
				record => record.run_status !== "deleted" && (record.rlm_child_id === target || record.name === target),
			);
			if (matches.length !== 1) throw new Error(`No unique direct RLM child matches "${target}".`);
			const current = matches[0]!;
			const deleted: RlmChildRegistryEvent = {
				...current,
				run_status: "deleted",
				error: reason.trim() || "Deleted by parent.",
				updated_at: Date.now(),
			};
			await this.#appendUnsafe(deleted);
			return deleted;
		});

		if (deletion.job_id) this.parent.cancelJob?.(deletion.job_id, this.parent.parentAgentId);
		const ref = this.#agentRegistry.get(deletion.rlm_child_id);
		if (ref) await this.#lifecycle.release(deletion.rlm_child_id, ref, { tombstone: true });
		return { rlm_child_id: deletion.rlm_child_id, name: deletion.name, deleted: true };
	}

	/**
	 * Parent teardown owns all of its direct RLM work. It cancels only work that
	 * was still admitted/running, releases live or parked refs without tombstones,
	 * and leaves terminal durable rows available to the same parent after revival.
	 */
	disposeDirectChildren(reason = "Parent session disposed."): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		RlmChildRegistry.#admissionReservations.delete(this.#scopeKey);
		this.stopTerminalNoticeRetries();
		this.#disposePromise = this.#disposeDirectChildren(reason);
		return this.#disposePromise;
	}

	async #disposeDirectChildren(reason: string): Promise<void> {
		let children: Array<{ rlmChildId: string; jobId: string | null; cancelJob: boolean }> = [];
		try {
			await this.#serialized(async () => {
				await this.#reloadUnsafe();
				const current = [...this.#records.values()].filter(record => record.run_status !== "deleted");
				children = current.map(record => ({
					rlmChildId: record.rlm_child_id,
					jobId: record.job_id,
					cancelJob: record.run_status === "queued" || record.run_status === "running",
				}));
				for (const record of current) {
					if (record.run_status !== "queued" && record.run_status !== "running") continue;
					await this.#appendUnsafe({
						...record,
						run_status: "cancelled",
						terminal_notice: record.terminal_notice === "sent" ? "sent" : "pending",
						error: reason.trim() || "Parent session disposed.",
						updated_at: Date.now(),
					});
				}
			});
		} finally {
			await Promise.allSettled(
				children
					.filter(child => child.cancelJob && child.jobId)
					.map(async child => {
						this.parent.cancelJob?.(child.jobId!, this.parent.parentAgentId);
					}),
			);
			await Promise.allSettled(
				children.map(async child => {
					const ref = this.#agentRegistry.get(child.rlmChildId);
					if (ref?.parentId !== this.parent.parentAgentId) return;
					await this.#lifecycle.release(child.rlmChildId, ref);
				}),
			);
		}
	}

	/**
	 * Resolve durable records after process restart. A missing in-process job can
	 * never resume an old queued/running execution, so it is recorded as failed
	 * instead of claiming that a child is still running.
	 */
	async rehydrate(options?: { retryTerminalNotices?: boolean }): Promise<RlmChildInfo[]> {
		const children = await this.#serialized(async () => {
			await this.#reloadUnsafe();
			for (const record of [...this.#records.values()]) {
				if (record.run_status === "queued" || record.run_status === "running") {
					if (record.job_id && this.parent.isJobLive?.(record.job_id)) continue;
					await this.#appendUnsafe({
						...record,
						run_status: "failed",
						terminal_notice: record.terminal_notice === "sent" ? "sent" : "pending",
						error: "Interrupted: no live RLM job exists after restart.",
						updated_at: Date.now(),
					});
					continue;
				}
				if (isSettledRunStatus(record.run_status) && record.terminal_notice === "none") {
					await this.#appendUnsafe({ ...record, terminal_notice: "pending", updated_at: Date.now() });
				}
			}
			return [...this.#records.values()]
				.filter(record => record.run_status !== "deleted")
				.map(record => this.#toInfo(record));
		});
		try {
			const rehydratable: RlmChildInfo[] = [];
			for (const child of children) {
				if (await hasReadableSessionFile(child.session_file)) {
					rehydratable.push(child);
					continue;
				}
				this.#removeUnreadableParkedRef(child);
			}
			if (this.parent.rehydrateChild) {
				await Promise.all(rehydratable.map(child => this.parent.rehydrateChild?.(child)));
			}
		} finally {
			if (!this.#disposed && options?.retryTerminalNotices !== false) await this.retryPendingTerminalNotices();
		}
		return children;
	}

	async getPendingTerminalNotices(): Promise<RlmChildInfo[]> {
		const children = await this.list();
		return children.filter(child => child.terminal_notice === "pending");
	}

	/** Retry each durable pending terminal notice through the bridge registered for this live session. */
	async retryPendingTerminalNotices(): Promise<void> {
		if (this.#disposed) return;
		const retry = this.#pendingTerminalNoticeRetry;
		if (!retry) return;
		const pending = await this.getPendingTerminalNotices();
		if (this.#disposed) return;
		await Promise.allSettled(
			pending.map(async child => {
				if (!this.#disposed) await retry(child);
			}),
		);
	}

	async #serialized<T>(work: () => Promise<T>): Promise<T> {
		const previous = RlmChildRegistry.#writeChains.get(this.sidecarPath) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		RlmChildRegistry.#writeChains.set(
			this.sidecarPath,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return await next;
	}

	async #reloadUnsafe(): Promise<void> {
		let text = "";
		try {
			text = await Bun.file(this.sidecarPath).text();
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		const records = new Map<string, RlmChildRegistryEvent>();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRegistryEvent(parsed) && parsed.parent_agent_id === this.parent.parentAgentId) {
					records.set(parsed.rlm_child_id, parsed);
				}
			} catch {
				// A torn/corrupt line must not hide an earlier valid snapshot.
			}
		}
		this.#records = records;
		RlmChildRegistry.#recordProjections.set(this.#scopeKey, records);
	}

	async #appendUnsafe(record: RlmChildRegistryEvent): Promise<void> {
		const sidecarPath = this.sidecarPath;
		const line = `${JSON.stringify(record)}\n`;
		// Every mutation is an immutable event. Use the OS append flag so reopening
		// the registry can reconstruct every child and transition; writing through
		// a BunFile slice replaces the file rather than appending on current Bun.
		const handle = await fs.open(sidecarPath, "a", 0o600);
		try {
			await handle.writeFile(line, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		this.#records.set(record.rlm_child_id, record);
		const projection = RlmChildRegistry.#recordProjections.get(this.#scopeKey);
		if (projection && projection !== this.#records) projection.set(record.rlm_child_id, record);
	}

	#reservationStatesUnsafe(): Map<string, RlmAdmissionReservationState> {
		let states = RlmChildRegistry.#admissionReservations.get(this.#scopeKey);
		if (!states) {
			states = new Map<string, RlmAdmissionReservationState>();
			RlmChildRegistry.#admissionReservations.set(this.#scopeKey, states);
		}
		return states;
	}

	#normalizeAdmission(input: RlmAdmissionRecord): RlmAdmissionRecord {
		const rlmChildId = assertNonEmptyString(input.rlmChildId, "child id");
		const name = assertNonEmptyString(input.name, "child name");
		const model = assertNonEmptyString(input.model, "child model");
		if (!Number.isInteger(input.taskDepth) || input.taskDepth < 0) {
			throw new Error("RLM task depth must be a non-negative integer.");
		}
		if (!Number.isInteger(input.maxDepth) || input.maxDepth < -1) {
			throw new Error("RLM maximum depth must be -1 (unlimited) or a non-negative integer.");
		}
		return { ...input, rlmChildId, name, model };
	}

	#assertAdmissionAvailableUnsafe(input: RlmAdmissionRecord, ownReservation?: RlmAdmissionReservation): void {
		if (this.#records.has(input.rlmChildId)) {
			throw new Error(`RLM child id "${input.rlmChildId}" is already reserved by this parent.`);
		}
		if ([...this.#records.values()].some(record => record.run_status !== "deleted" && record.name === input.name)) {
			throw new Error(`RLM child name "${input.name}" is already in use by this parent.`);
		}
		for (const state of this.#reservationStatesUnsafe().values()) {
			if (state.reservation === ownReservation) continue;
			if (state.input.rlmChildId === input.rlmChildId) {
				throw new Error(`RLM child id "${input.rlmChildId}" is already reserved by this parent.`);
			}
			if (state.input.name === input.name) {
				throw new Error(`RLM child name "${input.name}" is already in use by this parent.`);
			}
		}
	}

	#releaseReservationUnsafe(reservation: RlmAdmissionReservation): void {
		const states = RlmChildRegistry.#admissionReservations.get(this.#scopeKey);
		if (!states?.get(reservation.rlmChildId) || states.get(reservation.rlmChildId)?.reservation !== reservation)
			return;
		states.delete(reservation.rlmChildId);
		if (states.size === 0) RlmChildRegistry.#admissionReservations.delete(this.#scopeKey);
	}

	#removeUnreadableParkedRef(child: RlmChildInfo): void {
		const ref = this.#agentRegistry.get(child.rlm_child_id);
		if (
			ref?.parentId === this.parent.parentAgentId &&
			ref.status === "parked" &&
			ref.session === null &&
			ref.sessionFile === child.session_file
		) {
			this.#agentRegistry.unregister(child.rlm_child_id, ref);
		}
	}
	#requireActiveRecordUnsafe(childId: string): RlmChildRegistryEvent {
		const record = this.#records.get(childId);
		if (!record || record.run_status === "deleted") {
			throw new Error(`RLM child "${childId}" is not an active direct child of this parent.`);
		}
		return record;
	}

	#isAgentSession(value: AgentSession | RlmRunningPublication): value is AgentSession {
		return "sessionManager" in value && value.sessionManager !== undefined;
	}

	#toInfo(record: RlmChildRegistryEvent): RlmChildInfo {
		const ref = this.#agentRegistry.get(record.rlm_child_id);
		const residency = ref?.status === "parked" ? "parked" : ref?.session ? "live" : null;
		const activeSessionId = ref?.session?.sessionManager.getSessionId() ?? null;
		return {
			rlm_child_id: record.rlm_child_id,
			name: record.name,
			session_dir: record.session_dir,
			model: record.model,
			run_status: record.run_status,
			residency,
			agent_id: record.rlm_child_id,
			active_session_id: activeSessionId,
			session_id: record.session_id,
			session_file: record.session_file,
			job_id: record.job_id,
			task_depth: record.task_depth,
			max_depth: record.max_depth,
			terminal_notice: record.terminal_notice,
			replied_to_parent: record.replied_to_parent,
			...(record.error ? { error: record.error } : {}),
		};
	}

	#toEntry(record: RlmChildRegistryEvent): RlmChildRegistryEntry {
		const info = this.#toInfo(record);
		return {
			rlm_child_id: info.rlm_child_id,
			active_session_id: info.active_session_id,
			session_id: info.session_id,
			session_name: info.name,
			session_dir: info.session_dir,
			status: toPublicStatus(info.run_status),
		};
	}
}
