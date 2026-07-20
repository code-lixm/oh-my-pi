import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const WIDTH = 80;

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function fence(lines: readonly string[], lang = "ts"): string {
	return [`\`\`\`${lang}`, ...lines, "```"].join("\n");
}

function numberedRows(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`);
}

function renderPlain(component: AssistantMessageComponent, width: number = WIDTH): string[] {
	return Bun.stripANSI(component.render(width).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

type ExpandableAssistantMessageComponent = AssistantMessageComponent & { setExpanded(expanded: boolean): void };

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("AssistantMessageComponent code-block framing", () => {
	it("opts assistant markdown into framed code blocks instead of raw fences", () => {
		const component = new AssistantMessageComponent(message([{ type: "text", text: fence(["const answer = 42;"]) }]));
		const lines = renderPlain(component, 36);
		const joined = lines.join("\n");

		expect(joined).not.toContain("```");
		expect(lines[0]).toContain("ts");
		expect(lines[0]).toContain("╭");
		expect(lines[1]).toContain("│");
		expect(lines[1]).toContain("const answer = 42;");
		expect(lines[lines.length - 1]).toContain("╰");
	});

	it("still expands code blocks when a toolCall disables the streaming fast path", () => {
		const component = new AssistantMessageComponent(
			message([
				{ type: "text", text: fence(numberedRows(30)) },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/file.ts" } },
			]),
		);

		const collapsed = renderPlain(component).join("\n");
		expect(collapsed).toContain("row-01");
		expect(collapsed).toContain("row-30");
		expect(collapsed).not.toContain("row-15");
		expect(collapsed).not.toContain("```");

		(component as ExpandableAssistantMessageComponent).setExpanded(true);
		const expanded = renderPlain(component).join("\n");
		expect(expanded).toContain("row-15");
		expect(expanded).toContain("row-30");
		expect(expanded).not.toContain("more lines");
		expect(expanded).not.toContain("```");
	});
});
