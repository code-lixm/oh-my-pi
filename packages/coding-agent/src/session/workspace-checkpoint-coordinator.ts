/**
 * Session-local coordinator over the optional `WorkspaceCheckpointService`.
 */

import type { ExtensionRunner } from "../extensibility/extensions";
import type {
	CreateWorkspaceCheckpointRequest,
	PreviewWorkspaceRestoreRequest,
	WorkspaceCheckpointConversationAdapter,
	WorkspaceCheckpointMutatorGuard,
	WorkspaceCheckpointReason,
	WorkspaceCheckpointRecord,
	WorkspaceCheckpointService,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
	WorkspaceRestoreStrategy,
} from "../workspace-checkpoints/types";
import { WORKSPACE_CONVERSATION_ROOT_ENTRY_ID } from "../workspace-checkpoints/types";
import type { WorkspaceCheckpointEntry, WorkspaceRestoreEntry } from "./session-entries";

export type WorkspaceCheckpointFailureReason =
	| "service_unavailable"
	| "mutator_active"
	| "lock_unavailable"
	| "io"
	| "scan"
	| "git"
	| "internal";

export type WorkspaceCheckpointBoundaryResult =
	| { status: "created"; entry: WorkspaceCheckpointEntry }
	| { status: "skipped"; reason: "disabled" | "auto_off" | "service_unavailable" | "cancelled" }
	| { status: "failed"; reason: WorkspaceCheckpointFailureReason; error: unknown };

export interface WorkspaceCheckpointCursor {
	undoHeadCheckpointId: string | null;
	redoHeadCheckpointId: string | null;
	lastCheckpointId: string | null;
}

export type WorkspaceRestoreSkipReason = "mutator_active" | "lock_unavailable" | "service_unavailable" | "no_undo";

export interface WorkspaceCheckpointAccessResult<T> {
	available: boolean;
	reason?: WorkspaceRestoreSkipReason | "invalid_request";
	value?: T;
	error?: unknown;
}

export class WorkspaceCheckpointUnavailableError extends Error {
	override readonly name = "WorkspaceCheckpointUnavailableError";
	constructor(message?: string) {
		super(message ?? "Workspace checkpoint service is not configured for this session");
	}
}

export interface WorkspaceCheckpointCoordinator {
	isAvailable(): boolean;
	cursor(rootPath?: string): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointCursor>>;
	createWorkspaceCheckpoint(
		label: string | null | undefined,
		options?: { rootPath?: string; parentId?: string; pinned?: boolean },
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointRecord>>;
	listWorkspaceCheckpoints(options?: {
		rootPath?: string;
		limit?: number;
	}): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointRecord[]>>;
	captureIgnoredPathBaseline(path: string): Promise<void>;
	previewWorkspaceRestore(
		request: PreviewWorkspaceRestoreRequest & { rootPath?: string },
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>;
	applyWorkspaceRestore(
		planId: string,
		allowConflicts?: boolean,
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	undoWorkspace(scope?: WorkspaceRestoreScope): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	redoWorkspace(): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	takeTurnBoundary(label: string | null): Promise<WorkspaceCheckpointBoundaryResult>;
	takeUserBashBoundary(command: string): Promise<WorkspaceCheckpointBoundaryResult>;
	takeTaskMergeBoundary(taskId: string): Promise<WorkspaceCheckpointBoundaryResult>;
	takeRestoreGuard(): Promise<WorkspaceCheckpointBoundaryResult>;
	restoreWithGuard(
		preview: WorkspaceRestorePlan,
		allowConflicts: boolean,
	): Promise<WorkspaceCheckpointAccessResult<{ entry: WorkspaceRestoreEntry }>>;
	refreshCursor(): Promise<WorkspaceCheckpointCursor | undefined>;
}

export interface WorkspaceCheckpointServiceRequestOverrides {
	rootPath?: string;
	sessionId?: string;
	sessionEntryId?: string;
}

export interface WorkspaceCheckpointCoordinatorHost {
	withWorkspaceRestoreLock?<T>(body: () => Promise<T>): Promise<T>;
	getCwd(): string;
	getSessionId(): string | null;
	getSessionLeafId(): string | null;
	getService(): WorkspaceCheckpointService | undefined;
	getConversationAdapter(): WorkspaceCheckpointConversationAdapter | undefined;
	getMutatorGuard(): WorkspaceCheckpointMutatorGuard | undefined;
	resolveAutoMode(): "off" | "turn";
	resolveEnabled(): boolean;
	resolveFailurePolicy(): "block" | "warn" | "ignore";
	getExtensionRunner?(): ExtensionRunner | undefined;
	logInfo(message: string, fields?: Record<string, unknown>): void;
	logWarn(message: string, fields?: Record<string, unknown>): void;
	logError(message: string, fields?: Record<string, unknown>): void;
	appendCheckpointEntry(
		entry: Omit<WorkspaceCheckpointEntry, "id" | "parentId" | "timestamp"> & { timestamp?: string },
	): string;
	appendRestoreEntry(
		entry: Omit<WorkspaceRestoreEntry, "id" | "parentId" | "timestamp"> & { timestamp?: string },
	): string;
	getServiceOptions(): WorkspaceCheckpointServiceRequestOverrides;
}

function unavailableResult<T>(reason: WorkspaceRestoreSkipReason): WorkspaceCheckpointAccessResult<T> {
	return { available: false, reason };
}

function nowIso(): string {
	return new Date().toISOString();
}

function applyServiceOverrides<T extends { rootPath: string }>(
	base: T,
	overrides: WorkspaceCheckpointServiceRequestOverrides,
): T {
	return {
		...base,
		...(overrides.rootPath ? { rootPath: overrides.rootPath } : {}),
		...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
	};
}

function classifyFailure(error: unknown): WorkspaceCheckpointFailureReason {
	if (!(error instanceof Error)) return "internal";
	const message = error.message.toLowerCase();
	if (message.includes("active mutator") || message.includes("mutator")) return "mutator_active";
	if (message.includes("workspace lock unavailable") || message.includes("lock unavailable"))
		return "lock_unavailable";
	if (message.includes("eacces") || message.includes("eperm") || message.includes("enoent")) return "io";
	if (message.includes("scan")) return "scan";
	if (message.includes("git")) return "git";
	return "internal";
}

function classifyAccessFailure(error: unknown): WorkspaceRestoreSkipReason {
	const reason = classifyFailure(error);
	return reason === "mutator_active" || reason === "lock_unavailable" ? reason : "service_unavailable";
}

async function emitCheckpointCreated(
	runner: ExtensionRunner | undefined,
	event: {
		checkpointId: string;
		workspaceId: string;
		reason: WorkspaceCheckpointReason;
		label?: string | null;
		manifestObjectId: string;
		fileCount: number;
		totalBytes: number;
		guardCheckpointId?: string | null;
		sessionEntryId?: string | null;
	},
): Promise<void> {
	if (!runner) return;
	try {
		await runner.emit({ type: "workspace_checkpoint_created", ...event });
	} catch {
		// advisory hook — never fail the boundary on handler throw
	}
}

async function emitCheckpointFailed(
	runner: ExtensionRunner | undefined,
	event: { reason: WorkspaceCheckpointReason; failureReason: WorkspaceCheckpointFailureReason; error?: unknown },
): Promise<void> {
	if (!runner) return;
	try {
		await runner.emit({
			type: "workspace_checkpoint_failed",
			reason: event.reason,
			failureReason: event.failureReason,
			error: event.error instanceof Error ? event.error.message : String(event.error ?? ""),
		});
	} catch {
		// ignore
	}
}

async function emitCheckpointBefore(
	runner: ExtensionRunner | undefined,
	event: { reason: WorkspaceCheckpointReason; label?: string | null },
): Promise<boolean> {
	if (!runner?.hasHandlers("workspace_checkpoint_before")) return false;
	try {
		const result = (await runner.emit({
			type: "workspace_checkpoint_before",
			reason: event.reason,
			label: event.label ?? undefined,
		})) as { cancel?: boolean } | undefined;
		return Boolean(result?.cancel);
	} catch {
		return false;
	}
}

async function emitCheckpointCompleted(
	runner: ExtensionRunner | undefined,
	event: {
		operation: "restore" | "undo" | "redo";
		planId: string;
		checkpointId: string;
		transactionId: string;
		restoredPaths: readonly string[];
		skippedPaths: readonly string[];
		redoAvailable: boolean;
	},
): Promise<void> {
	if (!runner) return;
	try {
		await runner.emit({ type: "workspace_checkpoint_completed", ...event });
	} catch {
		// ignore
	}
}

export function createWorkspaceCheckpointCoordinator(
	host: WorkspaceCheckpointCoordinatorHost,
): WorkspaceCheckpointCoordinator {
	let lastCursor: WorkspaceCheckpointCursor | undefined;

	function tryResolveService():
		| { service: WorkspaceCheckpointService; rootPath: string; sessionId: string | null }
		| undefined {
		const service = host.getService();
		if (!service) return undefined;
		const options = host.getServiceOptions();
		const rootPath = options.rootPath ?? host.getCwd();
		if (!rootPath) return undefined;
		return {
			service,
			rootPath,
			sessionId: options.sessionId ?? host.getSessionId(),
		};
	}

	function getRunner(): ExtensionRunner | undefined {
		return host.getExtensionRunner?.();
	}

	async function withRestoreLock<T>(rootPath: string, fn: () => Promise<T>): Promise<T> {
		void rootPath;
		if (!host.withWorkspaceRestoreLock) return fn();
		return host.withWorkspaceRestoreLock(fn);
	}

	function baseRequest(
		reason: WorkspaceCheckpointReason,
		label: string | null,
	): CreateWorkspaceCheckpointRequest | undefined {
		const svc = tryResolveService();
		if (!svc) return undefined;
		const leafId = host.getSessionLeafId();
		const overrides = host.getServiceOptions();
		const request: CreateWorkspaceCheckpointRequest = {
			rootPath: svc.rootPath,
			reason,
			label: label ?? undefined,
			sessionId: svc.sessionId ?? undefined,
			sessionEntryId: leafId ?? WORKSPACE_CONVERSATION_ROOT_ENTRY_ID,
		};
		return applyServiceOverrides(request, overrides);
	}

	async function takeBoundary(
		reason: WorkspaceCheckpointReason,
		label: string | null,
	): Promise<WorkspaceCheckpointBoundaryResult> {
		if (!host.resolveEnabled()) return { status: "skipped", reason: "disabled" };
		if (reason === "turn" && host.resolveAutoMode() === "off") {
			return { status: "skipped", reason: "auto_off" };
		}
		const runner = getRunner();
		if (await emitCheckpointBefore(runner, { reason, label })) {
			return { status: "skipped", reason: "cancelled" };
		}
		const request = baseRequest(reason, label);
		if (!request) {
			await emitCheckpointFailed(runner, { reason, failureReason: "service_unavailable" });
			return { status: "skipped", reason: "service_unavailable" };
		}
		const svc = tryResolveService();
		if (!svc) {
			await emitCheckpointFailed(runner, { reason, failureReason: "service_unavailable" });
			return { status: "skipped", reason: "service_unavailable" };
		}
		const mutatorGuard = host.getMutatorGuard();
		if (mutatorGuard?.isMutatorActive()) {
			const err = new Error("Mutating tool already active when taking checkpoint");
			await emitCheckpointFailed(runner, { reason, failureReason: "mutator_active", error: err });
			return { status: "failed", reason: "mutator_active", error: err };
		}
		try {
			const record = await svc.service.create(request);
			const entry: Omit<WorkspaceCheckpointEntry, "id" | "parentId" | "timestamp"> = {
				type: "workspace_checkpoint",
				checkpointId: record.id,
				workspaceId: record.workspaceId,
				rootPath: record.rootPath,
				reason,
				label: record.label ?? null,
				manifestObjectId: record.manifestObjectId,
				fileCount: record.fileCount,
				totalBytes: record.totalBytes,
				guardCheckpointId: record.parentId ?? null,
				createdAt: record.createdAt,
			};
			const id = host.appendCheckpointEntry(entry);
			lastCursor = {
				undoHeadCheckpointId: record.id,
				redoHeadCheckpointId: null,
				lastCheckpointId: record.id,
			};
			host.logInfo("workspace checkpoint created", { checkpointId: record.id, reason, id });
			await emitCheckpointCreated(runner, {
				checkpointId: record.id,
				workspaceId: record.workspaceId,
				reason,
				label: record.label,
				manifestObjectId: record.manifestObjectId,
				fileCount: record.fileCount,
				totalBytes: record.totalBytes,
				guardCheckpointId: record.parentId ?? null,
				sessionEntryId: host.getSessionLeafId(),
			});
			return { status: "created", entry: { ...entry, id, parentId: "", timestamp: nowIso() } };
		} catch (error) {
			host.logError("workspace checkpoint failed", {
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
			const failureReason = classifyFailure(error);
			await emitCheckpointFailed(runner, { reason, failureReason, error });
			return { status: "failed", reason: failureReason, error };
		}
	}

	async function waitForIdle(timeoutMs?: number): Promise<boolean> {
		const guard = host.getMutatorGuard();
		if (!guard) return true;
		if (!guard.isMutatorActive()) return true;
		try {
			await guard.waitForIdle(timeoutMs);
			return true;
		} catch (error) {
			host.logWarn("workspace checkpoint: waitForIdle failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	async function refreshCursor(): Promise<WorkspaceCheckpointCursor | undefined> {
		const svc = tryResolveService();
		if (!svc) return lastCursor;
		try {
			const list = await svc.service.list({
				rootPath: svc.rootPath,
				sessionId: svc.sessionId ?? undefined,
				limit: 1,
			});
			const latest = list[0];
			lastCursor = {
				undoHeadCheckpointId: latest?.id ?? null,
				redoHeadCheckpointId: lastCursor?.redoHeadCheckpointId ?? null,
				lastCheckpointId: latest?.id ?? null,
			};
			return lastCursor;
		} catch (error) {
			host.logWarn("workspace checkpoint: refresh cursor failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return lastCursor;
		}
	}

	function appendRestoreForOperation(
		op: "restore" | "undo" | "redo",
		planId: string,
		result: WorkspaceRestoreResult,
		scope: "code" | "conversation" | "all",
		strategy: "preserve" | "exact",
	): string {
		return host.appendRestoreEntry({
			type: "workspace_restore",
			planId,
			checkpointId: result.checkpointId,
			guardCheckpointId: result.guardCheckpointId,
			restoredPaths: result.restoredPaths,
			skippedPaths: result.skippedPaths,
			conversationEntryId: result.conversationEntryId,
			redoAvailable: op === "redo" ? false : result.redoAvailable,
			scope,
			strategy,
			createdAt: nowIso(),
		});
	}

	async function performRestore(
		op: "restore" | "undo" | "redo",
		rootPath: string,
		planId: string,
		allowConflicts: boolean,
		scope: WorkspaceRestoreScope = "all",
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>> {
		const guard = host.getMutatorGuard();
		if (guard?.isMutatorActive()) {
			const settled = await waitForIdle(5_000);
			if (!settled) return unavailableResult("mutator_active");
		}
		const svc = tryResolveService();
		if (!svc) return unavailableResult("service_unavailable");
		let result: WorkspaceRestoreResult;
		try {
			if (op === "restore") {
				result = await withRestoreLock(rootPath, () => svc.service.restore({ planId, allowConflicts }));
			} else if (op === "undo") {
				result = await withRestoreLock(rootPath, () =>
					svc.service.undo({
						rootPath,
						sessionId: svc.sessionId ?? undefined,
						scope,
					}),
				);
			} else {
				result = await withRestoreLock(rootPath, () =>
					svc.service.redo({ rootPath, sessionId: svc.sessionId ?? undefined }),
				);
			}
		} catch (error) {
			return { available: false, reason: classifyAccessFailure(error), error };
		}
		appendRestoreForOperation(op, planId, result, scope, "preserve");
		lastCursor = {
			undoHeadCheckpointId: result.checkpointId,
			redoHeadCheckpointId:
				op === "redo" ? null : result.redoAvailable ? (lastCursor?.undoHeadCheckpointId ?? null) : null,
			lastCheckpointId: lastCursor?.lastCheckpointId ?? null,
		};
		await emitCheckpointCompleted(getRunner(), {
			operation: op,
			planId,
			checkpointId: result.checkpointId,
			transactionId: result.transactionId,
			restoredPaths: result.restoredPaths,
			skippedPaths: result.skippedPaths,
			redoAvailable: result.redoAvailable,
		});
		return { available: true, value: result };
	}

	return {
		isAvailable() {
			return tryResolveService() !== undefined;
		},
		async cursor(rootPath) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			const effectiveRoot = rootPath ?? svc.rootPath;
			try {
				const list = await svc.service.list({
					rootPath: effectiveRoot,
					sessionId: svc.sessionId ?? undefined,
					limit: 1,
				});
				const latest = list[0];
				const cursor: WorkspaceCheckpointCursor = {
					undoHeadCheckpointId: latest?.id ?? null,
					redoHeadCheckpointId: lastCursor?.redoHeadCheckpointId ?? null,
					lastCheckpointId: latest?.id ?? null,
				};
				lastCursor = cursor;
				return { available: true, value: cursor };
			} catch (error) {
				return { available: false, reason: classifyAccessFailure(error), error };
			}
		},
		async createWorkspaceCheckpoint(label, options) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			const runner = getRunner();
			if (await emitCheckpointBefore(runner, { reason: "manual", label: label ?? null })) {
				return unavailableResult("service_unavailable");
			}
			const overrides = host.getServiceOptions();
			const request: CreateWorkspaceCheckpointRequest = {
				rootPath: options?.rootPath ?? svc.rootPath,
				reason: "manual",
				label: label ?? undefined,
				parentId: options?.parentId,
				sessionId: svc.sessionId ?? undefined,
				sessionEntryId: host.getSessionLeafId() ?? WORKSPACE_CONVERSATION_ROOT_ENTRY_ID,
				pinned: options?.pinned,
			};
			try {
				const record = await svc.service.create(applyServiceOverrides(request, overrides));
				host.appendCheckpointEntry({
					type: "workspace_checkpoint",
					checkpointId: record.id,
					workspaceId: record.workspaceId,
					rootPath: record.rootPath,
					reason: "manual",
					label: record.label,
					manifestObjectId: record.manifestObjectId,
					fileCount: record.fileCount,
					totalBytes: record.totalBytes,
					guardCheckpointId: record.parentId ?? null,
					createdAt: record.createdAt,
				});
				lastCursor = {
					undoHeadCheckpointId: record.id,
					redoHeadCheckpointId: null,
					lastCheckpointId: record.id,
				};
				await emitCheckpointCreated(runner, {
					checkpointId: record.id,
					workspaceId: record.workspaceId,
					reason: "manual",
					label: record.label,
					manifestObjectId: record.manifestObjectId,
					fileCount: record.fileCount,
					totalBytes: record.totalBytes,
					guardCheckpointId: record.parentId ?? null,
					sessionEntryId: host.getSessionLeafId(),
				});
				return { available: true, value: record };
			} catch (error) {
				await emitCheckpointFailed(runner, {
					reason: "manual",
					failureReason: classifyFailure(error),
					error,
				});
				return { available: false, reason: classifyAccessFailure(error), error };
			}
		},
		async listWorkspaceCheckpoints(options) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			try {
				const list = await svc.service.list({
					rootPath: options?.rootPath ?? svc.rootPath,
					sessionId: svc.sessionId ?? undefined,
					limit: options?.limit,
				});
				return { available: true, value: list };
			} catch (error) {
				return { available: false, reason: classifyAccessFailure(error), error };
			}
		},
		async captureIgnoredPathBaseline(path) {
			if (!host.resolveEnabled()) return;
			const svc = tryResolveService();
			if (!svc?.service.captureIgnoredPathBaseline) return;
			const overrides = host.getServiceOptions();
			await svc.service.captureIgnoredPathBaseline({
				rootPath: overrides.rootPath ?? svc.rootPath,
				path,
				sessionId: overrides.sessionId ?? svc.sessionId ?? undefined,
			});
		},
		async previewWorkspaceRestore(request) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			try {
				const built: PreviewWorkspaceRestoreRequest = {
					checkpointId: request.checkpointId,
					scope: request.scope,
					strategy: request.strategy,
					paths: request.paths,
				};
				const plan = await svc.service.previewRestore(built);
				return { available: true, value: plan };
			} catch (error) {
				return { available: false, reason: classifyAccessFailure(error), error };
			}
		},
		async applyWorkspaceRestore(planId, allowConflicts) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			return performRestore("restore", svc.rootPath, planId, allowConflicts ?? false);
		},
		async undoWorkspace(scope) {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			return performRestore("undo", svc.rootPath, "", false, scope ?? "all");
		},
		async redoWorkspace() {
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			return performRestore("redo", svc.rootPath, "", false);
		},
		takeTurnBoundary(label) {
			return takeBoundary("turn", label);
		},
		takeUserBashBoundary(_command) {
			return takeBoundary("user_bash", "user_bash");
		},
		takeTaskMergeBoundary(taskId) {
			return takeBoundary("task_merge", taskId);
		},
		takeRestoreGuard() {
			return takeBoundary("restore_guard", "restore_guard");
		},
		async restoreWithGuard(preview, allowConflicts) {
			const guard = host.getMutatorGuard();
			if (guard?.isMutatorActive()) {
				const settled = await waitForIdle(5_000);
				if (!settled) return unavailableResult("mutator_active");
			}
			const guardResult = await takeBoundary("restore_guard", "restore_guard");
			if (guardResult.status !== "created") {
				return unavailableResult("service_unavailable");
			}
			const svc = tryResolveService();
			if (!svc) return unavailableResult("service_unavailable");
			let result: WorkspaceRestoreResult;
			try {
				result = await withRestoreLock(svc.rootPath, () =>
					svc.service.restore({
						planId: preview.id,
						allowConflicts,
					}),
				);
			} catch (error) {
				return { available: false, reason: classifyAccessFailure(error), error };
			}
			const id = host.appendRestoreEntry({
				type: "workspace_restore",
				planId: preview.id,
				checkpointId: result.checkpointId,
				guardCheckpointId: guardResult.entry.checkpointId,
				restoredPaths: result.restoredPaths,
				skippedPaths: result.skippedPaths,
				conversationEntryId: result.conversationEntryId,
				redoAvailable: result.redoAvailable,
				scope: preview.scope,
				strategy: preview.strategy,
				createdAt: nowIso(),
			});
			lastCursor = {
				undoHeadCheckpointId: result.checkpointId,
				redoHeadCheckpointId: result.redoAvailable ? (lastCursor?.undoHeadCheckpointId ?? null) : null,
				lastCheckpointId: lastCursor?.lastCheckpointId ?? null,
			};
			await emitCheckpointCompleted(getRunner(), {
				operation: "restore",
				planId: preview.id,
				checkpointId: result.checkpointId,
				transactionId: result.transactionId,
				restoredPaths: result.restoredPaths,
				skippedPaths: result.skippedPaths,
				redoAvailable: result.redoAvailable,
			});
			return {
				available: true,
				value: {
					entry: {
						type: "workspace_restore",
						id,
						parentId: "",
						timestamp: nowIso(),
						planId: preview.id,
						checkpointId: result.checkpointId,
						guardCheckpointId: guardResult.entry.checkpointId,
						restoredPaths: result.restoredPaths,
						skippedPaths: result.skippedPaths,
						conversationEntryId: result.conversationEntryId,
						redoAvailable: result.redoAvailable,
						scope: preview.scope,
						strategy: preview.strategy,
						createdAt: nowIso(),
					},
				},
			};
		},
		refreshCursor,
	};
}

export type { WorkspaceRestoreScope, WorkspaceRestoreStrategy };
