import { setSettingsUiLocale } from "../src/i18n/settings-locale/index.ts";
import { tSettingsUi } from "../src/i18n/settings-locale/index.ts";

setSettingsUiLocale("zh-CN");

const probes = [
	// cli/args.ts
	"Environment Variables:",
	"Anthropic Claude models",
	"AI coding assistant",
	// cli/config-cli.ts
	"Manage settings",
	"(not set)",
	"Unknown setting: {key}",
	"Settings:\n",
	// commands/* descriptions
	"Manage bundled task agents",
	"Agents action",
	"Run onboarding setup or install dependencies for optional features",
	"Run an auth-gateway forward proxy backed by the configured broker",
	"Manage the omp auth-broker (credential vault)",
	"Output JSON",
	"Sub-command",
	"OAuth provider id (login/logout) or path (import)",
	"SSH user@host for remote login (login --via=user@host)",
	"Override provider id for `import` (e.g. when JSON `type` is unrecognized)",
	"Import credentials whose JSON has `disabled: true` (import)",
	"migrate source: local SQLite + env vars (required for `migrate`)",
	"Capture env-var API keys for providers not yet on broker (migrate)",
	"Also upload OAuth from local SQLite during migrate (default skips them)",
	"Print actions without executing (import / login --via / migrate)",
	// main.ts
	"Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…",
	"Model scope: {modelList} (Ctrl+P to cycle)",
];

let missing = 0;
for (const text of probes) {
	const out = tSettingsUi(text);
	const isFallback = out === text;
	if (isFallback) missing++;
	console.log(`${isFallback ? "✗" : "✓"} ${text}`);
	console.log(`    → ${out}`);
}
console.log(`\nMissing zh translations: ${missing}/${probes.length}`);
process.exit(missing === 0 ? 0 : 1);
