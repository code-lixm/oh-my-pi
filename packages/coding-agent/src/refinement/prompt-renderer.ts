import { prompt as promptRenderer } from "@oh-my-pi/pi-utils";
import type { PromptContribution } from "../prime-integration/contracts";
import { selectPrompt } from "../prompts/prompt-locale";
import harnessStatePrompt from "../prompts/refinement/harness-state.md" with { type: "text" };
import harnessStatePromptZh from "../prompts/refinement/harness-state.zh-CN.md" with { type: "text" };
import type { HarnessState, RefinementKind } from "./types";

const MAX_ENTRIES_PER_KIND = 6;
const MAX_ENTRY_CHARS = 180;

interface RenderedEntry {
	id: string;
	scope: "local" | "global";
	title: string;
	content: string;
}

interface RenderedRefinement {
	summary: string;
	scope: string;
	timestamp: string;
}

interface HarnessRenderData {
	[key: string]: unknown;
	memoryEntries: RenderedEntry[];
	promptEntries: RenderedEntry[];
	skillEntries: RenderedEntry[];
	subagentEntries: RenderedEntry[];
	recentRefinements: RenderedRefinement[];
}

function truncateEntry(text: string): string {
	return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS - 3)}...` : text;
}

function extractEntries(state: HarnessState, kind: RefinementKind): RenderedEntry[] {
	const entries = Object.values(state.entries[kind] ?? {});
	return entries.slice(0, MAX_ENTRIES_PER_KIND).map(entry => ({
		id: entry.id,
		scope: entry.scope === "global" ? "global" : "local",
		title: entry.title,
		content: truncateEntry(entry.content),
	}));
}

export function formatHarnessStateForPrompt(state: HarnessState | undefined): string | undefined {
	if (!state) return undefined;
	const hasEntries = (Object.keys(state.entries) as RefinementKind[]).some(
		kind => Object.keys(state.entries[kind] ?? {}).length > 0,
	);
	if (!hasEntries && state.refinements.length === 0) return undefined;

	const data: HarnessRenderData = {
		memoryEntries: extractEntries(state, "memory"),
		promptEntries: extractEntries(state, "prompt"),
		skillEntries: extractEntries(state, "skill"),
		subagentEntries: extractEntries(state, "subagent"),
		recentRefinements: state.refinements.slice(-5).map(r => ({
			summary: r.summary,
			scope: r.scope,
			timestamp: new Date(r.timestamp).toISOString(),
		})),
	};

	const template = selectPrompt(harnessStatePrompt, harnessStatePromptZh);
	return promptRenderer.render(template, data);
}

export const refinementPromptContribution: PromptContribution = {
	id: "refinement-harness",
	render(context: { harnessState?: HarnessState; pythonSkillMetadata?: unknown }): string | undefined {
		return formatHarnessStateForPrompt(context.harnessState);
	},
};
