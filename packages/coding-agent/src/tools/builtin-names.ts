export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"github",
	"siyuan",
	"find",
	"grep",
	"multi_grep",
	"lsp",
	"inspect_image",
	"browser",
	"computer",
	"checkpoint",
	"rewind",
	"security_scan",
	"task",
	"hub",
	"todo",
	"web_search",
	"tool_search",
	"codegraph",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
	"next_step_offer",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** Hidden built-ins: constructible and `--tools`-addressable, but never part of the default active set. */
export const HIDDEN_TOOL_NAMES = ["yield", "goal", "refine", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

/** Normalize built-in tool IDs for case-insensitive configuration surfaces. */
export function normalizeToolName(name: string): string {
	return name.toLowerCase();
}

/**
 * Match a tool-name glob pattern against a concrete tool name.
 *
 * Supports the same `*` (any run of characters) and `?` (exactly one
 * character) wildcards as OpenCode's permission patterns, so an agent's
 * `tools:` list can address a whole MCP server at once — e.g.
 * `mcp__codegraph_*` matches every tool of the `codegraph` server while
 * `mcp__*` matches every inherited MCP tool. Exact names continue to match
 * literally, and patterns are anchored (a partial pattern never matches).
 */
export function matchesToolNamePattern(pattern: string, name: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) return pattern === name;
	let regex = "";
	for (const ch of pattern) {
		if (ch === "*") {
			regex += ".*";
		} else if (ch === "?") {
			regex += ".";
		} else {
			regex += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
		}
	}
	return new RegExp(`^${regex}$`).test(name);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
