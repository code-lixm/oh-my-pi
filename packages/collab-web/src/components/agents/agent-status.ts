import type {
	AgentProgress,
	AgentSnapshot,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";

export type AgentDisplayStatus = AgentSnapshot["status"] | Extract<AgentProgress["status"], "completed" | "failed">;

function terminalProgressStatus(
	status: AgentProgress["status"] | SubagentLifecyclePayload["status"] | undefined,
): Extract<AgentProgress["status"], "completed" | "failed" | "aborted"> | undefined {
	return status === "completed" || status === "failed" || status === "aborted" ? status : undefined;
}

/** Task outcome wins over runtime lifecycle; a fresh start clears stale prior progress. */
export function resolveAgentDisplayStatus(
	agent: AgentSnapshot,
	progress?: SubagentProgressPayload,
	lifecycle?: SubagentLifecyclePayload,
): AgentDisplayStatus {
	if (lifecycle?.status === "started") return "running";
	return (
		terminalProgressStatus(lifecycle?.status) ??
		terminalProgressStatus(progress?.progress.status) ??
		agent.terminalStatus ??
		agent.status
	);
}
