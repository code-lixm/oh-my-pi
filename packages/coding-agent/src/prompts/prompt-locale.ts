/**
 * Independent prompt-locale state.
 *
 * Why this is its own state (not a thin alias for `getSettingsUiLocale`)
 * ---------------------------------------------------------------------
 * 1. **Decoupling** — the UI locale and the model-side prompt locale are
 *    distinct concepts. The user may want Chinese UI with English prompts
 *    (LLMs are usually better at following English instructions), or vice
 *    versa. Coupling them now would make that fork impossible without a
 *    refactor.
 * 2. **Init order** — `displayLanguage` is applied during `Settings.init`
 *    (after every static `import` has been evaluated). If `selectPrompt`
 *    read `getSettingsUiLocale()` it would lock the locale to "en" forever
 *    for any module that imports a prompt at top level. Selecting at the
 *    call site against this *own* state object lets us wire the sync from
 *    `setSettingsUiLocale` -> `setPromptLocale` (or expose a separate
 *    `displayPromptsLanguage` setting later) without breaking the lazy
 *    import contract.
 * 3. **No reverse dep** — `i18n/settings-locale` does NOT import this
 *    module, so the dep graph stays acyclic.
 *
 * Pairing rule
 * ------------
 * `*.md` and `*.zh-CN.md` must come in pairs. `selectPrompt(en, zh)`
 * returns the body matching the current prompt locale; the default is "en".
 *
 * Sync points
 * -----------
 * `setPromptLocale(value)` is the only mutator. Call it from `Settings`
 * wherever the user's language preference changes, mirroring
 * `setSettingsUiLocale` so prompt and UI stay in step by default but can
 * be split later if needed.
 */

export type PromptLocale = "en" | "zh-CN";

let currentPromptLocale: PromptLocale = "en";

export function getPromptLocale(): PromptLocale {
	return currentPromptLocale;
}

export function setPromptLocale(value: unknown): void {
	currentPromptLocale = value === "zh-CN" ? "zh-CN" : "en";
}

/**
 * Pick the localized body for a prompt at the point the body is being
 * assembled — NOT at module load. Both `en` and `zh` are static-imported
 * strings; the call site chooses which one to forward to the model.
 */
export function selectPrompt(en: string, zh: string, locale?: PromptLocale): string {
	const l = locale ?? currentPromptLocale;
	return l === "zh-CN" ? zh : en;
}
