/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { GoalModeState } from "../../goals/state";
import type { LspServerStatus } from "../../lsp";
import type { PlanModeState } from "../../plan-mode/state";
import type { AgentActivityState } from "../../registry/agent-activity";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { AsyncJobSnapshot } from "../../session/agent-session-types";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { AskToolDetails, AskToolInput } from "../../tools/ask";
import type { TodoPhase } from "../../tools/todo";
import type { VibeModeState } from "../../vibe/state";
import type {
	ApplyWorkspaceRestoreRequest,
	CreateWorkspaceCheckpointRequest,
	ListWorkspaceCheckpointsRequest,
	PreviewWorkspaceRestoreRequest,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
} from "../../workspace-checkpoints/types";
import type { RpcKeybindingsCatalog, RpcKeybindingsSnapshot } from "./rpc-keybindings-types";
import type {
	RpcMcpServerConfigInput,
	RpcMcpServerInfo,
	RpcPluginInfo,
	RpcPluginSelector,
} from "./rpc-management-types";
import type { RpcMessagesPage } from "./rpc-messages";
import type {
	RpcSettingPath,
	RpcSettingsCatalog,
	RpcSettingsLocale,
	RpcSettingsSnapshot,
	RpcSettingValue,
} from "./rpc-settings-types";

export type * from "./rpc-keybindings-types";
export type * from "./rpc-management-types";
export type * from "./rpc-settings-types";

export type RpcWorkspaceCheckpointCreateRequest = Omit<
	Pick<CreateWorkspaceCheckpointRequest, "label" | "parentId" | "pinned">,
	"label"
> & {
	label?: CreateWorkspaceCheckpointRequest["label"] | null;
	rootPath?: CreateWorkspaceCheckpointRequest["rootPath"];
};

export type RpcWorkspaceCheckpointListRequest = Pick<ListWorkspaceCheckpointsRequest, "limit"> & {
	rootPath?: ListWorkspaceCheckpointsRequest["rootPath"];
};

export type RpcWorkspaceRestorePreviewRequest = PreviewWorkspaceRestoreRequest & {
	rootPath?: ListWorkspaceCheckpointsRequest["rootPath"];
};

export type RpcNavigateTreeOptions = {
	summarize?: boolean;
	customInstructions?: string;
	allowAskReopen?: boolean;
	reanswerAskResult?: AgentToolResult<AskToolDetails>;
};

export type RpcNavigateTreeResult = {
	editorText?: string;
	editorImages?: ImageContent[];
	cancelled: boolean;
	aborted?: boolean;
	reopenAsk?: { toolCallId: string; questions: AskToolInput["questions"] };
	askReanswerCommitted?: boolean;
};
// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id?: string; type: "initialize_extensions" }
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_async_jobs"; recentLimit?: number }
	| { id?: string; type: "cancel_async_jobs" }
	| { id?: string; type: "get_settings_catalog"; locale?: RpcSettingsLocale }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "update_settings"; path: RpcSettingPath; value: RpcSettingValue }
	| { id?: string; type: "get_keybindings_catalog"; locale?: RpcSettingsLocale }
	| { id?: string; type: "get_keybindings" }
	| { id?: string; type: "update_keybinding"; keybinding: string; keys: string[] }
	| { id?: string; type: "reset_keybindings" }
	| { id?: string; type: "get_plugins" }
	| { id?: string; type: "set_plugin_enabled"; plugin: RpcPluginSelector; enabled: boolean }
	| { id?: string; type: "set_plugin_features"; name: string; features: string[] }
	| { id?: string; type: "set_plugin_setting"; name: string; key: string; value: RpcSettingValue }
	| { id?: string; type: "get_mcp_servers" }
	| { id?: string; type: "set_mcp_server_enabled"; name: string; enabled: boolean }
	| {
			id?: string;
			type: "add_mcp_server";
			name: string;
			scope: "user" | "project";
			config: RpcMcpServerConfigInput;
	  }
	| { id?: string; type: "remove_mcp_server"; name: string; scope: "user" | "project" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_active_tools"; toolNames: string[] }
	| { id?: string; type: "set_active_tool_presentation"; toolNames: string[]; mountedToolNames: string[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "maybe_start_title_generation"; firstMessage: string }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ConfiguredThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Workspace checkpoints
	| {
			id?: string;
			type: "workspace_checkpoint_create";
			request: RpcWorkspaceCheckpointCreateRequest;
	  }
	| {
			id?: string;
			type: "workspace_checkpoint_list";
			rootPath?: RpcWorkspaceCheckpointListRequest["rootPath"];
			limit?: RpcWorkspaceCheckpointListRequest["limit"];
	  }
	| {
			id?: string;
			type: "workspace_restore_preview";
			request: RpcWorkspaceRestorePreviewRequest;
	  }
	| { id?: string; type: "workspace_restore_apply"; request: ApplyWorkspaceRestoreRequest }
	| { id?: string; type: "workspace_undo"; scope?: WorkspaceRestoreScope }
	| { id?: string; type: "workspace_redo" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "navigate_tree"; entryId: string; options?: RpcNavigateTreeOptions }
	| { id?: string; type: "abort_branch_summary" }
	| { id?: string; type: "resume_after_ask_reanswer" }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined;
	isStreaming: boolean;
	isBashRunning?: boolean;
	isEvalRunning?: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	/** User-visible queued steering and follow-up messages; absent on older RPC hosts. */
	queuedMessages?: { steering: readonly string[]; followUp: readonly string[] };
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Snapshot of session-scoped asynchronous work; absent on older RPC hosts. */
	asyncJobs?: AsyncJobSnapshot | null;
	/** Live language-server status; absent on older RPC hosts. */
	lsp?: LspServerStatus[];
	/** Structured main-agent activity and active autonomous mode states. */
	activity?: AgentActivityState;
	planMode?: PlanModeState;
	goalMode?: GoalModeState;
	vibeMode?: VibeModeState;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	/** Owning top-level session identity; absent for pre-multisession producers. */
	sessionTitle?: string;
	sessionId?: string;
	activeTopLevelAgentId?: string;
	/** Latest structured activity even when no full progress consumer is attached. */
	activityState?: AgentActivityState;
	/** Direct mirror of live nested task state; also retained under `progress`. */
	inflightTaskDetails?: AgentProgress["inflightTaskDetails"];
	/** Persisted model/retry metadata when the live progress object is unavailable. */
	resolvedModel?: AgentProgress["resolvedModel"];
	resolvedModelIsFallback?: AgentProgress["resolvedModelIsFallback"];
	retryState?: AgentProgress["retryState"];
	retryFailure?: AgentProgress["retryFailure"];
	terminalStatus?: Extract<AgentProgress["status"], "completed" | "failed" | "aborted">;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "get_async_jobs";
			success: true;
			data: { asyncJobs: AsyncJobSnapshot | null };
	  }
	| { id?: string; type: "response"; command: "cancel_async_jobs"; success: true; data: { cancelled: number } }
	| { id?: string; type: "response"; command: "get_settings_catalog"; success: true; data: RpcSettingsCatalog }
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "update_settings"; success: true; data: RpcSettingsSnapshot }
	| { id?: string; type: "response"; command: "get_keybindings_catalog"; success: true; data: RpcKeybindingsCatalog }
	| { id?: string; type: "response"; command: "get_keybindings"; success: true; data: RpcKeybindingsSnapshot }
	| {
			id?: string;
			type: "response";
			command: "update_keybinding" | "reset_keybindings";
			success: true;
			data: RpcKeybindingsSnapshot;
	  }
	| { id?: string; type: "response"; command: "get_plugins"; success: true; data: { plugins: RpcPluginInfo[] } }
	| {
			id?: string;
			type: "response";
			command: "set_plugin_enabled" | "set_plugin_features" | "set_plugin_setting";
			success: true;
			data: { plugins: RpcPluginInfo[] };
	  }
	| { id?: string; type: "response"; command: "get_mcp_servers"; success: true; data: { servers: RpcMcpServerInfo[] } }
	| {
			id?: string;
			type: "response";
			command: "set_mcp_server_enabled" | "add_mcp_server" | "remove_mcp_server";
			success: true;
			data: { servers: RpcMcpServerInfo[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| {
			id?: string;
			type: "response";
			command: "set_active_tools" | "set_active_tool_presentation";
			success: true;
			data: { activeToolNames: string[]; mountedToolNames: string[] };
	  }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ConfiguredThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "maybe_start_title_generation"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Workspace checkpoints
	| {
			id?: string;
			type: "response";
			command: "workspace_checkpoint_create";
			success: true;
			data: { record: WorkspaceCheckpointRecord };
	  }
	| {
			id?: string;
			type: "response";
			command: "workspace_checkpoint_list";
			success: true;
			data: { records: WorkspaceCheckpointRecord[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "workspace_restore_preview";
			success: true;
			data: { plan: WorkspaceRestorePlan };
	  }
	| {
			id?: string;
			type: "response";
			command: "workspace_restore_apply";
			success: true;
			data: { result: WorkspaceRestoreResult };
	  }
	| {
			id?: string;
			type: "response";
			command: "workspace_undo";
			success: true;
			data: { result: WorkspaceRestoreResult };
	  }
	| {
			id?: string;
			type: "response";
			command: "workspace_redo";
			success: true;
			data: { result: WorkspaceRestoreResult };
	  }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
