/**
 * OpenCode Zen login flow.
 *
 * OpenCode Zen is a subscription service that provides access to various AI models
 * (GPT-5.x, Claude 4.x, Gemini 3, etc.) through a unified API at opencode.ai/zen.
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to https://opencode.ai/auth
 * 2. User logs in and copies their API key
 * 3. User pastes the API key back into the CLI
 */

import * as AIError from "../../error";
import type { OAuthController } from "./types";

const AUTH_URL = "https://opencode.ai/auth";

/** Fallback display name when a provider doesn't pass its own. */
const DEFAULT_PROVIDER_NAME = "OpenCode Zen";

/**
 * Login to OpenCode Zen.
 *
 * Opens browser to auth page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginOpenCode(
	options: OAuthController,
	providerName: string = DEFAULT_PROVIDER_NAME,
): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(providerName);
	}

	// Go keys are minted from the same Zen console after subscribing to Go.
	options.onAuth?.({
		url: AUTH_URL,
		instructions: `Log in to the OpenCode Zen console and copy your ${providerName} API key`,
	});

	const apiKey = await options.onPrompt({
		message: `Paste your ${providerName} API key`,
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	return trimmed;
}
