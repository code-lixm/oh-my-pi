import { CODEX_PROMPT_FINGERPRINT_SCHEMA_VERSION } from "../../types";

import { getOpenAIPromptCacheKey, type OpenAICacheOptions } from "../openai-shared";

export {
	CODEX_PROMPT_FINGERPRINT_SCHEMA_VERSION,
	type CodexNativePromptFingerprintInput,
	createCodexFallbackPromptFingerprint,
	createCodexNativePromptFingerprint,
} from "../../types";

/**
 * Partition an existing OpenAI prompt-cache identity by a native prompt
 * fingerprint without changing session or transport identity.
 */
export function getCodexNativePromptCacheKey(
	options: OpenAICacheOptions | undefined,
	promptFingerprint: string | undefined,
): string | undefined {
	const baseKey = getOpenAIPromptCacheKey(options);
	if (!baseKey || typeof promptFingerprint !== "string" || promptFingerprint.trim().length === 0) {
		return baseKey;
	}
	return `pc_codex_${Bun.hash(
		JSON.stringify([
			"omp-codex-native-prompt-cache",
			CODEX_PROMPT_FINGERPRINT_SCHEMA_VERSION,
			baseKey,
			promptFingerprint,
		]),
	).toString(36)}`;
}
