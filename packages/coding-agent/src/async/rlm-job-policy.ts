/** Dedicated AsyncJobManager category for RLM admission work. */
export const RLM_JOB_TYPE = "rlm" as const;

/** Whether a settled job is routed through the owner's async-result delivery sink. */
export type AsyncCompletionDeliveryPolicy = "automatic" | "manual";

/** RLM results travel only through the RLM family message adapter, never async-result. */
export const RLM_JOB_POLICY = {
	type: RLM_JOB_TYPE,
	completionDelivery: "manual",
} as const;

/** Category union exported for consumers that need to inspect job rows. */
export type AsyncJobType = "bash" | "task" | typeof RLM_JOB_TYPE;

/** True exactly for a job whose settlement must not wake its owner. */
export function isManualCompletionDelivery(policy: AsyncCompletionDeliveryPolicy): boolean {
	return policy === "manual";
}
