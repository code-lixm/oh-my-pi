import type { AdvisorConfig } from "../../advisor";
import type {
	Effort,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import type { AdvisorStats } from "../../session/session-advisors";
import type { RpcCommand, RpcResponse } from "../rpc/rpc-types";
import type {
	InteractiveSessionCursor,
	InteractiveSessionProjection,
	InteractiveSessionReliableFrame,
	InteractiveSessionSnapshot,
	InteractiveSessionViewFrame,
} from "./types";

export type InteractiveSessionConnectionState =
	| { status: "connecting" }
	| { status: "connected" }
	| { status: "disconnected"; error?: string };

export type InteractiveSessionReliableListener = (frame: InteractiveSessionReliableFrame) => void;
export type InteractiveSessionViewListener = (frame: InteractiveSessionViewFrame) => void;
export type InteractiveSessionConnectionListener = (state: InteractiveSessionConnectionState) => void;

/**
 * Foreground settings and usage operations shared by local AgentSession and
 * the daemon-backed facade. Return types admit local synchronous mutation and
 * remote RPC completion; consumers that need the observed backend state await.
 *
 * This is the incremental migration seam away from treating RemoteAgentSession
 * as an AgentSession through an unchecked cast.
 */
export interface InteractiveSessionSettingsCapabilities {
	getAvailableThinkingLevels(): ReadonlyArray<Effort>;
	isFastModeEnabled(): boolean;
	setFastMode(enabled: boolean): boolean | Promise<boolean>;
	toggleFastMode(): boolean | Promise<boolean>;
	getAdvisorStats(): AdvisorStats;
	isAdvisorEnabled(): boolean;
	setAdvisorEnabled(enabled: boolean): boolean | Promise<boolean>;
	toggleAdvisorEnabled(): boolean | Promise<boolean>;
	setThinkToolEnabled(enabled: boolean): Promise<boolean>;
	applyInspectImageModeChange(): Promise<boolean>;
	applyMemoryBackend(): Promise<void>;
	refreshBaseSystemPrompt(): Promise<void>;
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number | Promise<number>;
	getAdvisorAvailableToolNames(): string[] | Promise<string[]>;
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null>;
	listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]>;
	redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome>;
	getUsageReportingModelSelectors(reports: readonly UsageReport[]): string[] | Promise<string[]>;
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null | Promise<string | null>;
}

/** Transport-neutral frontend boundary for one interactive session. */
export interface InteractiveSessionPort {
	readonly projection: InteractiveSessionProjection;
	readonly cursor: InteractiveSessionCursor;
	dispatch(command: RpcCommand): Promise<RpcResponse>;
	requestSnapshot(): Promise<InteractiveSessionSnapshot>;
	onReliable(listener: InteractiveSessionReliableListener): () => void;
	onView(listener: InteractiveSessionViewListener): () => void;
	onConnection(listener: InteractiveSessionConnectionListener): () => void;
	dispose(): Promise<void>;
}
