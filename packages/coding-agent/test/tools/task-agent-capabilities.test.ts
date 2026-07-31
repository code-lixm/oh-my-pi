import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { clearBundledAgentsCache, loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { getPromptLocale, setPromptLocale } from "../../src/prompts/prompt-locale";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}
function loadBundledAgentsForLocale(locale: "en" | "zh-CN"): AgentDefinition[] {
	setPromptLocale(locale);
	clearBundledAgentsCache();
	return loadBundledAgents();
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("registers the localized security reviewer with its restricted review tools", () => {
		const previousPromptLocale = getPromptLocale();
		try {
			const english = agentByName(loadBundledAgentsForLocale("en"), "security-reviewer");
			const chinese = agentByName(loadBundledAgentsForLocale("zh-CN"), "security-reviewer");

			expect(english.systemPrompt).toContain("Review only the assigned repository scope.");
			expect(chinese.systemPrompt).toContain("仅审查分配给你的仓库范围。");
			expect(chinese.systemPrompt).not.toContain("Review only the assigned repository scope.");
			expect(chinese.tools).toEqual(["read", "grep", "glob", "lsp", "ast_grep", "yield"]);
		} finally {
			setPromptLocale(previousPromptLocale);
			clearBundledAgentsCache();
		}
	});

	it("disables read summarization for scout and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of ["task", "scout", "sonic", "reviewer", "designer", "librarian"]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});
