import * as path from "node:path";
import { createAgentSession } from "../sdk";
import { SessionManager } from "../session/session-manager";
import type {
	WorkspaceCheckpointRecord,
	WorkspaceCheckpointService,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
	WorkspaceRestoreStrategy,
} from "../workspace-checkpoints";
import { createWorkspaceCheckpointService } from "../workspace-checkpoints/service";

export type WorkspaceCheckpointAccessResult<T> = {
	available: boolean;
	reason?: string;
	value?: T;
};

export type WorkspaceCheckpointSessionApi = {
	createWorkspaceCheckpoint(
		label?: string | null,
		options?: { rootPath?: string; parentId?: string; pinned?: boolean },
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointRecord>>;
	listWorkspaceCheckpoints(options?: {
		rootPath?: string;
		limit?: number;
	}): Promise<WorkspaceCheckpointAccessResult<WorkspaceCheckpointRecord[]>>;
	previewWorkspaceRestore(request: {
		checkpointId: string;
		scope: WorkspaceRestoreScope;
		strategy: WorkspaceRestoreStrategy;
		paths?: string[];
		rootPath?: string;
	}): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>;
	applyWorkspaceRestore(
		planId: string,
		allowConflicts?: boolean,
	): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	undoWorkspace(scope?: WorkspaceRestoreScope): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	redoWorkspace(): Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	dispose(): Promise<void>;
};

export async function createOfflineWorkspaceCheckpointService(input: {
	rootPath: string;
	agentDir: string;
	enabled: boolean;
	retention: { maxPerSession: number; maxAgeDays: number };
}): Promise<WorkspaceCheckpointService> {
	return await createWorkspaceCheckpointService({
		rootPath: input.rootPath,
		agentDir: input.agentDir,
		storeDir: path.join(input.agentDir, "checkpoints", "v1"),
		enabled: input.enabled,
		retention: input.retention,
	});
}

export async function openWorkspaceCheckpointSession(input: {
	sessionPath: string;
	agentDir: string;
}): Promise<{ rootPath: string; session: WorkspaceCheckpointSessionApi }> {
	const sessionManager = await SessionManager.open(path.resolve(input.sessionPath));
	const rootPath = sessionManager.getCwd();
	const created = await createAgentSession({
		cwd: rootPath,
		agentDir: input.agentDir,
		sessionManager,
	});
	return {
		rootPath,
		session: created.session as unknown as WorkspaceCheckpointSessionApi,
	};
}

export function unwrapWorkspaceCheckpointAccess<T>(access: WorkspaceCheckpointAccessResult<T>, fallback: string): T {
	if (access.available !== true || access.value === undefined) {
		throw new Error(access.reason ?? fallback);
	}
	return access.value;
}
