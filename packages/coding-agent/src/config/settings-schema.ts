import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { DEFAULT_SHARE_URL } from "@oh-my-pi/pi-wire";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";
import { DEFAULT_RELAY_URL } from "../collab/protocol";
import { tSettingsUi } from "../i18n/settings-locale";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "../live/voices";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS, STT_MODEL_VALUES } from "../stt/models";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "../stt/submit-trigger";
import {
	AUTO_THINKING,
	getConfiguredThinkingLevelMetadata,
	getThinkingLevelMetadata,
	THINKING_DISPLAY_MODES,
} from "../thinking";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import {
	AUTO_THINKING_MODEL_OPTIONS,
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import { IMAGE_PROVIDER_CHOICES, type ImageProvider } from "../tools/image-providers";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_OPTIONS,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
} from "../tts/models";
import { EDIT_MODES } from "../utils/edit-mode";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SEARCH_PROVIDER_CHOICES,
	type SearchProviderId,
} from "../web/search/types";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "./service-tier";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab, group)
 *
 * UI metadata places the setting in the settings panel: `tab` picks the
 * panel tab, `group` the titled section within it (registered in
 * TAB_GROUPS). Sections render in TAB_GROUPS order; settings within a
 * section keep declaration order.
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "titanium")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type ModelRoleStorage = "global" | "project";

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers"
	| "sync";

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: `tab.${string}` };

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
	"sync",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	appearance: { label: tSettingsUi("Appearance"), icon: "tab.appearance" },
	model: { label: tSettingsUi("Model"), icon: "tab.model" },
	interaction: { label: tSettingsUi("Interaction"), icon: "tab.interaction" },
	context: { label: tSettingsUi("Context"), icon: "tab.context" },
	memory: { label: tSettingsUi("Memory"), icon: "tab.memory" },
	files: { label: tSettingsUi("Files"), icon: "tab.files" },
	shell: { label: tSettingsUi("Shell"), icon: "tab.shell" },
	tools: { label: tSettingsUi("Tools"), icon: "tab.tools" },
	tasks: { label: tSettingsUi("Tasks"), icon: "tab.tasks" },
	providers: { label: tSettingsUi("Providers"), icon: "tab.providers" },
	sync: { label: tSettingsUi("Sync"), icon: "tab.sync" },
};

/**
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Theme", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Communication",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Magic Keywords",
		"Startup & Updates",
		"Power (macOS)",
		"Agent",
		"Git",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight"],
	files: ["Editing", "Reading", "Read Summaries", "LSP", "Workspace checkpoints"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
		"Workspace checkpoints",
		"Python Skills",
	],
	tasks: [
		"Modes",
		"Subagents",
		"Isolation",
		"Commands & Skills",
		"Heartbeat",
		"Schedule",
		"Autonomous",
		"Refinement",
		"RLM",
	],
	providers: ["Services", "Network", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
	sync: ["S3 Storage", "Credentials", "Automation"],
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage"
	| "collab";

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/** Render this number as a free-form numeric input instead of a fixed-choice submenu. */
	input?: boolean;
	min?: number;
	max?: number;
	integer?: boolean;
	/** Fixed choices. Without `input` or options, a numeric setting is intentionally hidden from the UI. */
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	/** Mask the value in both the settings row and text editor. */
	secret?: boolean;
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

interface UiArray extends UiBase {
	/** Membership choices. Without options, an array setting has no UI representation (config-file only). */
	options?: ReadonlyArray<SubmenuOption>;
	/** Selection order is meaningful; the editor renders positions and supports reordering. */
	ordered?: boolean;
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	secret?: boolean;
	ordered?: boolean;
	input?: boolean;
	min?: number;
	max?: number;
	integer?: boolean;
};

/**
 * Marks a setting whose value is a credential.
 *
 * Lives at the top level rather than inside `ui` so it can also describe a
 * setting the settings panel never shows and therefore cannot carry
 * `ui.secret`. Read it through `isCredential`, which is the single accessor
 * both the CLI and the settings panel consult.
 */
interface CredentialMarker {
	credential?: true;
}

interface BooleanDef extends CredentialMarker {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef extends CredentialMarker {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef extends CredentialMarker {
	type: "number";
	default: number | undefined;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> extends CredentialMarker {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> extends CredentialMarker {
	type: "array";
	default: T[];
	ui?: UiArray;
}

interface RecordDef<T> extends CredentialMarker {
	type: "record";
	default: Record<string, T>;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["hub"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the `find` tool instead of shell find/fd. It provides indexed fuzzy path and glob search.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) instead of nohup or background shell syntax so the process stays observable and managed.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) for services, watchers, and debuggers so other omp instances can observe and control them.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "hub",
		message: 'Use the `hub` tool (`op:"start"`) for watch mode so its output, input, and lifecycle stay managed.',
	},
];

const DEFAULT_AGENT_MODEL_OVERRIDES: Record<string, string | string[]> = {};

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	setupVersion: { type: "number", default: 0 },

	displayLanguage: {
		type: "enum",
		values: ["en", "zh-CN"] as const,
		default: "en",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Display Language"),
			description: tSettingsUi("Language used for the settings UI chrome and localized setting labels."),
			options: [
				{ value: "en", label: tSettingsUi("English") },
				{ value: "zh-CN", label: tSettingsUi("简体中文") },
			],
		},
	},

	// Auth broker — credentials proxied through a remote `omp auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined, credential: true },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Auto Resume"),
			description: tSettingsUi("Automatically resume the most recent session in the current directory"),
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Power (macOS)"),
			label: tSettingsUi("Sleep Prevention"),
			description: tSettingsUi(
				"Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
			),
			options: [
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Do not prevent any sleep"),
				},
				{
					value: "idle",
					label: tSettingsUi("Prevent Idle Sleep"),
					description: tSettingsUi("Keep the system awake while a session is open (caffeinate -i)"),
				},
				{
					value: "display",
					label: tSettingsUi("Prevent Display Sleep"),
					description: tSettingsUi("Also keep the display from idle-sleeping (caffeinate -i -d)"),
				},
				{
					value: "system",
					label: tSettingsUi("Prevent System Sleep"),
					description: tSettingsUi(
						"Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)",
					),
				},
			],
		},
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Advisor"),
			label: tSettingsUi("Enable Advisor"),
			description: tSettingsUi(
				"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
			),
		},
	},
	"prewalk.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Prewalk"),
			label: tSettingsUi("Enable Prewalk"),
			description: tSettingsUi(
				"Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.",
			),
		},
	},
	"advisor.subagents": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Advisor"),
			label: tSettingsUi("Advisor for Subagents"),
			description: tSettingsUi("Also enable the advisor on spawned task/eval subagents."),
			condition: "advisorEnabled",
		},
	},

	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
		ui: {
			tab: "model",
			group: tSettingsUi("Advisor"),
			label: tSettingsUi("Advisor Sync Backlog"),
			description: tSettingsUi(
				"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
			),
			condition: "advisorEnabled",
		},
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: tSettingsUi("Advisor"),
			label: tSettingsUi("Advisor Immune Turns"),
			description: tSettingsUi(
				"After an advisor blocker interrupts, route further blockers non-interruptingly for this many primary turns.",
			),
			options: [
				{
					value: "0",
					label: tSettingsUi("0 turns"),
					description: tSettingsUi("Allow every blocker to interrupt."),
				},
				{ value: "1", label: tSettingsUi("1 turn") },
				{ value: "2", label: tSettingsUi("2 turns") },
				{ value: "3", label: tSettingsUi("3 turns"), description: tSettingsUi("Default.") },
				{ value: "4", label: tSettingsUi("4 turns") },
				{ value: "5", label: tSettingsUi("5 turns") },
			],
			condition: "advisorEnabled",
		},
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Git"),
			label: tSettingsUi("Enable Git Integration"),
			description: tSettingsUi(
				"Show git branch, status, and PR information in the TUI and watch repository metadata.",
			),
		},
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	"providers.maxInFlightRequests": {
		type: "record",
		default: EMPTY_NUMBER_RECORD,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Max In-Flight Requests"),
			description: tSettingsUi(
				'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited.',
			),
		},
	},

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoleStorage: {
		type: "enum",
		values: ["global", "project"] as const,
		default: "global",
		ui: {
			tab: "model",
			group: tSettingsUi("Prompt"),
			label: tSettingsUi("Model Role Storage"),
			description: tSettingsUi("Where model selector role assignments are saved"),
			options: [
				{
					value: "global",
					label: tSettingsUi("Global"),
					description: tSettingsUi("Save role models in the active profile config (current behavior)"),
				},
				{
					value: "project",
					label: tSettingsUi("Per-project"),
					description: tSettingsUi(
						"Save project role models in .omp/config.yml; missing project roles use global defaults",
					),
				},
			],
		},
	},

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Theme"),
			label: tSettingsUi("Dark Theme"),
			description: tSettingsUi("Theme used when the terminal has a dark background"),
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Theme"),
			label: tSettingsUi("Light Theme"),
			description: tSettingsUi("Theme used when the terminal has a light background"),
			options: "runtime",
		},
	},

	"theme.terminalPalette": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Theme"),
			label: tSettingsUi("Use Terminal Palette"),
			description: tSettingsUi(
				"Override the selected dark and light themes with adaptive themes that inherit the terminal ANSI palette",
			),
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Theme"),
			label: tSettingsUi("Symbol Preset"),
			description: tSettingsUi("Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)"),
			options: [
				{ value: "unicode", label: tSettingsUi("Unicode"), description: tSettingsUi("Standard symbols (default)") },
				{ value: "nerd", label: tSettingsUi("Nerd Font"), description: tSettingsUi("Requires Nerd Font") },
				{ value: "ascii", label: tSettingsUi("ASCII"), description: tSettingsUi("Maximum compatibility") },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Theme"),
			label: tSettingsUi("Color-Blind Mode"),
			description: tSettingsUi("Use blue instead of green for diff additions"),
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Status Line Preset"),
			description: tSettingsUi("Pre-built status line configurations"),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Model, path, git, context, tokens, cost"),
				},
				{ value: "minimal", label: tSettingsUi("Minimal"), description: tSettingsUi("Path and git only") },
				{ value: "compact", label: tSettingsUi("Compact"), description: tSettingsUi("Model, git, cost, context") },
				{ value: "full", label: tSettingsUi("Full"), description: tSettingsUi("All segments including time") },
				{
					value: "nerd",
					label: tSettingsUi("Nerd"),
					description: tSettingsUi("Maximum info with Nerd Font icons"),
				},
				{ value: "ascii", label: tSettingsUi("ASCII"), description: tSettingsUi("No special characters") },
				{ value: "custom", label: tSettingsUi("Custom"), description: tSettingsUi("User-defined segments") },
			],
		},
	},

	"statusLine.customPreset": {
		type: "string",
		default: "default",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Custom Status Line"),
			description: tSettingsUi("Select a named custom status line from statusLine.customPresets"),
			options: "runtime",
		},
	},

	"statusLine.customPresets": { type: "record", default: {} as Record<string, unknown> },

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Status Line Separator"),
			description: tSettingsUi("Style of separators between segments"),
			options: [
				{
					value: "powerline",
					label: tSettingsUi("Powerline"),
					description: tSettingsUi("Solid arrows (Nerd Font)"),
				},
				{
					value: "powerline-thin",
					label: tSettingsUi("Thin chevron"),
					description: tSettingsUi("Thin arrows (Nerd Font)"),
				},
				{ value: "slash", label: tSettingsUi("Slash"), description: tSettingsUi("Forward slashes") },
				{ value: "pipe", label: tSettingsUi("Pipe"), description: tSettingsUi("Vertical pipes") },
				{ value: "block", label: tSettingsUi("Block"), description: tSettingsUi("Solid blocks") },
				{ value: "none", label: tSettingsUi("None"), description: tSettingsUi("Space only") },
				{ value: "ascii", label: tSettingsUi("ASCII"), description: tSettingsUi("Greater-than signs") },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Session Accent"),
			description: tSettingsUi("Use the session name color for the editor border and status line gap"),
		},
	},

	"statusLine.transparent": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Transparent Status Line"),
			description: tSettingsUi(
				"Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.",
			),
		},
	},
	"statusLine.compactThinkingLevel": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Compact Thinking Level"),
			description: tSettingsUi(
				"Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.",
			),
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			group: tSettingsUi("Output Limits"),
			label: tSettingsUi("Artifact Spill Threshold (KB)"),
			description: tSettingsUi("Tool output above this size is saved as an artifact; tail is kept inline"),
			options: [
				{ value: "1", label: tSettingsUi("1 KB"), description: tSettingsUi("~250 tokens") },
				{ value: "2.5", label: tSettingsUi("2.5 KB"), description: tSettingsUi("~625 tokens") },
				{ value: "5", label: tSettingsUi("5 KB"), description: tSettingsUi("~1.25K tokens") },
				{ value: "10", label: tSettingsUi("10 KB"), description: tSettingsUi("~2.5K tokens") },
				{ value: "20", label: tSettingsUi("20 KB"), description: tSettingsUi("~5K tokens") },
				{ value: "30", label: tSettingsUi("30 KB"), description: tSettingsUi("~7.5K tokens") },
				{ value: "50", label: tSettingsUi("50 KB"), description: tSettingsUi("Default; ~12.5K tokens") },
				{ value: "75", label: tSettingsUi("75 KB"), description: tSettingsUi("~19K tokens") },
				{ value: "100", label: tSettingsUi("100 KB"), description: tSettingsUi("~25K tokens") },
				{ value: "200", label: tSettingsUi("200 KB"), description: tSettingsUi("~50K tokens") },
				{ value: "500", label: tSettingsUi("500 KB"), description: tSettingsUi("~125K tokens") },
				{ value: "1000", label: tSettingsUi("1 MB"), description: tSettingsUi("~250K tokens") },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: tSettingsUi("Output Limits"),
			label: tSettingsUi("Artifact Tail Size (KB)"),
			description: tSettingsUi("Amount of tail content kept inline when output spills to artifact"),
			options: [
				{ value: "1", label: tSettingsUi("1 KB"), description: tSettingsUi("~250 tokens") },
				{ value: "2.5", label: tSettingsUi("2.5 KB"), description: tSettingsUi("~625 tokens") },
				{ value: "5", label: tSettingsUi("5 KB"), description: tSettingsUi("~1.25K tokens") },
				{ value: "10", label: tSettingsUi("10 KB"), description: tSettingsUi("~2.5K tokens") },
				{ value: "20", label: tSettingsUi("20 KB"), description: tSettingsUi("Default; ~5K tokens") },
				{ value: "50", label: tSettingsUi("50 KB"), description: tSettingsUi("~12.5K tokens") },
				{ value: "100", label: tSettingsUi("100 KB"), description: tSettingsUi("~25K tokens") },
				{ value: "200", label: tSettingsUi("200 KB"), description: tSettingsUi("~50K tokens") },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: tSettingsUi("Output Limits"),
			label: tSettingsUi("Artifact Head Size (KB)"),
			description: tSettingsUi(
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			),
			options: [
				{ value: "0", label: tSettingsUi("0 KB"), description: tSettingsUi("Disabled; tail-only truncation") },
				{ value: "1", label: tSettingsUi("1 KB"), description: tSettingsUi("~250 tokens") },
				{ value: "2.5", label: tSettingsUi("2.5 KB"), description: tSettingsUi("~625 tokens") },
				{ value: "5", label: tSettingsUi("5 KB"), description: tSettingsUi("~1.25K tokens") },
				{ value: "10", label: tSettingsUi("10 KB"), description: tSettingsUi("~2.5K tokens") },
				{ value: "20", label: tSettingsUi("20 KB"), description: tSettingsUi("Default; ~5K tokens") },
				{ value: "50", label: tSettingsUi("50 KB"), description: tSettingsUi("~12.5K tokens") },
				{ value: "100", label: tSettingsUi("100 KB"), description: tSettingsUi("~25K tokens") },
				{ value: "200", label: tSettingsUi("200 KB"), description: tSettingsUi("~50K tokens") },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			group: tSettingsUi("Output Limits"),
			label: tSettingsUi("Output Column Cap"),
			description: tSettingsUi(
				"Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Off"), description: tSettingsUi("No per-line cap") },
				{ value: "256", label: tSettingsUi("256"), description: tSettingsUi("Tight") },
				{ value: "512", label: tSettingsUi("512") },
				{ value: "768", label: tSettingsUi("768"), description: tSettingsUi("Default") },
				{ value: "1024", label: tSettingsUi("1024") },
				{ value: "2048", label: tSettingsUi("2048") },
				{ value: "4096", label: tSettingsUi("4096"), description: tSettingsUi("Loose") },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: tSettingsUi("Output Limits"),
			label: tSettingsUi("Artifact Tail Lines"),
			description: tSettingsUi("Maximum lines of tail content kept inline when output spills to artifact"),
			options: [
				{ value: "50", label: tSettingsUi("50 lines"), description: tSettingsUi("~250 tokens") },
				{ value: "100", label: tSettingsUi("100 lines"), description: tSettingsUi("~500 tokens") },
				{ value: "250", label: tSettingsUi("250 lines"), description: tSettingsUi("~1.25K tokens") },
				{ value: "500", label: tSettingsUi("500 lines"), description: tSettingsUi("Default; ~2.5K tokens") },
				{ value: "1000", label: tSettingsUi("1000 lines"), description: tSettingsUi("~5K tokens") },
				{ value: "2000", label: tSettingsUi("2000 lines"), description: tSettingsUi("~10K tokens") },
				{ value: "5000", label: tSettingsUi("5000 lines"), description: tSettingsUi("~25K tokens") },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Status Line"),
			label: tSettingsUi("Show Hook Status"),
			description: tSettingsUi("Display hook status messages below the status line"),
		},
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Images"),
			label: tSettingsUi("Show Inline Images"),
			description: tSettingsUi("Render images inline in the terminal"),
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Images"),
			label: tSettingsUi("Auto-Resize Images"),
			description: tSettingsUi("Resize large images to 2000x2000 max for better model compatibility"),
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Images"),
			label: tSettingsUi("Block Images"),
			description: tSettingsUi("Prevent images from being sent to LLM providers"),
		},
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Vision"),
			label: tSettingsUi("Describe Images for Text Models"),
			description: tSettingsUi(
				"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it",
			),
		},
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description: tSettingsUi(
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
		),
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description: tSettingsUi(
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
		),
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description: tSettingsUi(
			"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
		),
	},

	"terminal.showProgress": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Native Terminal Progress"),
			description: tSettingsUi(
				"Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running",
			),
		},
	},

	"tui.markdownHeadingStyle": {
		type: "enum",
		values: ["compact", "hierarchical"] as const,
		default: "compact",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Markdown Headings"),
			description: tSettingsUi("How Markdown headings are shown in transcript content"),
			options: [
				{
					value: "compact",
					label: tSettingsUi("Compact Headings"),
					description: tSettingsUi(
						"Hide # markers, flatten H1-H6 to one title color, and keep readable spacing around headings",
					),
				},
				{
					value: "hierarchical",
					label: tSettingsUi("Hierarchical"),
					description: tSettingsUi("Preserve Markdown heading levels, markers, and spacing"),
				},
			],
		},
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Large Headings (Kitty)"),
			description: tSettingsUi(
				"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only applies to Hierarchical Markdown Headings on Kitty terminals. Off by default.",
			),
		},
	},

	"tui.mouseInput": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Mouse Input"),
			description: tSettingsUi(
				"Enable pointer interaction in application-managed panels such as Agent Hub and selectors. Session history and the main transcript keep terminal-native text selection.",
			),
		},
	},

	"tui.renderMermaid": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Render Mermaid Diagrams"),
			description: tSettingsUi("Render Mermaid fenced code blocks as ASCII diagrams"),
		},
	},

	"tui.codexResetFireworks": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Codex Reset Fireworks",
			description:
				"Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape",
		},
	},

	"tui.titleState": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Terminal Title Run State"),
			description: tSettingsUi(
				"Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' on Windows), '>' when it's your turn, '!' when the agent is waiting on you",
			),
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Terminal Hyperlinks"),
			description: tSettingsUi(
				"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
			),
		},
	},
	"tui.tight": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Tight Layout"),
			description: tSettingsUi(
				"Remove the 1-character horizontal padding from the left and right of the terminal output",
			),
		},
	},
	"tui.scrollbackRebuild": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Rewrite Scrollback"),
			description: tSettingsUi(
				"Erase and replay terminal scrollback when a block's final form replaces its live preview. When off (default), stale preview copies remain in history and the final content is appended below.",
			),
		},
	},

	"display.borderStyle": {
		type: "enum",
		values: ["full", "none", "accent"] as const,
		default: "accent",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Border Style"),
			description: tSettingsUi("Choose accent gutters (the system default), full borders, or borderless containers"),
			options: [
				{
					value: "accent",
					label: tSettingsUi("Accent Gutter"),
					description: tSettingsUi(
						"System default: replace full frames with a half-cell color rail, matching translucent-looking tint, and vertical breathing room; native selection may include the rail glyph and ordinary whitespace",
					),
				},
				{
					value: "full",
					label: tSettingsUi("Full"),
					description: tSettingsUi("Draw complete borders and table grids"),
				},
				{
					value: "none",
					label: tSettingsUi("Borderless"),
					description: tSettingsUi("Remove container frames while keeping task trees and three-line tables"),
				},
			],
		},
	},

	"display.basicToolDetails": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Basic Tool Details"),
			description: tSettingsUi(
				"Show detailed read, find, grep, and multi_grep results instead of one-line summaries",
			),
		},
	},
	"display.toolDetailMaxLines": {
		type: "number",
		default: 3,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Collapsed Tool Detail Rows"),
			description: tSettingsUi(
				"Maximum detail rows shown below a collapsed tool header. Longer details keep their beginning and end with the middle omitted.",
			),
			input: true,
			min: 3,
			max: 100,
			integer: true,
		},
	},
	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Shimmer"),
			description: tSettingsUi("Animation style for working/loading messages"),
			options: [
				{
					value: "classic",
					label: tSettingsUi("Classic"),
					description: tSettingsUi("Soft cosine wave sweeping across the text"),
				},
				{
					value: "kitt",
					label: tSettingsUi("KITT Scanner"),
					description: tSettingsUi("Knight Rider 1982 red light bouncing left-right"),
				},
				{
					value: "disabled",
					label: tSettingsUi("Disabled"),
					description: tSettingsUi("No animation; static muted text"),
				},
			],
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Smooth Streaming"),
			description: tSettingsUi("Reveal assistant text and streamed tool input smoothly while chunks arrive"),
		},
	},

	"display.hideToolActivity": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Hide Tool Activity",
			description: "Hide model-initiated tool calls and results from the transcript",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Token Usage"),
			description: tSettingsUi("Show per-turn token usage on assistant messages"),
		},
	},

	"display.showAgentCommunication": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Agent Communication"),
			description: tSettingsUi("Show agent-to-agent messages and coordination activity in the transcript"),
		},
	},

	"display.showSubagentList": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Subagent List"),
			description: tSettingsUi("Show the live subagent list above the Main prompt"),
		},
	},

	"display.showHubProcessActivity": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Hub Process Activity"),
			description: tSettingsUi("Show long-running process lifecycle activity in the transcript"),
		},
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Cache Miss Marker"),
			description: tSettingsUi(
				"Show a divider above an assistant turn whose request lost (missed) the prompt cache",
			),
		},
	},

	"display.collapseCompacted": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Collapse Compacted History"),
			description: tSettingsUi(
				"Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point",
			),
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Hardware Cursor"),
			description: tSettingsUi("Show terminal cursor for IME support"),
		},
	},

	"tui.imeSafeCursor": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("IME-Safe Prompt Layout"),
			description: tSettingsUi(
				"Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it",
			),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING],
		default: "high",
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Thinking Level"),
			description: tSettingsUi("Reasoning depth for thinking-capable models"),
			options: [
				getConfiguredThinkingLevelMetadata(AUTO_THINKING),
				...THINKING_EFFORTS.map(getThinkingLevelMetadata),
			],
		},
	},

	thinkingDisplay: {
		type: "enum",
		values: THINKING_DISPLAY_MODES,
		default: "full",
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Thinking Display"),
			description: tSettingsUi(
				"Choose how provider-exposed thinking streams appear live in Main and subagent transcripts",
			),
			options: [
				{
					value: "full",
					label: tSettingsUi("Full Stream"),
					description: tSettingsUi("Show every thinking delta exposed by the provider, including code blocks"),
				},
				{
					value: "prose",
					label: tSettingsUi("Prose Only"),
					description: tSettingsUi("Show thinking live but replace fenced code blocks with an ellipsis"),
				},
				{
					value: "hidden",
					label: tSettingsUi("Hidden"),
					description: tSettingsUi("Hide thinking streams from transcripts"),
				},
			],
		},
	},

	omitThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Omit Thinking summaries"),
			description: tSettingsUi(
				"Instruct upstream providers to completely omit thinking summaries from responses (where supported)",
			),
		},
	},

	externalThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "External Thinking",
			description: "Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning",
		},
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Loop Guard"),
			description: tSettingsUi("Enable automatic stream loop detection for model reasoning and prose"),
		},
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Loop Guard Scan Prose"),
			description: tSettingsUi("Apply loop guard to assistant prose messages in addition to thinking logs"),
		},
	},

	"model.loopGuard.maxNoProgressTurns": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Loop Guard No-Progress Threshold"),
			description: tSettingsUi(
				"Consecutive identical no-progress turns before the session injects a recovery instruction and restarts once (requires Loop Guard)",
			),
		},
	},

	"model.loopGuard.toolCallReminder": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Loop Guard Tool-Call Reminder"),
			description: tSettingsUi(
				"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)",
			),
		},
	},

	"model.toolCallLoopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Tool-Call Loop Guard"),
			description: tSettingsUi("Detect consecutive identical tool calls across turns and inject a corrective steer"),
		},
	},

	"model.toolCallLoopGuard.threshold": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Tool-Call Loop Threshold"),
			description: tSettingsUi("Consecutive identical tool calls required before the corrective steer is injected"),
		},
	},

	"model.toolCallLoopGuard.exemptTools": {
		type: "array",
		default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Tool-Call Loop Exempt Tools"),
			description: tSettingsUi(
				"Tool names that may repeat consecutively without triggering the cross-turn loop guard",
			),
		},
	},

	inlineToolDescriptors: {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "model",
			group: tSettingsUi("Prompt"),
			label: tSettingsUi("Inline Tool Descriptors"),
			description: tSettingsUi(
				"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Inline descriptors for Gemini models; keep them in tool schemas otherwise"),
				},
				{
					value: "on",
					label: tSettingsUi("On"),
					description: tSettingsUi("Always inline descriptors in the system prompt"),
				},
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Keep descriptors in provider tool schemas only"),
				},
			],
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Prompt"),
			label: tSettingsUi("Include Model in Prompt"),
			description: tSettingsUi(
				"Surface the active model identifier in the system prompt so the agent knows which model it is",
			),
		},
	},

	includeWorkspaceTree: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Prompt"),
			label: tSettingsUi("Include Workspace Tree"),
			description: tSettingsUi(
				"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.",
			),
		},
	},

	"workspace.additionalDirectories": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "General",
			label: "Additional Workspace Dirs",
			description:
				"Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/find them.",
		},
	},

	personality: {
		type: "enum",
		values: ["default", "friendly", "pragmatic", "none"] as const,
		default: "default",
		ui: {
			tab: "model",
			group: tSettingsUi("Prompt"),
			label: tSettingsUi("Personality"),
			description: tSettingsUi("Communication style rendered into the system prompt's personality block"),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Terse, evidence-first engineer; dense, action-oriented replies"),
				},
				{
					value: "friendly",
					label: tSettingsUi("Friendly"),
					description: tSettingsUi("Warm, encouraging collaborator focused on momentum and morale"),
				},
				{
					value: "pragmatic",
					label: tSettingsUi("Pragmatic"),
					description: tSettingsUi("Direct, efficient engineer focused on clarity and rigor"),
				},
				{
					value: "none",
					label: tSettingsUi("None"),
					description: tSettingsUi("Omit the personality block entirely"),
				},
			],
		},
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Temperature"),
			description: tSettingsUi("Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "0", label: tSettingsUi("0"), description: tSettingsUi("Deterministic") },
				{ value: "0.2", label: tSettingsUi("0.2"), description: tSettingsUi("Focused") },
				{ value: "0.5", label: tSettingsUi("0.5"), description: tSettingsUi("Balanced") },
				{ value: "0.7", label: tSettingsUi("0.7"), description: tSettingsUi("Creative") },
				{ value: "1", label: tSettingsUi("1"), description: tSettingsUi("Maximum variety") },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Top P"),
			description: tSettingsUi("Nucleus sampling cutoff (0-1, -1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "0.1", label: tSettingsUi("0.1"), description: tSettingsUi("Very focused") },
				{ value: "0.3", label: tSettingsUi("0.3"), description: tSettingsUi("Focused") },
				{ value: "0.5", label: tSettingsUi("0.5"), description: tSettingsUi("Balanced") },
				{ value: "0.9", label: tSettingsUi("0.9"), description: tSettingsUi("Broad") },
				{ value: "1", label: tSettingsUi("1"), description: tSettingsUi("No nucleus filtering") },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Top K"),
			description: tSettingsUi("Sample from top-K tokens (-1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "1", label: tSettingsUi("1"), description: tSettingsUi("Greedy top token") },
				{ value: "20", label: tSettingsUi("20"), description: tSettingsUi("Focused") },
				{ value: "40", label: tSettingsUi("40"), description: tSettingsUi("Balanced") },
				{ value: "100", label: tSettingsUi("100"), description: tSettingsUi("Broad") },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Min P"),
			description: tSettingsUi("Minimum probability threshold (0-1, -1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "0.01", label: tSettingsUi("0.01"), description: tSettingsUi("Very permissive") },
				{ value: "0.05", label: tSettingsUi("0.05"), description: tSettingsUi("Balanced") },
				{ value: "0.1", label: tSettingsUi("0.1"), description: tSettingsUi("Strict") },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Presence Penalty"),
			description: tSettingsUi("Penalty for introducing already-present tokens (-1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "0", label: tSettingsUi("0"), description: tSettingsUi("No penalty") },
				{ value: "0.5", label: tSettingsUi("0.5"), description: tSettingsUi("Mild novelty") },
				{ value: "1", label: tSettingsUi("1"), description: tSettingsUi("Encourage novelty") },
				{ value: "2", label: tSettingsUi("2"), description: tSettingsUi("Strong novelty") },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Repetition Penalty"),
			description: tSettingsUi("Penalty for repeated tokens (-1 = provider default)"),
			options: [
				{ value: "-1", label: tSettingsUi("Default"), description: tSettingsUi("Use provider default") },
				{ value: "0.8", label: tSettingsUi("0.8"), description: tSettingsUi("Allow repetition") },
				{ value: "1", label: tSettingsUi("1"), description: tSettingsUi("No penalty") },
				{ value: "1.1", label: tSettingsUi("1.1"), description: tSettingsUi("Mild penalty") },
				{ value: "1.2", label: tSettingsUi("1.2"), description: tSettingsUi("Balanced") },
				{ value: "1.5", label: tSettingsUi("1.5"), description: tSettingsUi("Strong penalty") },
			],
		},
	},

	textVerbosity: {
		type: "enum",
		values: ["low", "medium", "high"] as const,
		default: "medium",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Text Verbosity"),
			description: tSettingsUi("OpenAI Responses and Codex response verbosity (low, medium, or high)"),
			options: [
				{ value: "low", label: tSettingsUi("Low"), description: tSettingsUi("Prefer concise responses") },
				{
					value: "medium",
					label: tSettingsUi("Medium"),
					description: tSettingsUi("Balance brevity and detail (default)"),
				},
				{ value: "high", label: tSettingsUi("High"), description: tSettingsUi("Prefer detailed responses") },
			],
		},
	},

	"tier.openai": {
		type: "enum",
		values: SERVICE_TIER_OPENAI_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Service Tier — OpenAI"),
			description: tSettingsUi(
				"Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.",
			),
			options: SERVICE_TIER_OPENAI_OPTIONS,
		},
	},

	"tier.anthropic": {
		type: "enum",
		values: SERVICE_TIER_ANTHROPIC_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Service Tier — Anthropic"),
			description: tSettingsUi(
				'Processing tier for Claude requests. `priority` realizes fast mode (`speed: "fast"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.',
			),
			options: SERVICE_TIER_ANTHROPIC_OPTIONS,
		},
	},

	"tier.google": {
		type: "enum",
		values: SERVICE_TIER_GOOGLE_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Service Tier — Google"),
			description: tSettingsUi(
				"Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.",
			),
			options: SERVICE_TIER_GOOGLE_OPTIONS,
		},
	},

	"tier.subagent": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "inherit",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Service Tier — Subagent"),
			description: tSettingsUi(
				"Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.",
			),
			options: SERVICE_TIER_INHERIT_OPTIONS,
		},
	},

	"tier.advisor": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: tSettingsUi("Sampling"),
			label: tSettingsUi("Service Tier — Advisor"),
			description: tSettingsUi(
				"Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.",
			),
			options: SERVICE_TIER_INHERIT_OPTIONS,
			condition: "advisorEnabled",
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Retry Attempts"),
			description: tSettingsUi("Maximum retry attempts on API errors"),
			input: true,
			min: 0,
			integer: true,
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Max Retry Delay"),
			description: tSettingsUi(
				"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).",
			),
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Retry Model Fallback"),
			description: tSettingsUi("Allow retry recovery to switch to configured fallback models"),
		},
	},
	"retry.usageAwareFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Usage-Aware Fallback",
			description:
				"Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.",
		},
	},
	"retry.usageReservePct": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Reserve Margin",
			description:
				"Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.",
			condition: "usageAwareFallbackEnabled",
			options: [
				{ value: "5", label: "5%", description: "Act only when nearly exhausted" },
				{ value: "10", label: "10%", description: "Balanced safety margin" },
				{ value: "15", label: "15%", description: "Conservative" },
				{ value: "20", label: "20%", description: "Early protection" },
				{ value: "25", label: "25%", description: "Very conservative" },
			],
		},
	},
	"retry.usageReservePolicy": {
		type: "enum",
		values: ["confirm", "auto", "fail-closed"] as const,
		default: "confirm",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Reserve Policy",
			description: "What to do when every same-provider coding-plan account is inside the reserve margin.",
			condition: "usageAwareFallbackEnabled",
			options: [
				{
					value: "confirm",
					label: "Confirm interactively",
					description: "Keep interactive sessions on the primary until confirmed; background agents auto-fallback",
				},
				{
					value: "auto",
					label: "Auto-fallback",
					description: "Always select the next eligible configured fallback",
				},
				{
					value: "fail-closed",
					label: "Fail closed",
					description: "Do not spend reserve quota or select a fallback",
				},
			],
		},
	},
	"retry.fallbackChains": {
		type: "record",
		default: {} as Record<string, string[]>,
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Retry Fallback Chains"),
			description: tSettingsUi(
				'JSON object mapping model roles, model selectors ("provider/model-id"), or provider wildcards ("provider/*") to ordered fallback selectors, e.g. {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a "provider/*" entry keeps the failing model\'s id and swaps the provider. An id-prefixed wildcard ("openrouter/google/*") re-prefixes the failing model\'s bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider\'s ids under the prefix.',
			),
		},
	},
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["probe", "cooldown-expiry", "never"] as const,
		default: "probe",
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Fallback Revert Policy"),
			description: tSettingsUi("When to return to the primary model after a fallback"),
			options: [
				{
					value: "probe",
					label: tSettingsUi("Probe primary"),
					description: tSettingsUi("Probe the primary and restore it at a safe boundary once healthy"),
				},
				{
					value: "cooldown-expiry",
					label: tSettingsUi("Cooldown expiry"),
					description: tSettingsUi("Return to the primary model after its suppression window ends"),
				},
				{
					value: "never",
					label: tSettingsUi("Never"),
					description: tSettingsUi("Stay on the fallback model until manually changed"),
				},
			],
		},
	},

	"providers.anthropic.serverSideFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: tSettingsUi("Retry & Fallback"),
			label: tSettingsUi("Anthropic Server-Side Fallback (Fable 5)"),
			description: tSettingsUi(
				"When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.",
			),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Steering Mode"),
			description: tSettingsUi("How to process queued messages while agent is working"),
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Follow-Up Mode"),
			description: tSettingsUi("How to drain follow-up messages after a turn completes"),
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Interrupt Mode"),
			description: tSettingsUi("When steering messages interrupt tool execution"),
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Loop Mode"),
			description: tSettingsUi("What happens between /loop iterations before re-submitting the prompt"),
			options: [
				{
					value: "prompt",
					label: tSettingsUi("Prompt"),
					description: tSettingsUi("Re-submit the prompt as a follow-up message (current behavior)"),
				},
				{
					value: "compact",
					label: tSettingsUi("Compact"),
					description: tSettingsUi("Compact the session context, then re-submit the prompt"),
				},
				{
					value: "reset",
					label: tSettingsUi("Reset"),
					description: tSettingsUi("Start a new session, then re-submit the prompt"),
				},
			],
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "none",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Double-Escape Action"),
			description: tSettingsUi("Action when pressing Escape twice with empty editor"),
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Session Tree Filter"),
			description: tSettingsUi("Default filter mode when opening the session tree"),
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Autocomplete Items"),
			description: tSettingsUi("Max visible items in autocomplete dropdown (3-20)"),
			options: [
				{ value: "3", label: tSettingsUi("3 items") },
				{ value: "5", label: tSettingsUi("5 items") },
				{ value: "7", label: tSettingsUi("7 items") },
				{ value: "10", label: tSettingsUi("10 items") },
				{ value: "15", label: tSettingsUi("15 items") },
				{ value: "20", label: tSettingsUi("20 items") },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Emoji Autocomplete"),
			description: tSettingsUi(
				"Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
			),
		},
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Input"),
			label: tSettingsUi("Large Paste Menu"),
			description: tSettingsUi(
				"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
			),
			options: [
				{ value: "0", label: tSettingsUi("Off") },
				{ value: "100", label: tSettingsUi("100 lines") },
				{ value: "250", label: tSettingsUi("250 lines") },
				{ value: "500", label: tSettingsUi("500 lines") },
				{ value: "1000", label: tSettingsUi("1000 lines") },
			],
		},
	},

	// Assistant communication policies
	"communication.nextSteps": {
		type: "enum",
		values: ["off", "auto"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Communication"),
			label: tSettingsUi("Next-Step Offers"),
			description: tSettingsUi(
				"Record up to three structured, user-selectable next-step offers after successful final responses.",
			),
			options: [
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Keep legacy final responses without structured next-step offers"),
				},
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Offer structured next steps when the active prompt policy supports them"),
				},
			],
		},
	},

	"communication.progressUpdates": {
		type: "enum",
		values: ["off", "auto"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Communication"),
			label: tSettingsUi("Progress Updates"),
			description: tSettingsUi("Control concise commentary updates during multi-step work."),
			options: [
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Keep legacy behavior without a progress-update policy"),
				},
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi(
						"Use the active prompt policy to send progress updates at meaningful milestones",
					),
				},
			],
		},
	},

	"communication.nextStepNumberResolver": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Communication"),
			label: tSettingsUi("Numbered Next-Step Selection"),
			description: tSettingsUi(
				"Interpret an eligible bare number as an explicit choice of the most recent structured next-step offer.",
			),
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Quiet Startup"),
			description: tSettingsUi("Skip welcome screen and startup status messages"),
		},
	},

	"startup.showSplash": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Show Startup Splash"),
			description: tSettingsUi(
				"Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
			),
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Setup Wizard"),
			description: tSettingsUi("Show newly added onboarding steps once per setup version"),
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Check for Updates"),
			description: tSettingsUi("Check for omp updates on startup"),
		},
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Marketplace Auto-Update"),
			description: tSettingsUi("Check for plugin updates on startup"),
			options: [
				{ value: "off", label: tSettingsUi("Off"), description: tSettingsUi("Don't check for plugin updates") },
				{
					value: "notify",
					label: tSettingsUi("Notify"),
					description: tSettingsUi("Check on startup and notify when updates are available"),
				},
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Check on startup and auto-install updates"),
				},
			],
		},
	},

	"startup.changelogMode": {
		type: "enum",
		values: ["summary", "expanded", "hidden"] as const,
		default: "summary",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Startup & Updates"),
			label: tSettingsUi("Startup Changelog"),
			description: tSettingsUi("Choose whether update notes start as a summary, full details, or stay hidden"),
			options: [
				{
					value: "summary",
					label: tSettingsUi("Summary"),
					description: tSettingsUi("Show release and change counts with a /changelog hint"),
				},
				{
					value: "expanded",
					label: tSettingsUi("Expanded"),
					description: tSettingsUi("Show the recent release notes in full"),
				},
				{
					value: "hidden",
					label: tSettingsUi("Hidden"),
					description: tSettingsUi("Do not show release notes on startup"),
				},
			],
		},
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Magic Keywords"),
			label: tSettingsUi("Magic Keywords"),
			description: tSettingsUi(
				"Enable hidden notices for standalone ultrathink, orchestrate, and workflowz keywords",
			),
		},
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Magic Keywords"),
			label: tSettingsUi("Ultrathink Keyword"),
			description: tSettingsUi(
				"Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
			),
		},
	},

	"magicKeywords.orchestrate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Magic Keywords"),
			label: tSettingsUi("Orchestrate Keyword"),
			description: tSettingsUi("Let standalone orchestrate append its hidden multi-agent orchestration notice"),
		},
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Magic Keywords"),
			label: tSettingsUi("Workflow Keyword"),
			description: tSettingsUi("Let standalone workflowz append its hidden eval workflow notice"),
		},
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Notifications"),
			label: tSettingsUi("Completion Notification"),
			description: tSettingsUi("Notify when the agent finishes a turn"),
		},
	},

	"error.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Error Notification",
			description: "Notify when the agent stops with an error",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 30,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Notifications"),
			label: tSettingsUi("Ask Timeout"),
			description: tSettingsUi(
				"In YOLO mode, each question gets a fresh countdown before its explicit recommended option is selected automatically (0 disables)",
			),
			options: [
				{ value: "0", label: tSettingsUi("Disabled") },
				{ value: "30", label: tSettingsUi("30 seconds") },
				{ value: "60", label: tSettingsUi("60 seconds") },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Notifications"),
			label: tSettingsUi("Ask Notification"),
			description: tSettingsUi("Notify when the ask tool is waiting for input"),
		},
	},

	"recap.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Notifications"),
			label: tSettingsUi("Idle Recap"),
			description: tSettingsUi("Generate a brief LLM recap of where things stand after the terminal has been idle"),
		},
	},

	"recap.idleSeconds": {
		type: "number",
		default: 240,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Notifications"),
			label: tSettingsUi("Idle Recap Delay"),
			description: tSettingsUi("Seconds to wait while idle before showing the recap"),
			options: [
				{ value: "60", label: tSettingsUi("1 minute") },
				{ value: "120", label: tSettingsUi("2 minutes") },
				{ value: "240", label: tSettingsUi("4 minutes") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "600", label: tSettingsUi("10 minutes") },
			],
		},
	},

	// Collab
	"collab.relayUrl": {
		type: "string",
		default: DEFAULT_RELAY_URL,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Relay URL"),
			description: tSettingsUi("Relay used by /collab (wss://host[:port])"),
		},
	},

	"collab.webUrl": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Web UI URL"),
			description: tSettingsUi(
				"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
			),
		},
	},

	"collab.displayName": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Display Name"),
			description: tSettingsUi("Name shown to other collab participants (default: OS username)"),
		},
	},

	"share.serverUrl": {
		type: "string",
		default: DEFAULT_SHARE_URL,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Share Server"),
			description: tSettingsUi(
				"Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)",
			),
		},
	},

	"share.store": {
		type: "enum",
		values: ["blob", "gist"] as const,
		default: "blob",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Share Store"),
			description: tSettingsUi("Where /share uploads the encrypted session blob"),
			options: [
				{
					value: "blob",
					label: tSettingsUi("Encrypted Blob"),
					description: tSettingsUi(
						"Upload to the share server (no GitHub account needed; avoids gist API rate limits)",
					),
				},
				{
					value: "gist",
					label: tSettingsUi("GitHub Gist"),
					description: tSettingsUi(
						"Push to a secret gist (needs authenticated gh), falling back to the share server",
					),
				},
			],
		},
	},

	"share.redactSecrets": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Collab"),
			label: tSettingsUi("Share Secret Redaction"),
			description: tSettingsUi(
				"Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)",
			),
		},
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Speech"),
			label: tSettingsUi("Speech-to-Text"),
			description: tSettingsUi("Enable speech-to-text input via microphone"),
		},
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: STT_MODEL_VALUES,
		default: DEFAULT_STT_MODEL_KEY,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Speech"),
			label: tSettingsUi("Speech Model"),
			description: tSettingsUi(
				"Local on-device speech model. Parakeet TDT v3 (sherpa-onnx) is the SoTA default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade size for multilingual coverage. Downloaded on first use.",
			),
			options: STT_MODEL_OPTIONS,
		},
	},
	"stt.submitTrigger": {
		type: "enum",
		values: STT_SUBMIT_TRIGGER_VALUES,
		default: "never",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Speech"),
			label: tSettingsUi("Speech-to-Text Submit Trigger"),
			description: tSettingsUi(
				"Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.",
			),
			options: STT_SUBMIT_TRIGGER_OPTIONS,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: tSettingsUi("General"),
			label: tSettingsUi("Auto-Promote Context"),
			description: tSettingsUi("Promote to a larger-context model on context overflow instead of compacting"),
		},
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Auto-Compact"),
			description: tSettingsUi("Automatically compact context when it gets too large"),
		},
	},

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Mid-Turn Compaction"),
			description: tSettingsUi(
				"Check thresholds at safe mid-turn tool-loop boundaries before the next provider request",
			),
		},
	},

	"compaction.strategy": {
		type: "enum",
		values: ["context-full", "handoff", "shake", "snapcompact", "off"] as const,
		default: "context-full",
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Compaction Strategy"),
			description: tSettingsUi(
				"Choose in-place context-full maintenance, auto-handoff, surgical shake (drop heavy content), snapcompact (archive history as dense images), or disable auto maintenance (off)",
			),
			options: [
				{
					value: "context-full",
					label: tSettingsUi("Context-full"),
					description: tSettingsUi("Summarize in-place and keep the current session"),
				},
				{
					value: "handoff",
					label: tSettingsUi("Handoff"),
					description: tSettingsUi("Generate handoff and continue in a new session"),
				},
				{
					value: "shake",
					label: tSettingsUi("Shake"),
					description: tSettingsUi(
						"Drop heavy content (tool results + large blocks) in place; recover via artifact",
					),
				},
				{
					value: "snapcompact",
					label: tSettingsUi("Snapcompact"),
					description: tSettingsUi("Archive history onto dense bitmap images the model reads back; no LLM call"),
				},
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Disable automatic context maintenance (same behavior as Auto-compact off)"),
				},
			],
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Compaction Threshold"),
			description: tSettingsUi(
				"Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
			),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Legacy reserve-based threshold"),
				},
				{ value: "10", label: tSettingsUi("10%"), description: tSettingsUi("Extremely early maintenance") },
				{ value: "20", label: tSettingsUi("20%"), description: tSettingsUi("Very early maintenance") },
				{ value: "30", label: tSettingsUi("30%"), description: tSettingsUi("Early maintenance") },
				{ value: "40", label: tSettingsUi("40%"), description: tSettingsUi("Moderately early maintenance") },
				{ value: "50", label: tSettingsUi("50%"), description: tSettingsUi("Halfway point") },
				{ value: "60", label: tSettingsUi("60%"), description: tSettingsUi("Moderate context usage") },
				{ value: "70", label: tSettingsUi("70%"), description: tSettingsUi("Balanced") },
				{ value: "75", label: tSettingsUi("75%"), description: tSettingsUi("Slightly aggressive") },
				{ value: "80", label: tSettingsUi("80%"), description: tSettingsUi("Typical threshold") },
				{ value: "85", label: tSettingsUi("85%"), description: tSettingsUi("Aggressive context usage") },
				{ value: "90", label: tSettingsUi("90%"), description: tSettingsUi("Very aggressive") },
				{ value: "95", label: tSettingsUi("95%"), description: tSettingsUi("Near context limit") },
			],
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Compaction Token Limit"),
			description: tSettingsUi("Fixed token limit for context maintenance; overrides percentage if set"),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Use percentage-based threshold"),
				},
				{ value: "25000", label: tSettingsUi("25K tokens"), description: tSettingsUi("Quarter of a 200K window") },
				{ value: "50000", label: tSettingsUi("50K tokens"), description: tSettingsUi("Half of a 200K window") },
				{ value: "100000", label: tSettingsUi("100K tokens"), description: tSettingsUi("Half of a 200K window") },
				{
					value: "150000",
					label: tSettingsUi("150K tokens"),
					description: tSettingsUi("Three-quarters of a 200K window"),
				},
				{
					value: "200000",
					label: tSettingsUi("200K tokens"),
					description: tSettingsUi("Full standard context window"),
				},
				{ value: "300000", label: tSettingsUi("300K tokens"), description: tSettingsUi("Large context window") },
				{
					value: "500000",
					label: tSettingsUi("500K tokens"),
					description: tSettingsUi("Very large context window"),
				},
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Save Handoff Docs"),
			description: tSettingsUi("Save generated handoff documents to markdown files for the auto-handoff flow"),
		},
	},

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Remote Compaction"),
			description: tSettingsUi("Use remote compaction endpoints when available instead of local summarization"),
		},
	},

	"compaction.remoteStreamingV2Enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Remote Compaction V2"),
			description: tSettingsUi("Use Responses streaming compaction for compatible remote compaction models"),
		},
	},

	// No default: an unset reserve tells the compaction layer the user never
	// chose one, so small-window recovery may swap in the proportional reserve
	// (see resolveBudgetReserveTokens). A materialized 16384 here would make
	// every session look explicitly configured.
	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	"compaction.v2RetainedMessageBudget": { type: "number", default: 64000 },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Idle Compaction"),
			description: tSettingsUi("Compact context while idle when token count exceeds threshold"),
		},
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Idle Compaction Threshold"),
			description: tSettingsUi("Token count above which idle compaction triggers"),
			options: [
				{ value: "100000", label: tSettingsUi("100K tokens") },
				{ value: "200000", label: tSettingsUi("200K tokens") },
				{ value: "300000", label: tSettingsUi("300K tokens") },
				{ value: "400000", label: tSettingsUi("400K tokens") },
				{ value: "500000", label: tSettingsUi("500K tokens") },
				{ value: "600000", label: tSettingsUi("600K tokens") },
				{ value: "700000", label: tSettingsUi("700K tokens") },
				{ value: "800000", label: tSettingsUi("800K tokens") },
				{ value: "900000", label: tSettingsUi("900K tokens") },
			],
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Idle Compaction Delay"),
			description: tSettingsUi("Seconds to wait while idle before compacting"),
			options: [
				{ value: "60", label: tSettingsUi("1 minute") },
				{ value: "120", label: tSettingsUi("2 minutes") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "600", label: tSettingsUi("10 minutes") },
				{ value: "1800", label: tSettingsUi("30 minutes") },
				{ value: "3600", label: tSettingsUi("1 hour") },
			],
		},
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Supersede Stale Reads"),
			description: tSettingsUi(
				"Prune older read results when the same file is read again (cache-aware, runs every turn)",
			),
		},
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Compaction"),
			label: tSettingsUi("Elide Uneventful Results"),
			description: tSettingsUi(
				"Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)",
			),
		},
	},

	// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
	"snapcompact.systemPrompt": {
		type: "enum",
		values: ["none", "agents-md", "all"] as const,
		default: "none",
		ui: {
			tab: "context",
			group: tSettingsUi("Experimental"),
			label: tSettingsUi("Snapcompact System Prompt"),
			description: tSettingsUi(
				"Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.",
			),
			options: [
				{ value: "none", label: tSettingsUi("None"), description: tSettingsUi("Keep the system prompt as text.") },
				{
					value: "agents-md",
					label: tSettingsUi("AGENTS.md"),
					description: tSettingsUi(
						"Only move loaded context-file instructions to images, when that saves tokens.",
					),
				},
				{
					value: "all",
					label: tSettingsUi("All"),
					description: tSettingsUi("Move the full system prompt to images, when that saves tokens."),
				},
			],
		},
	},

	"snapcompact.toolResults": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: tSettingsUi("Experimental"),
			label: tSettingsUi("Snapcompact Tool Results"),
			description: tSettingsUi(
				"Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output.",
			),
		},
	},

	"tools.format": {
		type: "enum",
		values: [
			"auto",
			"native",
			"glm",
			"hermes",
			"kimi",
			"xml",
			"anthropic",
			"deepseek",
			"harmony",
			"qwen3",
			"gemini",
			"gemma",
			"minimax",
		] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: tSettingsUi("Experimental"),
			label: tSettingsUi("Tool Calling Mode"),
			description: tSettingsUi(
				"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Use native tool calls unless the model is known not to support them."),
				},
				{
					value: "native",
					label: tSettingsUi("Native"),
					description: tSettingsUi("Use provider-native tool calls."),
				},
				{ value: "glm", label: tSettingsUi("GLM"), description: tSettingsUi("Use GLM-style in-band tool calls.") },
				{
					value: "hermes",
					label: tSettingsUi("Hermes"),
					description: tSettingsUi("Use Hermes-style in-band tool calls."),
				},
				{
					value: "kimi",
					label: tSettingsUi("Kimi"),
					description: tSettingsUi("Use Kimi-style in-band tool calls."),
				},
				{
					value: "xml",
					label: tSettingsUi("XML"),
					description: tSettingsUi("Use generic XML in-band tool calls."),
				},
				{
					value: "anthropic",
					label: tSettingsUi("Anthropic"),
					description: tSettingsUi("Use Anthropic-style in-band tool calls."),
				},
				{
					value: "deepseek",
					label: tSettingsUi("DeepSeek"),
					description: tSettingsUi("Use DeepSeek-style in-band tool calls."),
				},
				{
					value: "harmony",
					label: tSettingsUi("Harmony"),
					description: tSettingsUi("Use Harmony-style in-band tool calls."),
				},
				{ value: "qwen3", label: tSettingsUi("Qwen3"), description: tSettingsUi("Use the Qwen3 owned dialect.") },
				{
					value: "gemini",
					label: tSettingsUi("Gemini"),
					description: tSettingsUi("Use the Gemini owned dialect."),
				},
				{ value: "gemma", label: tSettingsUi("Gemma"), description: tSettingsUi("Use the Gemma owned dialect.") },
				{
					value: "minimax",
					label: tSettingsUi("MiniMax"),
					description: tSettingsUi("Use the MiniMax owned dialect."),
				},
			],
		},
	},

	"snapcompact.shape": {
		type: "enum",
		values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: tSettingsUi("Experimental"),
			label: tSettingsUi("Snapcompact Shape"),
			description: tSettingsUi(
				"Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi(
						"Picks a shape tuned for the current model, falling back to its provider family.",
					),
				},
				{
					value: "8x8r-bw",
					label: tSettingsUi("8x8 repeated, black"),
					description: tSettingsUi(
						"unscii square cell, black ink, every line printed twice with the copy on a pale highlight band.",
					),
				},
				{
					value: "8x8r-sent",
					label: tSettingsUi("8x8 repeated, sentence hues"),
					description: tSettingsUi("Repeated grid with ink cycling six hues at sentence boundaries."),
				},
				{
					value: "8x8u-bw",
					label: tSettingsUi("8x8, black"),
					description: tSettingsUi("Plain unscii square cell, single-printed lines, black ink."),
				},
				{
					value: "8x8u-sent",
					label: tSettingsUi("8x8, sentence hues"),
					description: tSettingsUi("Plain unscii square cell with sentence-hue ink."),
				},
				{
					value: "6x6u-bw",
					label: tSettingsUi("6x6 dense, black"),
					description: tSettingsUi(
						"unscii squeezed to 6x6 — densest readable cell, fewest frames — in black ink.",
					),
				},
				{
					value: "6x6u-sent",
					label: tSettingsUi("6x6 dense, sentence hues"),
					description: tSettingsUi("Densest cell with sentence-hue ink."),
				},
				{
					value: "5x8-bw",
					label: tSettingsUi("5x8 legacy, black"),
					description: tSettingsUi("Original X.org 5x8 glyphs on the 2576px frame, black ink."),
				},
				{
					value: "5x8-sent",
					label: tSettingsUi("5x8 legacy, sentence hues"),
					description: tSettingsUi("The original snapcompact shape (pre-shape-table sessions rendered this)."),
				},
				{
					value: "6x12-dim",
					label: tSettingsUi("6x12, dimmed stopwords"),
					description: tSettingsUi("X.org 6x12 glyphs, black ink, function words dimmed gray."),
				},
				{
					value: "8x13-bw",
					label: tSettingsUi("8x13, black"),
					description: tSettingsUi("X.org 8x13 glyphs, black ink."),
				},
				{
					value: "8on16-bw",
					label: tSettingsUi("8x13 on 16px pitch, black"),
					description: tSettingsUi("8x13 glyphs on an 8x16 cell (extra leading), black ink."),
				},
				{
					value: "8on22-bw",
					label: tSettingsUi("8x13 on 22px pitch (leading), black"),
					description: tSettingsUi(
						"8x13 glyphs on an 8x22 cell — extra line spacing so rows don't crowd. Default for OpenAI/Google.",
					),
				},
				{
					value: "11on16-bw",
					label: tSettingsUi("8x13 on 11px advance (tracking), black"),
					description: tSettingsUi(
						"8x13 glyphs on an 11x16 cell — extra letter spacing so characters don't merge. Default for Anthropic.",
					),
				},
				{
					value: "silver16-bw",
					label: tSettingsUi("Silver 16, CJK"),
					description: tSettingsUi(
						"Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.",
					),
				},
				{
					value: "doc-8on16-bw",
					label: tSettingsUi("Doc 8on16, black"),
					description: tSettingsUi(
						"Two word-wrapped newspaper columns of 8x13 glyphs on a 16px pitch, black ink.",
					),
				},
				{
					value: "doc-8on16-sent",
					label: tSettingsUi("Doc 8on16, sentence hues"),
					description: tSettingsUi("Two-column doc layout with sentence-hue ink."),
				},
				{
					value: "doc-8on16-sent-dim",
					label: tSettingsUi("Doc 8on16, sentence hues + dimmed stopwords"),
					description: tSettingsUi("Two-column doc layout, sentence-hue ink, function words dimmed gray."),
				},
			],
		},
	},

	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: tSettingsUi("General"),
			label: tSettingsUi("Branch Summaries"),
			description: tSettingsUi("Prompt to summarize when leaving a branch"),
		},
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. The legacy
	// `memories.enabled` flag is migration input only; see config/settings.ts.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
		ui: {
			tab: "memory",
			group: tSettingsUi("General"),
			label: tSettingsUi("Memory Backend"),
			description: tSettingsUi("Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory"),
			options: [
				{ value: "off", label: tSettingsUi("Off"), description: tSettingsUi("No memory subsystem runs") },
				{
					value: "local",
					label: tSettingsUi("Local"),
					description: tSettingsUi("Local rollout summarisation pipeline (memory_summary.md)"),
				},
				{
					value: "hindsight",
					label: tSettingsUi("Hindsight"),
					description: tSettingsUi("Vectorize Hindsight remote memory service"),
				},
				{
					value: "mnemopi",
					label: tSettingsUi("Mnemopi"),
					description: tSettingsUi("Local SQLite recall/retain backend with optional embeddings"),
				},
			],
		},
	},

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Auto-Learn"),
			label: tSettingsUi("Auto-Learn (experimental)"),
			description: tSettingsUi(
				"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
			),
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Auto-Learn"),
			label: tSettingsUi("Auto-run capture at stop"),
			description: tSettingsUi(
				"When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.",
			),
			condition: "autolearnActive",
		},
	},
	// Config-file-only knob (numbers without `options` are hidden from the UI).
	"autolearn.minToolCalls": { type: "number", default: 5 },

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi DB Path"),
			description: tSettingsUi("Optional SQLite DB path. Defaults to the agent memories directory."),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Bank"),
			description: tSettingsUi(
				"Optional shared bank base name. Per-project modes derive project-local banks from it.",
			),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Scoping"),
			description: tSettingsUi(
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
			),
			options: [
				{
					value: "global",
					label: tSettingsUi("Global"),
					description: tSettingsUi("One shared Mnemopi bank for every project"),
				},
				{
					value: "per-project",
					label: tSettingsUi("Per project"),
					description: tSettingsUi("Project-local Mnemopi bank per cwd basename"),
				},
				{
					value: "per-project-tagged",
					label: tSettingsUi("Per project (tagged)"),
					description: tSettingsUi("Write to a project-local bank but merge project + shared recall results"),
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingVariant": {
		type: "enum",
		values: ["en", "multilingual"] as const,
		default: "en",
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Embedding variant"),
			description: tSettingsUi(
				"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
			),
			options: [
				{
					value: "en",
					label: tSettingsUi("English (bge-base-en-v1.5)"),
					description: tSettingsUi("BAAI/bge-base-en-v1.5 (768d), English-only"),
				},
				{
					value: "multilingual",
					label: tSettingsUi("Multilingual (multilingual-e5-large)"),
					description: tSettingsUi("intfloat/multilingual-e5-large (1024d), cross-language recall"),
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Auto Recall"),
			description: tSettingsUi("Recall local memories into the first turn of each session"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Auto Retain"),
			description: tSettingsUi("Retain completed conversation turns into local Mnemopi memory"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.polyphonicRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Polyphonic Recall"),
			description: tSettingsUi(
				"Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
			),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.enhancedRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Enhanced Recall"),
			description: tSettingsUi("Enable the tiered query result cache for repeated and similar recall queries"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.proactiveLinking": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Proactive Linking"),
			description: tSettingsUi(
				"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories",
			),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Disable Embeddings"),
			description: tSettingsUi("Force deterministic FTS-only recall instead of vector embeddings"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Embedding Model"),
			description: tSettingsUi(
				"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.",
			),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Embedding API URL"),
			description: tSettingsUi("Optional OpenAI-compatible embedding endpoint passed to Mnemopi"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi Embedding API Key"),
			description: tSettingsUi("Optional embedding API key passed to Mnemopi"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi LLM Mode"),
			description: tSettingsUi(
				"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint",
			),
			condition: "mnemopiActive",
			options: [
				{
					value: "none",
					label: tSettingsUi("None"),
					description: tSettingsUi("Disable Mnemopi LLM-backed extraction"),
				},
				{
					value: "smol",
					label: tSettingsUi("Online (tiny)"),
					description: tSettingsUi("Use the online tiny model (the TINY role from /models, else @smol)"),
				},
				{
					value: "remote",
					label: tSettingsUi("Remote"),
					description: tSettingsUi("Use the Mnemopi remote LLM settings below"),
				},
			],
		},
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi LLM Base URL"),
			description: tSettingsUi("Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmApiKey": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi LLM API Key"),
			description: tSettingsUi("Optional LLM API key for Mnemopi remote mode"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Mnemopi"),
			label: tSettingsUi("Mnemopi LLM Model"),
			description: tSettingsUi("Optional LLM model name for Mnemopi remote mode"),
			condition: "mnemopiActive",
		},
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 8 },
	"mnemopi.recallContextTurns": { type: "number", default: 3 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 4000 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 5000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight API URL"),
			description: tSettingsUi("Hindsight server URL (Cloud or self-hosted)"),
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API Token",
			description: "Bearer token for authenticated Hindsight servers",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Bank ID"),
			description: tSettingsUi("Memory bank identifier (default: project name)"),
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Scoping"),
			description: tSettingsUi(
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			),
			options: [
				{
					value: "global",
					label: tSettingsUi("Global"),
					description: tSettingsUi("One shared bank — every project sees the same memories"),
				},
				{
					value: "per-project",
					label: tSettingsUi("Per project"),
					description: tSettingsUi("Isolated bank per cwd basename — projects cannot see each other's memories"),
				},
				{
					value: "per-project-tagged",
					label: tSettingsUi("Per project (tagged)"),
					description: tSettingsUi(
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
					),
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Auto Recall"),
			description: tSettingsUi("Recall memories on the first turn of each session"),
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Auto Retain"),
			description: tSettingsUi("Retain transcript every N turns and at session boundaries"),
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Retain Mode"),
			description: tSettingsUi("full-session = upsert one document per session, last-turn = chunked"),
			options: [
				{
					value: "full-session",
					label: tSettingsUi("Full session"),
					description: tSettingsUi("Upsert one document per session (recommended)"),
				},
				{
					value: "last-turn",
					label: tSettingsUi("Last turn"),
					description: tSettingsUi("Chunked retention sliced by turn boundaries"),
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "omp" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.requestTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.reflectTimeoutMs": { type: "number", default: 120_000 },
	"hindsight.recallTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.retainTimeoutMs": { type: "number", default: 60_000 },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Mental Models"),
			description: tSettingsUi(
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			),
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: tSettingsUi("Hindsight"),
			label: tSettingsUi("Hindsight Mental Model Auto-Seed"),
			description: tSettingsUi(
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			),
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("TTSR"),
			description: tSettingsUi(
				"Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
			),
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("TTSR Context Mode"),
			description: tSettingsUi("What to do with partial output when TTSR triggers"),
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("TTSR Interrupt Mode"),
			description: tSettingsUi("When to interrupt mid-stream vs inject warning after completion"),
			options: [
				{
					value: "always",
					label: tSettingsUi("always"),
					description: tSettingsUi("Interrupt on prose and tool streams"),
				},
				{
					value: "prose-only",
					label: tSettingsUi("prose-only"),
					description: tSettingsUi("Interrupt only on reply/thinking matches"),
				},
				{
					value: "tool-only",
					label: tSettingsUi("tool-only"),
					description: tSettingsUi("Interrupt only on tool-call argument matches"),
				},
				{
					value: "never",
					label: tSettingsUi("never"),
					description: tSettingsUi("Never interrupt; inject warning after completion"),
				},
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("TTSR Repeat Mode"),
			description: tSettingsUi("How rules can repeat: once per session or after a message gap"),
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("TTSR Repeat Gap"),
			description: tSettingsUi("Messages before a rule can trigger again"),
			options: [
				{ value: "5", label: tSettingsUi("5 messages") },
				{ value: "10", label: tSettingsUi("10 messages") },
				{ value: "15", label: tSettingsUi("15 messages") },
				{ value: "20", label: tSettingsUi("20 messages") },
				{ value: "30", label: tSettingsUi("30 messages") },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("Built-in Rules"),
			description: tSettingsUi(
				"Load the default rules shipped with the agent (override individually with ttsr.disabledRules)",
			),
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: tSettingsUi("Rules (TTSR)"),
			label: tSettingsUi("Disabled Rules"),
			description: tSettingsUi("Rule names to ignore entirely (applies to bundled defaults and your own rules)"),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Edit Mode"),
			description: tSettingsUi("Select the edit tool variant (replace, patch, hashline, or apply_patch)"),
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Fuzzy Match"),
			description: tSettingsUi("Accept high-confidence fuzzy matches for whitespace differences"),
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Fuzzy Match Threshold"),
			description: tSettingsUi("Similarity threshold (0-1) for accepting fuzzy matches"),
			options: [
				{ value: "0.85", label: tSettingsUi("0.85"), description: tSettingsUi("Lenient") },
				{ value: "0.90", label: tSettingsUi("0.90"), description: tSettingsUi("Moderate") },
				{ value: "0.95", label: tSettingsUi("0.95"), description: tSettingsUi("Default") },
				{ value: "0.98", label: tSettingsUi("0.98"), description: tSettingsUi("Strict") },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Abort on Failed Preview"),
			description: tSettingsUi("Abort streaming edit tool calls when patch preview fails"),
		},
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Block Auto-Generated Files"),
			description: tSettingsUi(
				"Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)",
			),
		},
	},

	"edit.enforceSeenLines": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("Editing"),
			label: tSettingsUi("Enforce Seen-Line Guard"),
			description: tSettingsUi("Reject edits anchored on lines a prior read/search never displayed in full"),
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("Reading"),
			label: tSettingsUi("Line Numbers"),
			description: tSettingsUi("Prepend line numbers to read tool output by default"),
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "files",
			group: tSettingsUi("Reading"),
			label: tSettingsUi("Default Read Limit"),
			description: tSettingsUi("Default number of lines returned when agent calls read without a limit"),
			options: [
				{ value: "200", label: tSettingsUi("200 lines") },
				{ value: "300", label: tSettingsUi("300 lines") },
				{ value: "500", label: tSettingsUi("500 lines") },
				{ value: "1000", label: tSettingsUi("1000 lines") },
				{ value: "5000", label: tSettingsUi("5000 lines") },
			],
		},
	},

	"read.renderMarkdown": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Markdown Previews",
			description: "Render Markdown read results as formatted terminal Markdown previews instead of raw source",
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summaries"),
			description: tSettingsUi("Return structural code summaries when read is called without an explicit selector"),
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Prose Summaries"),
			description: tSettingsUi("Return structural summaries for Markdown and plain text reads"),
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summary Body Lines"),
			description: tSettingsUi("Minimum multiline body or literal length before read summaries collapse it"),
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summary Comment Lines"),
			description: tSettingsUi("Minimum multiline block comment length before read summaries collapse it"),
		},
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summary Minimum File Length"),
			description: tSettingsUi("Files with fewer total lines are read verbatim instead of structurally summarized"),
		},
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summary Unfold Target"),
			description: tSettingsUi(
				"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.",
			),
		},
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: tSettingsUi("Read Summaries"),
			label: tSettingsUi("Read Summary Unfold Ceiling"),
			description: tSettingsUi(
				"Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.",
			),
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("Reading"),
			label: tSettingsUi("Inline Read Previews"),
			description: tSettingsUi("Render read tool results inline in the transcript instead of summary rows"),
		},
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("LSP"),
			description: tSettingsUi(
				"Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)",
			),
		},
	},

	"lsp.lazy": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("Lazy LSP Startup"),
			description: tSettingsUi(
				"Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup",
			),
		},
	},

	"lsp.shared": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "Shared Language Servers",
			description:
				"Share one language server per project across omp instances via the daemon broker (falls back to private servers when unavailable)",
		},
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("Format on Write"),
			description: tSettingsUi("Automatically format code files using LSP after writing"),
		},
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("Diagnostics on Write"),
			description: tSettingsUi("Return LSP diagnostics after writing code files"),
		},
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("Diagnostics on Edit"),
			description: tSettingsUi("Return LSP diagnostics after editing code files"),
		},
	},

	"lsp.diagnosticsDeduplicate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: tSettingsUi("LSP"),
			label: tSettingsUi("Deduplicate Diagnostics"),
			description: tSettingsUi(
				"Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones",
			),
		},
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Bash"),
			description: tSettingsUi("Enable the bash tool for shell command execution"),
		},
	},

	"bash.async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Bash Async Execution"),
			description: tSettingsUi("Allow bash calls to run as explicit async background jobs"),
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Bash Auto-Background"),
			description: tSettingsUi("Automatically background long-running bash commands and deliver the result later"),
		},
	},
	"bash.patterns": {
		type: "array",
		default: [],
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Approval Patterns",
			description:
				"Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.",
		},
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Bash Interceptor"),
			description: tSettingsUi("Block shell commands that have dedicated tools"),
		},
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.direnv": {
		type: "enum",
		values: ["auto", "off"] as const,
		default: "auto",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv Auto-Load",
			description:
				"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed",
		},
	},
	"bash.direnvLoadTimeoutMs": {
		type: "number",
		default: 30_000,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv Load Timeout (ms)",
			description:
				"Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env",
		},
	},
	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Shell Minimizer"),
			description: tSettingsUi(
				"Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
			),
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
		ui: {
			tab: "shell",
			group: tSettingsUi("Bash"),
			label: tSettingsUi("Shell Minimizer Source Outline"),
			description: tSettingsUi("Source outline mode for cat/read of source files: default or aggressive"),
		},
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Python Eval Backend"),
			description: tSettingsUi("Allow the eval tool to dispatch Python cells to the IPython kernel"),
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("JavaScript Eval Backend"),
			description: tSettingsUi("Allow the eval tool to dispatch JavaScript cells to the in-process runtime"),
		},
	},

	"eval.rb": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Ruby Eval Backend"),
			description: tSettingsUi("Allow the eval tool to dispatch Ruby cells to the persistent Ruby kernel"),
		},
	},

	"eval.jl": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Julia Eval Backend"),
			description: tSettingsUi("Allow the eval tool to dispatch Julia cells to the persistent Julia kernel"),
		},
	},

	// Runtime knobs (consumed by eval backends and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Python Kernel Mode"),
			description: tSettingsUi("Keep the IPython kernel alive across eval calls or start fresh each time"),
		},
	},
	"python.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Python Interpreter"),
			description: tSettingsUi(
				"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
			),
		},
	},
	"ruby.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Ruby Interpreter"),
			description: tSettingsUi(
				"Optional path to an exact Ruby executable. When set, automatic Ruby runtime discovery is skipped.",
			),
		},
	},
	"julia.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: tSettingsUi("Eval & Runtimes"),
			label: tSettingsUi("Julia Interpreter"),
			description: tSettingsUi(
				"Optional path to an exact Julia executable. When set, automatic Julia runtime discovery is skipped.",
			),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
		ui: {
			tab: "interaction",
			group: tSettingsUi("Approvals"),
			label: tSettingsUi("Tool Approval Policies"),
			description: tSettingsUi(
				"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
			),
		},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
	//   "write"      — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"       — auto-approves every tier.
	"tools.approvalMode": {
		type: "enum",
		values: ["always-ask", "write", "yolo"] as const,
		default: "yolo",
		ui: {
			tab: "interaction",
			group: tSettingsUi("Approvals"),
			label: tSettingsUi("Tool Approval"),
			description: tSettingsUi(
				"Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
			),
			options: [
				{
					value: "always-ask",
					label: tSettingsUi("Always ask"),
					description: tSettingsUi("Auto-approve read-only tools; require confirmation for write and exec tools."),
				},
				{
					value: "write",
					label: tSettingsUi("Write"),
					description: tSettingsUi(
						"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, and task.",
					),
				},
				{
					value: "yolo",
					label: tSettingsUi("Yolo"),
					description: tSettingsUi(
						"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.",
					),
				},
			],
		},
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Todos"),
			description: tSettingsUi("Enable the todo tool for task tracking"),
		},
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Todos"),
			label: tSettingsUi("Todo Reminders"),
			description: tSettingsUi("Remind the agent to complete todos before stopping"),
		},
	},

	"todo.remindersMax": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: tSettingsUi("Todos"),
			label: tSettingsUi("Todo Reminder Limit"),
			description: tSettingsUi("Maximum number of todo reminders before giving up"),
			options: [
				{ value: "1", label: tSettingsUi("1 reminder") },
				{ value: "2", label: tSettingsUi("2 reminders") },
				{ value: "3", label: tSettingsUi("3 reminders") },
				{ value: "5", label: tSettingsUi("5 reminders") },
			],
		},
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tools",
			group: tSettingsUi("Todos"),
			label: tSettingsUi("Create Todos Automatically"),
			description: tSettingsUi("How strongly to push automatic todo-list creation after the first message"),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Model decides; no automatic todo list"),
				},
				{
					value: "preferred",
					label: tSettingsUi("Preferred"),
					description: tSettingsUi("Suggests a todo list on the first message (reminder, not forced)"),
				},
				{
					value: "always",
					label: tSettingsUi("Always"),
					description: tSettingsUi("Forces a comprehensive todo list on the first message"),
				},
			],
		},
	},

	// FFF search tools
	"find.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Find"),
			description: tSettingsUi("Enable FFF fuzzy path and glob search"),
		},
	},

	"grep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Grep"),
			description: tSettingsUi("Enable FFF indexed content search"),
		},
	},

	"multiGrep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Multi Grep"),
			description: tSettingsUi("Enable FFF multi-pattern OR content search"),
		},
	},

	"grep.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			group: tSettingsUi("Grep & Browser"),
			label: tSettingsUi("Grep Context Before"),
			description: tSettingsUi("Lines of context before each grep match"),
			options: [
				{ value: "0", label: tSettingsUi("0 lines") },
				{ value: "1", label: tSettingsUi("1 line") },
				{ value: "2", label: tSettingsUi("2 lines") },
				{ value: "3", label: tSettingsUi("3 lines") },
				{ value: "5", label: tSettingsUi("5 lines") },
			],
		},
	},

	"grep.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: tSettingsUi("Grep & Browser"),
			label: tSettingsUi("Grep Context After"),
			description: tSettingsUi("Lines of context after each grep match"),
			options: [
				{ value: "0", label: tSettingsUi("0 lines") },
				{ value: "1", label: tSettingsUi("1 line") },
				{ value: "2", label: tSettingsUi("2 lines") },
				{ value: "3", label: tSettingsUi("3 lines") },
				{ value: "5", label: tSettingsUi("5 lines") },
				{ value: "10", label: tSettingsUi("10 lines") },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("AST Grep"),
			description: tSettingsUi("Enable the ast_grep tool for structural AST search"),
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("AST Edit"),
			description: tSettingsUi("Enable the ast_edit tool for structural AST rewrites"),
		},
	},

	// Optional tools

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Debug"),
			description: tSettingsUi("Enable the debug tool for DAP-based debugging"),
		},
	},

	"launch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Launch"),
			description: tSettingsUi("Enable the launch tool for supervising shared long-running project processes"),
		},
	},

	"speechgen.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Speech Generation"),
			description: tSettingsUi("Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis"),
		},
	},
	"generate_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Generate Image"),
			description: tSettingsUi(
				"Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.",
			),
		},
	},

	// Legacy boolean kept only for back-compat migration to `inspect_image.mode`
	// (see config/settings.ts). Hidden from UI.
	"inspect_image.enabled": {
		type: "boolean",
		default: false,
	},

	"inspect_image.mode": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Inspect Image"),
			description: tSettingsUi(
				"Controls the inspect_image tool, which delegates image understanding to a vision-capable model. 'auto' exposes it only when the active model lacks native image input; 'on' always exposes it; 'off' never does.",
			),
			options: [
				{ value: "auto", label: tSettingsUi("Auto (only for models without vision)") },
				{ value: "on", label: tSettingsUi("On") },
				{ value: "off", label: tSettingsUi("Off") },
			],
		},
	},

	"computer.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Computer",
			description: "Enable the scriptable host-desktop control tool (screenshots, input, accessibility)",
		},
	},

	"computer.display": {
		type: "string",
		default: "all",
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Display",
			description: "Composite all displays or select a native display id",
		},
	},

	"computer.maxWidth": {
		type: "number",
		default: 3840,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Screenshot Width",
			description: "Maximum composite screenshot width in pixels",
		},
	},

	"computer.maxHeight": {
		type: "number",
		default: 2400,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "Computer Screenshot Height",
			description: "Maximum composite screenshot height in pixels",
		},
	},

	"inspect_image.timeoutMs": {
		type: "number",
		default: 300_000,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Inspect Image Timeout"),
			description: tSettingsUi(
				"Per-request timeout for the inspect_image vision-model call, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Disabled") },
				{ value: "60000", label: tSettingsUi("1 minute") },
				{ value: "120000", label: tSettingsUi("2 minutes") },
				{ value: "180000", label: tSettingsUi("3 minutes") },
				{ value: "300000", label: tSettingsUi("5 minutes") },
			],
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Checkpoint/Rewind"),
			description: tSettingsUi("Enable the checkpoint and rewind tools for context checkpointing"),
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Read URLs"),
			description: tSettingsUi("Allow the read tool to fetch and process URLs"),
		},
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Obsidian Vault"),
			description: tSettingsUi(
				"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
			),
		},
	},

	"siyuan.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("SiYuan"),
			description: tSettingsUi(
				"Enable the SiYuan tool after verifying a compatible SiYuan Kernel CLI on PATH. macOS also requires the official SiYuan code signature.",
			),
		},
	},

	"siyuan.workspace": {
		type: "string",
		default: "",
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("SiYuan Workspace"),
			description: tSettingsUi(
				"Default registered SiYuan workspace name or absolute path. Required for commands when multiple workspaces are registered unless supplied per call.",
			),
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("GitHub CLI"),
			description: tSettingsUi(
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
			),
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("GitHub"),
			label: tSettingsUi("GitHub View Cache"),
			description: tSettingsUi(
				"Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free",
			),
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			group: tSettingsUi("GitHub"),
			label: tSettingsUi("GitHub Cache Soft TTL"),
			description: tSettingsUi(
				"Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)",
			),
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			group: tSettingsUi("GitHub"),
			label: tSettingsUi("GitHub Cache Hard TTL"),
			description: tSettingsUi(
				"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)",
			),
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Web Search"),
			description: tSettingsUi("Enable the web_search tool for live web results"),
		},
	},

	"security.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Security",
			description:
				"Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace",
		},
	},

	"ask.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Ask"),
			description: tSettingsUi("Enable the ask tool for interactive user questions"),
		},
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Available Tools"),
			label: tSettingsUi("Browser"),
			description: tSettingsUi("Enable the browser tool for scripted Chromium automation (puppeteer)"),
		},
	},

	"browser.cdpUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser CDP URL",
			description:
				"Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence.",
		},
	},

	"browser.relay": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser Relay",
			description:
				"Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.",
		},
	},

	"browser.relayUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Browser Relay URL",
			description: "omp browser relay endpoint (default http://127.0.0.1:9224).",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Grep & Browser"),
			label: tSettingsUi("Headless Browser"),
			description: tSettingsUi("Launch browser in headless mode (disable to show browser UI)"),
		},
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Grep & Browser"),
			label: tSettingsUi("cmux Browser"),
			description: tSettingsUi(
				"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.",
			),
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: tSettingsUi("Grep & Browser"),
			label: tSettingsUi("Screenshot Directory"),
			description: tSettingsUi(
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
			),
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Intent Tracing"),
			description: tSettingsUi("Ask the agent to describe the intent of each tool call before executing it"),
		},
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Abort On Fabricated Tool Result"),
			description: tSettingsUi(
				"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.",
			),
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Max Tool Timeout"),
			description: tSettingsUi("Maximum timeout in seconds the agent can set for any tool (0 = no limit)"),
			options: [
				{ value: "0", label: tSettingsUi("No limit") },
				{ value: "30", label: tSettingsUi("30 seconds") },
				{ value: "60", label: tSettingsUi("60 seconds") },
				{ value: "120", label: tSettingsUi("120 seconds") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "600", label: tSettingsUi("10 minutes") },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Async Execution"),
			description: tSettingsUi("Enable async bash commands and background task execution"),
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("Max Poll Time"),
			description: tSettingsUi(
				"How long a `hub` wait watches background jobs before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back wait (up to 5m), then resets to 5s after about a minute without waiting.",
			),
			options: [
				{ value: "5s", label: tSettingsUi("5 seconds") },
				{ value: "10s", label: tSettingsUi("10 seconds") },
				{ value: "30s", label: tSettingsUi("30 seconds") },
				{ value: "1m", label: tSettingsUi("1 minute") },
				{ value: "5m", label: tSettingsUi("5 minutes") },
				{
					value: "smart",
					label: tSettingsUi("Smart"),
					description: tSettingsUi("Default — adaptive 5s→5m, resets when you stop polling"),
				},
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			group: tSettingsUi("Execution"),
			label: tSettingsUi("IRC Timeout"),
			description: tSettingsUi(
				"Default timeout for hub message waits (and send await:true) in milliseconds; 0 disables the timeout",
			),
			options: [
				{ value: "0", label: tSettingsUi("Disabled") },
				{ value: "30000", label: tSettingsUi("30 seconds") },
				{ value: "60000", label: tSettingsUi("1 minute") },
				{ value: "120000", label: tSettingsUi("2 minutes") },
				{ value: "300000", label: tSettingsUi("5 minutes") },
			],
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	"tools.xdev": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Discovery & MCP"),
			label: tSettingsUi("xd:// Tools"),
			description: tSettingsUi(
				"Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level.",
			),
		},
	},

	"tools.xdevDocs": {
		type: "enum",
		values: ["inline", "builtins", "catalog"] as const,
		default: "builtins",
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// Prompt Docs",
			description:
				"Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.",
			options: [
				{ value: "inline", label: "All Devices", description: "Inline docs and schemas for every mounted device." },
				{
					value: "builtins",
					label: "Built-ins Only",
					description: "Inline built-in docs; fetch MCP and extension docs on demand.",
				},
				{ value: "catalog", label: "Catalog Only", description: "List every device; fetch all docs on demand." },
			],
		},
	},

	"tools.xdevInlineDevices": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// Inline Devices",
			description:
				"When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Discovery & MCP"),
			label: tSettingsUi("MCP Project Config"),
			description: tSettingsUi("Load .mcp.json/mcp.json from project root"),
		},
	},

	"mcp.renderMarkdownResults": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Markdown Results",
			description: "Render non-JSON MCP text results as Markdown in the transcript",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Discovery & MCP"),
			label: tSettingsUi("MCP Update Injection"),
			description: tSettingsUi("Inject MCP resource updates into the agent conversation"),
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: tSettingsUi("Discovery & MCP"),
			label: tSettingsUi("MCP Notification Debounce"),
			description: tSettingsUi(
				"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
			),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Plan Mode"),
			description: tSettingsUi("Enable plan mode for read-only exploration and planning before execution"),
		},
	},

	"plan.defaultOnStartup": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Start in Plan Mode"),
			description: tSettingsUi("Automatically enter plan mode at the start of every new session"),
			condition: "planModeEnabled",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Goal Mode"),
			description: tSettingsUi("Enable per-session goal mode and the hidden goal tool"),
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Goal Status in Footer"),
			description: tSettingsUi("Show token budget alongside the goal indicator in the status line"),
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Goal Continuation Modes"),
			description: tSettingsUi("Run modes where active goals may auto-continue between turns"),
		},
	},

	"heartbeat.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Heartbeat"),
			label: tSettingsUi("Enable Heartbeat"),
			description: tSettingsUi("Enable persisted heartbeat prompts for the current session"),
		},
	},
	"heartbeat.defaultInterval": {
		type: "string",
		default: "5m",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Heartbeat"),
			label: tSettingsUi("Default Interval"),
			description: tSettingsUi("Default interval used by /heartbeat when no interval is specified"),
		},
	},
	"heartbeat.defaultDeliveryMode": {
		type: "enum",
		default: "steer",
		values: ["steer", "follow_up"] as const,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Heartbeat"),
			label: tSettingsUi("Delivery Mode"),
			description: tSettingsUi("Default delivery mode used by /heartbeat"),
		},
	},
	"schedule.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Schedule"),
			label: tSettingsUi("Enable Scheduling"),
			description: tSettingsUi("Enable persisted scheduled prompts for the current session"),
		},
	},
	"schedule.defaultDeliveryMode": {
		type: "enum",
		default: "follow_up",
		values: ["steer", "follow_up"] as const,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Schedule"),
			label: tSettingsUi("Delivery Mode"),
			description: tSettingsUi("Default delivery mode used by /schedule"),
		},
	},
	"autonomous.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Enable Autonomous Mode"),
			description: tSettingsUi("Enable automatic continuation without waiting for user input"),
		},
	},
	"autonomous.maxContinuations": {
		type: "number",
		default: 3,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Max Continuations"),
			description: tSettingsUi("Maximum automatic continuations after a turn completes"),
			input: true,
			min: 1,
			max: 8,
			integer: true,
		},
	},
	"autonomous.maxTurns": {
		type: "number",
		default: 12,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Max Turns"),
			description: tSettingsUi("Maximum turns in one autonomous run"),
		},
	},
	"autonomous.maxTokens": {
		type: "number",
		default: 80000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Max Tokens"),
			description: tSettingsUi("Maximum tokens available to one autonomous run"),
		},
	},
	"autonomous.timeoutMs": {
		type: "number",
		default: 1800000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Timeout (ms)"),
			description: tSettingsUi("Maximum duration in milliseconds for one autonomous run"),
		},
	},
	"autonomous.gate.commands": {
		type: "array",
		default: [],
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Gate Commands"),
			description: tSettingsUi("Commands that must succeed before autonomous work can continue"),
		},
	},
	"autonomous.gate.maxRetries": {
		type: "number",
		default: 3,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Gate Max Retries"),
			description: tSettingsUi("Maximum retries for each autonomous gate command"),
		},
	},
	"autonomous.gate.timeoutMs": {
		type: "number",
		default: 300000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Autonomous"),
			label: tSettingsUi("Gate Timeout (ms)"),
			description: tSettingsUi("Maximum duration in milliseconds for each autonomous gate command"),
		},
	},
	"refinement.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Refinement"),
			label: tSettingsUi("Enable /refine"),
			description: tSettingsUi("Enable /refine and continual harness updates"),
		},
	},
	"refinement.autoRefineTurns": {
		type: "number",
		default: 25,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Refinement"),
			label: tSettingsUi("Auto Refine Turns"),
			description: tSettingsUi("Run refinement automatically after this many turns"),
		},
	},
	"refinement.autoRefineCooldownMs": {
		type: "number",
		default: 1200000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Refinement"),
			label: tSettingsUi("Auto Refine Cooldown (ms)"),
			description: tSettingsUi("Minimum milliseconds between automatic refinements"),
		},
	},
	"pythonSkills.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: tSettingsUi("Python Skills"),
			label: tSettingsUi("Enable Python Skills"),
			description: tSettingsUi("Enable bundled Python skills"),
		},
	},
	"pythonSkills.trust": {
		type: "enum",
		default: "prompt",
		values: ["prompt", "auto", "off"] as const,
		ui: {
			tab: "tools",
			group: tSettingsUi("Python Skills"),
			label: tSettingsUi("Trust Mode"),
			description: tSettingsUi("Choose whether Python skills require confirmation before running"),
		},
	},
	"rlm.maxDepth": {
		type: "number",
		default: 1,
		ui: {
			tab: "tasks",
			group: tSettingsUi("RLM"),
			label: tSettingsUi("RLM Max Depth"),
			description: tSettingsUi(
				"Maximum RLM child recursion depth (root is depth 0); the effective cap is the stricter of this and task.maxRecursionDepth.",
			),
			input: true,
			min: -1,
			integer: true,
		},
	},

	"title.refreshOnReplan": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Modes"),
			label: tSettingsUi("Refresh Title on Replan"),
			description: tSettingsUi(
				"Refresh generated session titles after todo init replans unless the title was set by the user",
			),
		},
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Isolation"),
			label: tSettingsUi("Isolation Mode"),
			description: tSettingsUi(
				'Isolation backend for subagents. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			),
			options: [
				{ value: "none", label: tSettingsUi("None"), description: tSettingsUi("No isolation") },
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Let the PAL pick the best available backend"),
				},
				{ value: "apfs", label: tSettingsUi("APFS"), description: tSettingsUi("macOS clonefile reflink (APFS)") },
				{ value: "btrfs", label: tSettingsUi("btrfs"), description: tSettingsUi("btrfs subvolume snapshot") },
				{ value: "zfs", label: tSettingsUi("ZFS"), description: tSettingsUi("ZFS snapshot + clone") },
				{
					value: "reflink",
					label: tSettingsUi("Reflink"),
					description: tSettingsUi("Linux FICLONE per-file reflink"),
				},
				{
					value: "overlayfs",
					label: tSettingsUi("Overlayfs"),
					description: tSettingsUi("Linux kernel overlay (or fuse-overlayfs fallback)"),
				},
				{
					value: "projfs",
					label: tSettingsUi("ProjFS"),
					description: tSettingsUi("Windows Projected File System"),
				},
				{
					value: "block-clone",
					label: tSettingsUi("Block clone"),
					description: tSettingsUi("Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)"),
				},
				{
					value: "rcopy",
					label: tSettingsUi("Recursive copy"),
					description: tSettingsUi("git worktree if available, otherwise recursive copy"),
				},
			],
		},
	},

	"task.isolation.apply": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "Apply Isolated Changes",
			description:
				"Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts",
		},
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Isolation"),
			label: tSettingsUi("Isolation Merge Strategy"),
			description: tSettingsUi("How isolated task changes are integrated (patch apply or branch merge)"),
			options: [
				{ value: "patch", label: tSettingsUi("Patch"), description: tSettingsUi("Combine diffs and git apply") },
				{
					value: "branch",
					label: tSettingsUi("Branch"),
					description: tSettingsUi("Commit per task, merge with --no-ff"),
				},
			],
		},
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Isolation"),
			label: tSettingsUi("Isolation Commit Style"),
			description: tSettingsUi("Commit message style for nested repo changes (generic or AI-generated)"),
			options: [
				{ value: "generic", label: tSettingsUi("Generic"), description: tSettingsUi("Static commit message") },
				{
					value: "ai",
					label: tSettingsUi("AI"),
					description: tSettingsUi("AI-generated commit message from diff"),
				},
			],
		},
	},

	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Isolation"),
			label: tSettingsUi("Worktree Base Directory"),
			description: tSettingsUi(
				"Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this.",
			),
		},
	},

	"task.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Prefer Task Delegation"),
			description: tSettingsUi("How strongly to push delegating work to subagents"),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("Model decides when to delegate"),
				},
				{
					value: "preferred",
					label: tSettingsUi("Preferred"),
					description: tSettingsUi("Adds delegation guidance to the system prompt"),
				},
				{
					value: "always",
					label: tSettingsUi("Always"),
					description: tSettingsUi("Prompt guidance plus a first-turn delegation reminder"),
				},
			],
		},
	},

	"task.batch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Batch Task Calls"),
			description: tSettingsUi(
				"Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.",
			),
		},
	},

	"task.enableEffort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Per-Task Effort"),
			description: tSettingsUi(
				"Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level",
			),
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 8,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Max Concurrent Tasks"),
			description: tSettingsUi(
				"Maximum running or runnable subagents across the current root session tree. Parents temporarily release their slot while waiting for blocking children or Hub replies.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Unlimited") },
				{ value: "1", label: tSettingsUi("1 task") },
				{ value: "2", label: tSettingsUi("2 tasks") },
				{ value: "4", label: tSettingsUi("4 tasks") },
				{ value: "8", label: tSettingsUi("8 tasks"), description: tSettingsUi("Default") },
				{ value: "16", label: tSettingsUi("16 tasks") },
				{ value: "32", label: tSettingsUi("32 tasks") },
				{ value: "64", label: tSettingsUi("64 tasks") },
			],
		},
	},

	"task.maxRequestConcurrency": {
		type: "number",
		default: 8,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Max Concurrent Subagent Requests"),
			description: tSettingsUi(
				"Maximum simultaneous subagent LLM requests across the current root session tree. This provider-safety limit is separate from the runnable-agent limit.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Unlimited") },
				{ value: "1", label: tSettingsUi("1 task") },
				{ value: "2", label: tSettingsUi("2 tasks") },
				{ value: "4", label: tSettingsUi("4 tasks") },
				{ value: "8", label: tSettingsUi("8 tasks"), description: tSettingsUi("Default") },
				{ value: "16", label: tSettingsUi("16 tasks") },
				{ value: "32", label: tSettingsUi("32 tasks") },
				{ value: "64", label: tSettingsUi("64 tasks") },
			],
		},
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("LSP in Subagents"),
			description: tSettingsUi(
				"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
			),
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 1,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Max Task Recursion"),
			description: tSettingsUi("How many levels deep subagents can spawn their own subagents"),
			options: [
				{ value: "-1", label: tSettingsUi("Unlimited") },
				{ value: "0", label: tSettingsUi("None") },
				{ value: "1", label: tSettingsUi("Single"), description: tSettingsUi("Default") },
				{ value: "2", label: tSettingsUi("Double") },
				{ value: "3", label: tSettingsUi("Triple") },
			],
		},
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 900000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Max Subagent Runtime"),
			description: tSettingsUi(
				"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Unlimited") },
				{ value: "300000", label: tSettingsUi("5 minutes") },
				{ value: "900000", label: tSettingsUi("15 minutes"), description: tSettingsUi("Default") },
				{ value: "1800000", label: tSettingsUi("30 minutes") },
				{ value: "3600000", label: tSettingsUi("1 hour") },
			],
		},
	},

	"task.agentIdleTtlMs": {
		type: "number",
		default: 420_000,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Agent Idle TTL"),
			description: tSettingsUi(
				"How long an idle subagent stays live in memory before time-based parking (ms). Parked agents are revived automatically when messaged or resumed. 0 disables time-based parking; task.maxLiveIdleAgents may still park idle agents by count.",
			),
		},
	},

	"task.maxLiveIdleAgents": {
		type: "number",
		default: 8,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Max Live Idle Agents"),
			description: tSettingsUi(
				"Maximum adopted idle subagents kept live in memory across the process. Oldest idle agents are parked first; 0 disables the count cap.",
			),
		},
	},

	"task.softRequestBudget": {
		type: "number",
		default: 90,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Soft Subagent Request Budget"),
			description: tSettingsUi(
				"Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them.",
			),
			options: [
				{ value: "0", label: tSettingsUi("Disabled") },
				{ value: "90", label: tSettingsUi("90 requests"), description: tSettingsUi("Default") },
				{ value: "150", label: tSettingsUi("150 requests") },
				{ value: "200", label: tSettingsUi("200 requests") },
			],
		},
	},

	"task.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Soft Request Budget Notice"),
			description: tSettingsUi(
				"Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.",
			),
		},
	},

	"task.maxEffort": {
		type: "enum",
		values: THINKING_EFFORTS,
		default: "max",
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Maximum Per-Spawn Effort"),
			description: tSettingsUi(
				"Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range.",
			),
			options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
		},
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: DEFAULT_AGENT_MODEL_OVERRIDES,
	},
	"task.agentPrewalk": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.agentAdvisor": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.prewalk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Subagents"),
			label: tSettingsUi("Generic Task Prewalk"),
			description: tSettingsUi(
				"Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, toggled with P in /agents) and user agent `prewalk` frontmatter apply regardless of this toggle.",
			),
		},
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tools",
			group: tSettingsUi("Todos"),
			label: tSettingsUi("Todo Auto-Clear Delay"),
			description: tSettingsUi("Delay before completed or abandoned todos are removed from the todo widget"),
			options: [
				{ value: "0", label: tSettingsUi("Instant") },
				{ value: "60", label: tSettingsUi("1 minute"), description: tSettingsUi("Default") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "900", label: tSettingsUi("15 minutes") },
				{ value: "1800", label: tSettingsUi("30 minutes") },
				{ value: "3600", label: tSettingsUi("1 hour") },
				{ value: "-1", label: tSettingsUi("Never") },
			],
		},
	},

	"task.showResolvedModelBadge": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: tSettingsUi("Display"),
			label: tSettingsUi("Show Resolved Model Badge"),
			description: tSettingsUi("Display the actual model ID used by each subagent in the task widget status line"),
		},
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Commands & Skills"),
			label: tSettingsUi("Skill Commands"),
			description: tSettingsUi("Register skills as /skill:name commands"),
		},
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.enableAgentsUser": { type: "boolean", default: true },

	"skills.enableAgentsProject": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Commands & Skills"),
			label: tSettingsUi("Claude User Commands"),
			description: tSettingsUi("Load commands from ~/.claude/commands/"),
		},
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Commands & Skills"),
			label: tSettingsUi("Claude Project Commands"),
			description: tSettingsUi("Load commands from .claude/commands/"),
		},
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Commands & Skills"),
			label: tSettingsUi("OpenCode User Commands"),
			description: tSettingsUi("Load commands from ~/.config/opencode/commands/"),
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: tSettingsUi("Commands & Skills"),
			label: tSettingsUi("OpenCode Project Commands"),
			description: tSettingsUi("Load commands from .opencode/commands/"),
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: tSettingsUi("Privacy"),
			label: tSettingsUi("Hide Secrets"),
			description: tSettingsUi(
				"Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
			),
		},
	},

	// Outbound network
	"network.proxy": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: tSettingsUi("Network"),
			label: tSettingsUi("Proxy URL"),
			description: tSettingsUi(
				"Route outbound provider and service requests through this HTTP(S) proxy. Leave empty to use inherited proxy environment variables.",
			),
		},
	},

	// Provider selection
	"providers.ollama-cloud.maxConcurrency": {
		type: "number",
		default: 3,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Ollama Cloud Max Concurrency"),
			description: tSettingsUi(
				"Maximum concurrent Ollama Cloud LLM requests per process; 0 disables the provider-specific limit",
			),
		},
	},
	"providers.webSearchOrder": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Web Search Provider Order"),
			description: tSettingsUi(
				"Prioritized providers for the web_search tool; unlisted providers retain their default order afterward",
			),
			options: SEARCH_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Excluded Web Search Providers"),
			description: tSettingsUi("Providers that web_search should never use, even as fallbacks"),
			options: SEARCH_PROVIDER_CHOICES,
		},
	},
	"providers.webSearchTimeoutSeconds": {
		type: "number",
		default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Web Search Timeout",
			description: `Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum ${MAX_WEB_SEARCH_TIMEOUT_SECONDS})`,
			options: [
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "180", label: "3 minutes" },
				{ value: "300", label: "5 minutes" },
			],
		},
	},
	"providers.webSearchGeminiModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Gemini web_search model"),
			description: tSettingsUi("Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash."),
		},
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Antigravity Endpoint Mode"),
			description: tSettingsUi(
				"Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Try production endpoint, fail over to sandbox on 5xx/429"),
				},
				{
					value: "production",
					label: tSettingsUi("Production Only"),
					description: tSettingsUi("Force production endpoint only"),
				},
				{
					value: "sandbox",
					label: tSettingsUi("Sandbox Only"),
					description: tSettingsUi("Force sandbox endpoint only"),
				},
			],
		},
	},
	"providers.imageOrder": {
		type: "array",
		default: [] as ImageProvider[],
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Image Provider Order"),
			description: tSettingsUi(
				"Prioritized providers for image generation; unlisted providers follow the active session provider and the built-in order",
			),
			options: IMAGE_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.fireworksTier": {
		type: "enum",
		values: ["standard", "priority"] as const,
		default: "standard",
		ui: {
			tab: "providers",
			group: tSettingsUi("Fireworks"),
			label: tSettingsUi("Fireworks Tier"),
			description: tSettingsUi(
				'Serving path for Fireworks requests. Priority sends `service_tier: "priority"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.',
			),
			options: [
				{
					value: "standard",
					label: tSettingsUi("Standard"),
					description: tSettingsUi("Default serving path (no service_tier)"),
				},
				{
					value: "priority",
					label: tSettingsUi("Priority"),
					description: tSettingsUi("Priority serving path: higher reliability, premium per-token pricing"),
				},
			],
		},
	},
	"live.voice": {
		type: "enum",
		values: LIVE_VOICE_VALUES,
		default: DEFAULT_LIVE_VOICE,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Live Voice"),
			description: tSettingsUi("Voice used by Codex-backed realtime voice sessions"),
			options: LIVE_VOICE_OPTIONS,
		},
	},
	"providers.tts": {
		type: "enum",
		values: ["auto", "local", "xai"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Text-to-Speech Provider"),
			description: tSettingsUi(
				"Backend for the tts tool: local on-device neural TTS (Kokoro-82M) or xAI Grok Voice",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Prefer local on-device TTS; route .mp3 output to xAI when credentials exist"),
				},
				{
					value: "local",
					label: tSettingsUi("Local"),
					description: tSettingsUi("On-device neural TTS (Kokoro-82M); output is WAV/PCM16"),
				},
				{
					value: "xai",
					label: tSettingsUi("xAI Grok Voice"),
					description: tSettingsUi("Requires xAI Grok OAuth or XAI_API_KEY; MP3 or WAV"),
				},
			],
		},
	},
	"tts.localModel": {
		type: "enum",
		values: TTS_LOCAL_MODEL_VALUES,
		default: DEFAULT_TTS_LOCAL_MODEL_KEY,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Local TTS Model"),
			description: tSettingsUi("On-device neural TTS model (Kokoro-82M) used by the local TTS backend"),
			options: TTS_LOCAL_MODEL_OPTIONS,
		},
	},
	"tts.localVoice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Local TTS Voice"),
			description: tSettingsUi("Kokoro voice used by the local TTS backend (American/British, female/male)"),
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"speech.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Speech Vocalization"),
			description: tSettingsUi("Speak the assistant's output aloud through the speakers as it streams"),
		},
	},
	"speech.mode": {
		type: "enum",
		values: ["all", "assistant", "yield"] as const,
		default: "assistant",
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Speech Vocalization Mode"),
			description: tSettingsUi(
				"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end",
			),
			options: [
				{ value: "all", label: tSettingsUi("All (messages + thinking)") },
				{ value: "assistant", label: tSettingsUi("Assistant messages") },
				{ value: "yield", label: tSettingsUi("Final message only") },
			],
		},
	},
	"speech.enhanced": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Enhanced Speech Rewriting"),
			description: tSettingsUi(
				"Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure",
			),
		},
	},
	"speech.voice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Speech Vocalization Voice"),
			description: tSettingsUi("Kokoro voice used when speaking the assistant's output aloud"),
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			group: tSettingsUi("Tiny Model"),
			label: tSettingsUi("Tiny Model"),
			description: tSettingsUi(
				"Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model",
			),
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			group: tSettingsUi("Tiny Model"),
			label: tSettingsUi("Tiny Model Device"),
			description: tSettingsUi(
				"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.",
			),
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			group: tSettingsUi("Tiny Model"),
			label: tSettingsUi("Tiny Model Precision"),
			description: tSettingsUi(
				"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.",
			),
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "memory",
			group: tSettingsUi("General"),
			label: tSettingsUi("Memory Model"),
			description: tSettingsUi(
				"Mnemopi LLM for fact extraction + consolidation: online (the TINY role from /models, else smol/remote) by default, or a local on-device model",
			),
			condition: "mnemopiActive",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
		ui: {
			tab: "model",
			group: tSettingsUi("Thinking"),
			label: tSettingsUi("Auto Thinking Model"),
			description: tSettingsUi(
				"Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model",
			),
			condition: "autoThinkingActive",
			options: AUTO_THINKING_MODEL_OPTIONS,
		},
	},
	"providers.autoThinkingMaxEffort": {
		type: "enum",
		values: ["xhigh", "max"] as const,
		default: "xhigh",
		ui: {
			tab: "model",
			group: "Thinking",
			label: "Auto Thinking Ceiling",
			description:
				"Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.",
			condition: "autoThinkingActive",
			options: [
				{ value: "xhigh", label: "xhigh", description: "Classifier stops at xhigh (default)" },
				{ value: "max", label: "max", description: "Classifier may resolve max where the model supports it" },
			],
		},
	},
	"features.unexpectedStopDetection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: tSettingsUi("Agent"),
			label: tSettingsUi("Detect unexpected stops"),
			description: tSettingsUi(
				"Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue.",
			),
		},
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "providers",
			group: tSettingsUi("Tiny Model"),
			label: tSettingsUi("Unexpected Stop Model"),
			description: tSettingsUi(
				"Classifier for unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.",
			),
			condition: "unexpectedStopDetection",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["auto", "openai", "anthropic"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Protocol"),
			label: tSettingsUi("Kimi API Format"),
			description: tSettingsUi("API format for Kimi Code provider (auto follows live model metadata)"),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Use the model's server-declared protocol"),
				},
				{ value: "openai", label: tSettingsUi("OpenAI"), description: tSettingsUi("api.kimi.com") },
				{ value: "anthropic", label: tSettingsUi("Anthropic"), description: tSettingsUi("api.moonshot.ai") },
			],
		},
	},

	"providers.codex.nativePrompt": {
		type: "enum",
		values: ["off", "shadow", "on"] as const,
		default: "off",
		ui: {
			tab: "providers",
			group: tSettingsUi("Protocol"),
			label: tSettingsUi("Codex Native Prompt"),
			description: tSettingsUi("Use the OpenAI Codex native-prompt sidecar when its trusted profile is eligible."),
			options: [
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Keep the generic system prompt only"),
				},
				{
					value: "shadow",
					label: tSettingsUi("Shadow"),
					description: tSettingsUi("Evaluate native-prompt eligibility without sending a native sidecar"),
				},
				{
					value: "on",
					label: tSettingsUi("On"),
					description: tSettingsUi(
						"Use a trusted native sidecar when eligible; otherwise use the generic system prompt",
					),
				},
			],
		},
	},
	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Protocol"),
			label: tSettingsUi("OpenAI WebSockets"),
			description: tSettingsUi(
				"Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Use model/provider default websocket behavior"),
				},
				{
					value: "off",
					label: tSettingsUi("Off"),
					description: tSettingsUi("Disable websockets for OpenAI Codex models"),
				},
				{
					value: "on",
					label: tSettingsUi("On"),
					description: tSettingsUi("Force websockets for OpenAI Codex models"),
				},
			],
		},
	},

	"providers.streamFirstEventTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: tSettingsUi("Timeouts"),
			label: tSettingsUi("Stream First Event Timeout"),
			description: tSettingsUi(
				"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
			),
			options: [
				{
					value: "-1",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Use provider defaults and PI_* timeout env vars"),
				},
				{ value: "0", label: tSettingsUi("Off"), description: tSettingsUi("Disable first-event timeout") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "600", label: tSettingsUi("10 minutes") },
				{ value: "1800", label: tSettingsUi("30 minutes") },
			],
		},
	},

	"providers.streamIdleTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: tSettingsUi("Timeouts"),
			label: tSettingsUi("Stream Idle Timeout"),
			description: tSettingsUi(
				"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
			),
			options: [
				{
					value: "-1",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Use provider defaults and PI_* timeout env vars"),
				},
				{ value: "0", label: tSettingsUi("Off"), description: tSettingsUi("Disable idle timeout") },
				{ value: "300", label: tSettingsUi("5 minutes") },
				{ value: "600", label: tSettingsUi("10 minutes") },
				{ value: "1800", label: tSettingsUi("30 minutes") },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			group: tSettingsUi("Protocol"),
			label: tSettingsUi("OpenRouter Routing"),
			description: tSettingsUi(
				"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
			),
			options: [
				{
					value: "default",
					label: tSettingsUi("Default"),
					description: tSettingsUi("No suffix; use OpenRouter's default routing"),
				},
				{
					value: "nitro",
					label: tSettingsUi(":nitro"),
					description: tSettingsUi("Prioritize throughput / lowest latency"),
				},
				{
					value: "floor",
					label: tSettingsUi(":floor"),
					description: tSettingsUi("Prioritize cheapest available provider"),
				},
				{
					value: "online",
					label: tSettingsUi(":online"),
					description: tSettingsUi("Enable OpenRouter's web-search plugin"),
				},
				{
					value: "exacto",
					label: tSettingsUi(":exacto"),
					description: tSettingsUi("Cherry-picked high-quality providers (only defined for select models)"),
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Fetch Provider"),
			description: tSettingsUi("Reader backend priority for the fetch/read URL tool"),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Priority: native > trafilatura > lynx > parallel > jina"),
				},
				{
					value: "native",
					label: tSettingsUi("Native"),
					description: tSettingsUi("In-process HTML→Markdown converter (always available)"),
				},
				{
					value: "trafilatura",
					label: tSettingsUi("Trafilatura"),
					description: tSettingsUi("Auto-installs via uv/pip"),
				},
				{ value: "lynx", label: tSettingsUi("Lynx"), description: tSettingsUi("Requires lynx system package") },
				{
					value: "parallel",
					label: tSettingsUi("Parallel"),
					description: tSettingsUi("Requires PARALLEL_API_KEY"),
				},
				{
					value: "jina",
					label: tSettingsUi("Jina"),
					description: tSettingsUi("Uses r.jina.ai reader (JINA_API_KEY optional)"),
				},
			],
		},
	},
	// Codex saved rate-limit resets (auto-redeem)
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Codex Auto-Redeem Saved Resets"),
			description: tSettingsUi(
				"Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.",
			),
			options: [
				{
					value: "unset",
					label: tSettingsUi("Unset"),
					description: tSettingsUi("Check eligibility, then ask before spending the first saved reset."),
				},
				{
					value: "yes",
					label: tSettingsUi("Yes"),
					description: tSettingsUi("Spend eligible saved resets without prompting."),
				},
				{
					value: "no",
					label: tSettingsUi("No"),
					description: tSettingsUi("Do not run the saved-reset auto-redeem check."),
				},
			],
		},
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Codex Auto-Redeem Min Block"),
			description: tSettingsUi(
				"Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.",
			),
		},
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Codex Auto-Redeem Reserve"),
			description: tSettingsUi(
				"Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.",
			),
		},
	},
	"codexResets.salvageHorizonHours": {
		type: "number",
		default: 12,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Codex Reset Salvage Horizon"),
			description: tSettingsUi(
				"Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).",
			),
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: tSettingsUi("Protocol"),
			label: tSettingsUi("Append-Only Context"),
			description: tSettingsUi(
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
			),
			options: [
				{
					value: "auto",
					label: tSettingsUi("Auto"),
					description: tSettingsUi("Enable for known prefix-cache providers (recommended)"),
				},
				{ value: "on", label: tSettingsUi("On"), description: tSettingsUi("Always enable append-only context") },
				{ value: "off", label: tSettingsUi("Off"), description: tSettingsUi("Disable append-only context") },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Exa"),
			description: tSettingsUi("Enable the Exa web search provider"),
		},
	},

	"exa.searchDelayMs": {
		type: "number",
		default: 1_000,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("Exa Search Delay"),
			description: tSettingsUi(
				"Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
			),
		},
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: tSettingsUi("Services"),
			label: tSettingsUi("SearXNG Endpoint"),
			description: tSettingsUi("Base URL of a self-hosted SearXNG instance used for web search"),
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.engines": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"searxng.safesearch": {
		type: "number",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"dev.autoqa": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Developer"),
			label: tSettingsUi("Auto QA"),
			description: tSettingsUi(
				"Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly",
			),
		},
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		default: "https://qa.omp.sh/v1/grievances" as const,
		ui: {
			tab: "tools",
			group: tSettingsUi("Developer"),
			label: tSettingsUi("Auto QA Push Endpoint"),
			description: tSettingsUi("Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)"),
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
	 * process-global consent handler registered by `InteractiveMode`.
	 *
	 * @default "unset"
	 */
	"dev.autoqaConsent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"gc.blobs": { type: "boolean", default: true },

	"gc.archive": { type: "boolean", default: true },

	"gc.wal": { type: "boolean", default: true },

	"gc.coldArchiveAfterDays": { type: "number", default: 30 },

	"gc.retainNewestGlobal": { type: "number", default: 20 },

	"gc.retainNewestPerCwd": { type: "number", default: 10 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 32768 },
	"workspaceCheckpoint.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Enable workspace checkpoints"),
			description: tSettingsUi(
				"Captures the working tree before each new user turn, before user-initiated bash, and before isolated-task merge, so any change can be rolled back via `undoWorkspace` or `applyWorkspaceRestore`.",
			),
		},
	},

	"workspaceCheckpoint.auto": {
		type: "enum",
		values: ["off", "turn"] as const,
		default: "turn",
		ui: {
			tab: "tools",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Auto-checkpoint mode"),
			description: tSettingsUi(
				"`off` disables automatic boundaries; `turn` captures a checkpoint before every top-level user turn.",
			),
		},
	},

	"workspaceCheckpoint.failurePolicy": {
		type: "enum",
		values: ["block", "warn", "ignore"] as const,
		default: "block",
		ui: {
			tab: "tools",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Failure policy"),
			description: tSettingsUi(
				"How the session reacts when an automatic workspace checkpoint fails: block the mutating turn, surface a warning and proceed, or silently continue.",
			),
		},
	},

	"workspaceCheckpoint.retention.maxPerSession": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Max checkpoints per session"),
			description: tSettingsUi(
				"Maximum workspace checkpoints retained per session before garbage collection prunes the oldest.",
			),
		},
	},

	"workspaceCheckpoint.retention.maxAgeDays": {
		type: "number",
		default: 30,
		ui: {
			tab: "files",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Max checkpoint age (days)"),
			description: tSettingsUi(
				"Drop workspace checkpoints older than this many days during garbage collection; set to 0 to skip age-based pruning.",
			),
		},
	},
	"workspaceCheckpoint.retention.maxTotalMiB": {
		type: "number",
		default: 2048,
		ui: {
			tab: "files",
			group: tSettingsUi("Workspace checkpoints"),
			label: tSettingsUi("Max total checkpoint storage (MiB)"),
			description: tSettingsUi(
				"Soft limit for physical checkpoint CAS storage across all workspaces. Garbage collection removes the oldest unprotected checkpoints automatically; protected restore history may keep usage above the limit. Set to 0 to disable the total limit.",
			),
			input: true,
			min: 0,
			integer: true,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Encrypted configuration sync (S3-compatible storage)
	// ────────────────────────────────────────────────────────────────────────
	"sync.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("Enable Configuration Sync"),
			description: tSettingsUi("Synchronize encrypted OMP configuration through S3-compatible storage."),
		},
	},
	"sync.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("S3 Endpoint"),
			description: tSettingsUi("Optional S3-compatible endpoint URL. Leave empty for AWS S3."),
		},
	},
	"sync.bucket": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("S3 Bucket"),
			description: tSettingsUi("Bucket that stores encrypted configuration revisions."),
		},
	},
	"sync.region": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("S3 Region"),
			description: tSettingsUi("Optional S3 region used by the storage client."),
		},
	},
	"sync.prefix": {
		type: "string",
		default: "omp-config",
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("Object Prefix"),
			description: tSettingsUi("S3 object-key prefix that isolates this configuration archive."),
		},
	},
	"sync.virtualHostedStyle": {
		type: "boolean",
		default: false,
		ui: {
			tab: "sync",
			group: tSettingsUi("S3 Storage"),
			label: tSettingsUi("Virtual-Hosted-Style URLs"),
			description: tSettingsUi("Address the bucket as a hostname instead of using path-style S3 URLs."),
		},
	},
	"sync.passphraseEnv": {
		type: "string",
		default: "OMP_CONFIG_SYNC_PASSPHRASE",
		ui: {
			tab: "sync",
			group: tSettingsUi("Credentials"),
			label: tSettingsUi("Fallback Passphrase Environment Variable"),
			description: tSettingsUi(
				"Fallback environment variable for older installations; the variable name is stored in config.yml, but its value is never stored or uploaded.",
			),
		},
	},
	"sync.accessKeyIdEnv": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("Credentials"),
			label: tSettingsUi("Access Key ID Environment Variable"),
			description: tSettingsUi("Optional environment variable containing the S3 access key ID."),
		},
	},
	"sync.secretAccessKeyEnv": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("Credentials"),
			label: tSettingsUi("Secret Access Key Environment Variable"),
			description: tSettingsUi("Optional environment variable containing the S3 secret access key."),
		},
	},
	"sync.sessionTokenEnv": {
		type: "string",
		default: undefined,
		ui: {
			tab: "sync",
			group: tSettingsUi("Credentials"),
			label: tSettingsUi("Session Token Environment Variable"),
			description: tSettingsUi("Optional environment variable containing a temporary S3 session token."),
		},
	},
	"sync.autoPush": {
		type: "boolean",
		default: false,
		ui: {
			tab: "sync",
			group: tSettingsUi("Automation"),
			label: tSettingsUi("Automatic Push"),
			description: tSettingsUi("Push configuration after successful global settings persistence."),
		},
	},
	// Reserved for the existing profile format. Retention policy is not exposed
	// until config-sync GC consumes these values.
	"sync.retention.revisions": { type: "number", default: undefined },
	"sync.retention.days": { type: "number", default: undefined },
	"sync.retention.inactiveWriterDays": { type: "number", default: undefined },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number"; default: undefined }
				? number | undefined
				: Schema[P] extends { type: "number" }
					? number
					: Schema[P] extends { type: "enum"; values: infer V }
						? V extends readonly string[]
							? V[number]
							: never
						: Schema[P] extends { type: "array"; default: infer D }
							? D
							: Schema[P] extends { type: "record"; default: infer D }
								? D
								: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/**
 * Whether a setting holds a credential and must never be printed or exported
 * without an explicit request. Drives both CLI redaction and settings-panel
 * masking, so the two cannot disagree.
 */
export function isCredential(path: SettingPath): boolean {
	const def = SETTINGS_SCHEMA[path];
	if ("credential" in def && def.credential === true) return true;
	// `ui.secret` predates this marker and still means "never display". Reading
	// both here keeps ONE accessor, so the two spellings cannot produce
	// different behaviour on different surfaces.
	return getUi(path)?.secret === true;
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

/** Personality preset - derived from schema */
export type Personality = SettingValue<"personality">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "context-full" | "handoff" | "shake" | "snapcompact" | "off";
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEnabled: boolean;
	remoteEndpoint: string | undefined;
	remoteStreamingV2Enabled: boolean;
	v2RetainedMessageBudget: number;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
}

export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

export interface TitleSettings {
	refreshOnReplan: boolean;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
	usageAwareFallback: boolean;
	usageReservePct: number;
	usageReservePolicy: "confirm" | "auto" | "fail-closed";
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	enableAgentsUser?: boolean;
	enableAgentsProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	searchDelayMs: number;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	streaming: boolean;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface WorkspaceCheckpointSettings {
	enabled: boolean;
	auto: "off" | "turn";
	failurePolicy: "block" | "warn" | "ignore";
	"retention.maxPerSession": number;
	"retention.maxAgeDays": number;
	"retention.maxTotalMiB": number;
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}
export type CodexAutoRedeemMode = "unset" | "yes" | "no";

export interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
	salvageHorizonHours: number;
}

export interface GcSettings {
	blobs: boolean;
	archive: boolean;
	wal: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
}

export interface SyncSettings {
	enabled: boolean;
	endpoint: string | undefined;
	bucket: string | undefined;
	region: string | undefined;
	prefix: string;
	virtualHostedStyle: boolean;
	passphraseEnv: string;
	accessKeyIdEnv: string | undefined;
	secretAccessKeyEnv: string | undefined;
	sessionTokenEnv: string | undefined;
	autoPush: boolean;
	"retention.revisions": number | undefined;
	"retention.days": number | undefined;
	"retention.inactiveWriterDays": number | undefined;
}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	recap: RecapSettings;
	title: TitleSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	gc: GcSettings;
	workspaceCheckpoint: WorkspaceCheckpointSettings;
	sync: SyncSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
