import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { selectPrompt } from "../prompts/prompt-locale";
import toolSearchDescription from "../prompts/tools/tool-search.md" with { type: "text" };
import toolSearchDescriptionZh from "../prompts/tools/tool-search.zh-CN.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { searchExternalTools } from "./tool-search-index";
import { externalXdevToolCatalog } from "./xdev";

const DEFAULT_MATCH_LIMIT = 5;
const MAX_MATCH_LIMIT = 8;

const toolSearchSchema = type({
	"query?": type("string").describe(
		"natural-language capability query; highest-ranked hidden external schemas are enabled",
	),
	"names?": type("string[]").describe("exact external tool names to enable"),
	"limit?": type("1 <= number <= 8").describe("maximum query matches to enable; defaults to 5"),
});

export type ToolSearchToolInput = typeof toolSearchSchema.infer;

export interface ToolSearchToolDetails {
	query?: string;
	matched: string[];
	enabled: string[];
	alreadyActive: string[];
	unknown: string[];
	availableCount: number;
	meta?: OutputMeta;
}

/** Searches and promotes schema-hidden external tools into the next request's top-level tool set. */
export class ToolSearchTool implements AgentTool<typeof toolSearchSchema, ToolSearchToolDetails> {
	readonly name = "tool_search";
	readonly label = "Tool Search";
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly concurrency = "exclusive" as const;
	readonly parameters = toolSearchSchema;
	readonly strict = true;
	readonly summary = "Search and enable external tools by capability or exact name";

	constructor(readonly session: ToolSession) {}

	get description(): string {
		const catalog = this.session.xdev ? externalXdevToolCatalog(this.session.xdev) : [];
		return prompt.render(selectPrompt(toolSearchDescription, toolSearchDescriptionZh), {
			activeCount: catalog.filter(entry => entry.active).length,
			availableCount: catalog.filter(entry => !entry.active).length,
		});
	}

	async execute(
		_toolCallId: string,
		params: ToolSearchToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ToolSearchToolDetails>> {
		const query = params.query?.trim();
		const names = params.names ?? [];
		if (!query && names.length === 0) {
			throw new ToolError("Provide a capability query or at least one exact external tool name.");
		}

		const catalog = this.session.xdev ? externalXdevToolCatalog(this.session.xdev) : [];
		const available = catalog.filter(entry => !entry.active);
		const limit = Math.min(MAX_MATCH_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_MATCH_LIMIT)));
		const matches = query ? searchExternalTools(available, query, limit) : [];
		const matched = matches.map(match => match.entry.name);
		const byName = new Map(catalog.map(entry => [entry.name, entry]));
		const enabled: string[] = [];
		const alreadyActive: string[] = [];
		const unknown: string[] = [];
		const seen = new Set<string>();

		for (const name of [...names, ...matched]) {
			if (seen.has(name)) continue;
			seen.add(name);
			const entry = byName.get(name);
			if (!entry) unknown.push(name);
			else if (entry.active) alreadyActive.push(name);
			else enabled.push(name);
		}

		if (enabled.length > 0) {
			if (!this.session.promoteExternalTools) {
				throw new ToolError("External tool activation is unavailable in this session.");
			}
			await this.session.promoteExternalTools(enabled, signal);
		}

		const lines: string[] = [];
		if (query && matched.length > 0) lines.push(`Matched "${query}": ${matched.join(", ")}`);
		else if (query) lines.push(`No hidden external tools matched "${query}".`);
		if (enabled.length > 0) lines.push(`Enabled for the next response: ${enabled.join(", ")}`);
		if (alreadyActive.length > 0) lines.push(`Already active: ${alreadyActive.join(", ")}`);
		if (unknown.length > 0) lines.push(`Unknown, built-in, or unavailable: ${unknown.join(", ")}`);
		if (lines.length === 0) lines.push("Nothing changed.");

		return toolResult<ToolSearchToolDetails>({
			query,
			matched,
			enabled,
			alreadyActive,
			unknown,
			availableCount: available.length,
		})
			.text(lines.join("\n"))
			.done();
	}
}
