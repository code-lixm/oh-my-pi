import type { Model } from "@oh-my-pi/pi-ai";
import type { OmpJsonValue } from "../../shared/omp-view-model";

export interface OmpRpcBashResult {
	output: string;
	exitCode?: number;
	cancelled: boolean;
	timedOut?: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	workingDir?: string;
}

export type OmpRpcCheckpointCreateRequest = {
	label?: string | null;
	rootPath?: string;
	parentId?: string;
	pinned?: boolean;
};

export type OmpRpcCheckpointListRequest = {
	limit?: number;
	rootPath?: string;
};

export type OmpRpcRestorePreviewRequest = {
	rootPath?: string;
	checkpointId: string;
	scope: "code" | "conversation" | "all";
	strategy: "preserve" | "exact";
	paths?: string[];
};

export type OmpRpcRestoreApplyRequest = {
	planId: string;
	allowConflicts?: boolean;
};

declare module "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client" {
	interface RpcSessionState {
		isCompacting?: boolean;
		isBashRunning?: boolean;
		isEvalRunning?: boolean;
		sessionName?: string;
		steeringMode?: "all" | "one-at-a-time";
		followUpMode?: "all" | "one-at-a-time";
		interruptMode?: "immediate" | "wait";
		autoCompactionEnabled?: boolean;
		fastModeEnabled?: boolean;
		fastModeActive?: boolean;
		tokensPerSecond?: number | null;
		messageCount?: number;
		queuedMessageCount?: number;
		asyncJobs?: OmpJsonValue | null;
		lsp?: OmpJsonValue;
		dumpTools?: Array<{ name: string; description: string }>;
		activity?: OmpJsonValue;
		planMode?: OmpJsonValue;
		goalMode?: OmpJsonValue;
		vibeMode?: OmpJsonValue;
		contextUsage?: OmpJsonValue;
	}

	interface ModelInfo {
		name?: Model["name"];
		api?: Model["api"];
		baseUrl?: Model["baseUrl"];
		input?: Model["input"];
		supportsTools?: Model["supportsTools"];
		cost?: Model["cost"];
		maxTokens?: Model["maxTokens"];
		compat?: Model["compat"];
	}

	interface RpcClient {
		newSession(parentSession?: string): Promise<{ cancelled: boolean }>;
		setSessionName(name: string): Promise<void>;
		bash(command: string): Promise<OmpRpcBashResult>;
		abortBash(): Promise<void>;
		setSubagentSubscription(level: "off" | "progress" | "events"): Promise<"off" | "progress" | "events">;
		getSubagents(): Promise<OmpJsonValue[]>;
		onSubagentLifecycle(listener: (payload: OmpJsonValue) => void): () => void;
		onSubagentProgress(listener: (payload: OmpJsonValue) => void): () => void;
		onSubagentEvent(listener: (payload: OmpJsonValue) => void): () => void;
		getAsyncJobs(recentLimit?: number): Promise<OmpJsonValue | null>;
		cancelAsyncJobs(): Promise<number>;
		createWorkspaceCheckpoint(request?: OmpRpcCheckpointCreateRequest): Promise<OmpJsonValue>;
		listWorkspaceCheckpoints(request?: OmpRpcCheckpointListRequest): Promise<OmpJsonValue[]>;
		previewWorkspaceRestore(request: OmpRpcRestorePreviewRequest): Promise<OmpJsonValue>;
		applyWorkspaceRestore(request: OmpRpcRestoreApplyRequest): Promise<OmpJsonValue>;
		undoWorkspace(scope?: "code" | "conversation" | "all"): Promise<OmpJsonValue>;
		redoWorkspace(): Promise<OmpJsonValue>;
		getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
		branch(entryId: string): Promise<{ text: string; cancelled: boolean }>;
		handoff(customInstructions?: string): Promise<{ savedPath?: string } | null>;
		exportHtml(): Promise<{ path: string }>;
		login(providerId: string): Promise<{ providerId: string }>;
		getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>>;
	}
}
