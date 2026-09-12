/**
 * Provider/model scoping for secret obfuscation.
 *
 * `secrets.enabled` is global, but the practical need is narrower: only redact
 * traffic that leaves the machine for a third party whose safety filter would
 * reject the content anyway. A locally-hosted or first-party provider has no
 * such constraint, and redacting for it costs tokens and perturbs the model's
 * view of the code.
 *
 * Pattern grammar (one entry per line in the settings UI):
 * - empty list            — every provider (the historical behavior)
 * - a bare asterisk       — every provider
 * - `cloudglab`           — every model of that provider
 * - `cloudglab/glm-5.2`   — that one model
 * - `opencode-go/deepseek*` — globs are allowed inside each segment
 *
 * Matching is case-insensitive because provider ids and model ids are user-typed
 * and the same vendor casing is not guaranteed across catalogs.
 */

/** Segment-level glob: an asterisk spans any run, a question mark spans one character. */
function compileSegment(segment: string): RegExp {
	const escaped = segment
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Whether a provider/model pair is in scope for obfuscation.
 *
 * An empty or all-blank pattern list means "everything", which preserves the
 * behavior of every config written before scoping existed.
 */
export function matchesSecretScope(
	patterns: readonly string[] | undefined,
	provider: string | undefined,
	modelId: string | undefined,
): boolean {
	const trimmed = (patterns ?? []).map(pattern => pattern.trim()).filter(pattern => pattern.length > 0);
	if (trimmed.length === 0) return true;

	const providerName = provider ?? "";
	const id = modelId ?? "";
	for (const pattern of trimmed) {
		if (pattern === "*") return true;
		const slash = pattern.indexOf("/");
		if (slash === -1) {
			// Provider-only entry: every model of that provider.
			if (providerName && compileSegment(pattern).test(providerName)) return true;
			continue;
		}
		const providerPart = pattern.slice(0, slash);
		const modelPart = pattern.slice(slash + 1);
		if (compileSegment(providerPart).test(providerName) && compileSegment(modelPart).test(id)) return true;
	}
	return false;
}

/**
 * Split one comma-separated settings value into scope patterns.
 *
 * Scope is stored as a comma-separated string rather than a string array
 * because a free-form array has no finite choice set and would therefore render
 * as nothing at all in the settings UI (see `pathToSettingDef`).
 */
export function splitSecretScopeSetting(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}
