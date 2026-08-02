import { bareModelId, modelFamilyToken, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}

export type ModelPromptPolicy = "codex" | "claude" | "none";

/** Model-family overlay policy used by the system prompt and its refresh key. */
export function modelPromptPolicy(modelId: string | undefined): ModelPromptPolicy {
	if (modelId) {
		const parsed = parseOpenAIModel(bareModelId(modelId));
		if (
			parsed &&
			(semverEqual(parsed.version, "5.6") ||
				parsed.variant === "codex" ||
				parsed.variant === "codex-max" ||
				parsed.variant === "codex-mini" ||
				parsed.variant === "codex-spark")
		) {
			return "codex";
		}
		if (modelFamilyToken(modelId) === "anthropic") return "claude";
	}
	return "none";
}
