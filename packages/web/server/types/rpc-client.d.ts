import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	RpcKeybindingsCatalog,
	RpcKeybindingsSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-keybindings-types";
import type {
	RpcMcpServerConfigInput,
	RpcMcpServerInfo,
	RpcPluginInfo,
	RpcPluginSelector,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-management-types";
import type {
	RpcSettingPath,
	RpcSettingsCatalog,
	RpcSettingsLocale,
	RpcSettingsSnapshot,
	RpcSettingValue,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

export type ConfiguredThinkingLevel =
	| "inherit"
	| "off"
	| "auto"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
export interface ThinkingConfig {
	efforts: readonly Exclude<ConfiguredThinkingLevel, "inherit" | "off" | "auto">[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	reasoning: boolean;
	thinking?: ThinkingConfig;
	contextWindow: number | null;
}
export interface RpcSessionState {
	sessionId: string;
	sessionFile?: string;
	model?: ModelInfo;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined;
	isStreaming: boolean;
	todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	dumpTools?: Array<{ name: string }>;
}
export type RpcSessionEvent =
	| {
			type:
				| "agent_start"
				| "agent_end"
				| "message_start"
				| "message_update"
				| "message_end"
				| "tool_execution_start"
				| "tool_execution_update"
				| "tool_execution_end";
	  }
	| { type: "auto_retry_start"; attempt: number; errorMessage: string; delayMs: number }
	| { type: "todo_reminder"; todos: Array<{ content: string; status: string }> };
export interface RpcClientOptions {
	cliPath: string;
	command?: string[];
	mode: "rpc-ui";
	cwd: string;
	sessionDir?: string;
	args?: string[];
}
export class RpcClient {
	constructor(options: RpcClientOptions);
	start(): Promise<void>;
	stop(): Promise<void>;
	getState(): Promise<RpcSessionState>;
	getSettingsCatalog(locale?: RpcSettingsLocale): Promise<RpcSettingsCatalog>;
	getSettings(): Promise<RpcSettingsSnapshot>;
	updateSetting(path: RpcSettingPath, value: RpcSettingValue): Promise<RpcSettingsSnapshot>;
	getKeybindingsCatalog(locale?: RpcSettingsLocale): Promise<RpcKeybindingsCatalog>;
	getKeybindings(): Promise<RpcKeybindingsSnapshot>;
	updateKeybinding(keybinding: string, keys: string[]): Promise<RpcKeybindingsSnapshot>;
	resetKeybindings(): Promise<RpcKeybindingsSnapshot>;
	getPlugins(): Promise<RpcPluginInfo[]>;
	setPluginEnabled(plugin: RpcPluginSelector, enabled: boolean): Promise<RpcPluginInfo[]>;
	setPluginFeatures(name: string, features: string[]): Promise<RpcPluginInfo[]>;
	setPluginSetting(name: string, key: string, value: RpcSettingValue): Promise<RpcPluginInfo[]>;
	getMcpServers(): Promise<RpcMcpServerInfo[]>;
	setMcpServerEnabled(name: string, enabled: boolean): Promise<RpcMcpServerInfo[]>;
	addMcpServer(name: string, scope: "user" | "project", config: RpcMcpServerConfigInput): Promise<RpcMcpServerInfo[]>;
	removeMcpServer(name: string, scope: "user" | "project"): Promise<RpcMcpServerInfo[]>;
	getMessages(): Promise<AgentMessage[]>;
	prompt(text: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	compact(instructions?: string): Promise<void>;
	waitForIdle(timeout: number): Promise<void>;
	setModel(provider: string, modelID: string): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel): Promise<void>;
	getAvailableModels(): Promise<ModelInfo[]>;
	getAvailableCommands(): Promise<Array<{ name: string; description?: string }>>;
	getLoginProviders(): Promise<Array<{ id: string; name: string }>>;
	onSessionEvent(handler: (event: RpcSessionEvent) => void): () => void;
	onExtensionUiRequest(handler: (request: RpcExtensionUIRequest) => void): () => void;
	respondToExtensionUi(response: RpcExtensionUIResponse): void;
}
