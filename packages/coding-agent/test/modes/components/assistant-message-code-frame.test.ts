import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import {
	theme as activeTheme,
	getThemeByName,
	initTheme,
	setThemeInstance,
	type Theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const WIDTH = 80;
const FOREGROUND_SGR = /\x1b\[(?:3[0-7]|38;(?:5;\d+|2;\d+;\d+;\d+))m/g;
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]|10[0-7]|48;(?:5;\d+|2;\d+;\d+;\d+))m/;

let uiTheme: Theme;
let previousTheme: Theme | undefined;

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

function expectNoRoundedFrameGlyphs(text: string): void {
	for (const glyph of [
		uiTheme.symbol("boxRound.topLeft"),
		uiTheme.symbol("boxRound.topRight"),
		uiTheme.symbol("boxRound.bottomLeft"),
		uiTheme.symbol("boxRound.bottomRight"),
		uiTheme.symbol("boxRound.vertical"),
	]) {
		expect(text).not.toContain(glyph);
	}
	expect(text).not.toContain(uiTheme.symbol("boxRound.horizontal"));
}

type ExpandableAssistantMessageComponent = AssistantMessageComponent & { setExpanded(expanded: boolean): void };

beforeAll(async () => {
	await initTheme(false);
	previousTheme = activeTheme;
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	uiTheme = loaded;
	setThemeInstance(uiTheme);
});

afterAll(() => {
	if (previousTheme) setThemeInstance(previousTheme);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("AssistantMessageComponent code-block framing", () => {
	it("renders full-border code blocks as rounded frames without raw fences", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("full");
			const component = new AssistantMessageComponent(
				message([{ type: "text", text: fence(["const answer = 42;"]) }]),
			);
			const lines = renderPlain(component, 36);
			const joined = lines.join("\n");

			expect(joined).not.toContain("```");
			expect(joined).toContain("const answer = 42;");
			expect(lines[0]).toContain("╭");
			expect(lines.some(line => line.includes("│") && line.includes("const answer = 42;"))).toBe(true);
			expect(lines[lines.length - 1]).toContain("╰");
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("renders none-style fenced code as plain content without raw fences, labels, frames, or backgrounds", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("none");
			const width = 36;
			const source = [
				"before",
				"",
				fence(["const answer = 42;", "console.log(answer);"]),
				"",
				fence(["plain color", "verbatim marker"], "text"),
				"",
				"after",
			].join("\n");
			const component = new AssistantMessageComponent(message([{ type: "text", text: source }]));
			const raw = component.render(width);
			const plain = raw.map(line => Bun.stripANSI(line).trimEnd());
			const joinedPlain = plain.join("\n");
			const codeRows = raw.filter(line => {
				const stripped = Bun.stripANSI(line);
				return (
					stripped.includes("const answer = 42;") ||
					stripped.includes("console.log(answer);") ||
					stripped.includes("plain color") ||
					stripped.includes("verbatim marker")
				);
			});

			expect(joinedPlain).toContain("before");
			expect(joinedPlain).toContain("const answer = 42;");
			expect(joinedPlain).toContain("console.log(answer);");
			expect(joinedPlain).toContain("plain color");
			expect(joinedPlain).toContain("verbatim marker");
			expect(joinedPlain).toContain("after");
			expect(joinedPlain).not.toContain("```");
			expect(joinedPlain).not.toContain("text");
			expectNoRoundedFrameGlyphs(joinedPlain);
			expect(codeRows).toHaveLength(4);
			expect(codeRows.every(line => visibleWidth(line) === width)).toBe(true);
			expect(codeRows.every(line => !BACKGROUND_SGR.test(line))).toBe(true);
			const foregrounds = new Set(codeRows.flatMap(line => line.match(FOREGROUND_SGR) ?? []));
			expect(foregrounds.size).toBeGreaterThan(0);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("keeps none-style long text fences collapsible without reintroducing raw fences", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("none");
			const component = new AssistantMessageComponent(
				message([{ type: "text", text: fence(numberedRows(30), "text") }]),
			);

			const collapsed = renderPlain(component).join("\n");
			expect(collapsed).toContain("row-01");
			expect(collapsed).toContain("row-30");
			expect(collapsed).not.toContain("row-15");
			expect(collapsed).not.toContain("```");
			expect(collapsed).not.toContain("text");
			expectNoRoundedFrameGlyphs(collapsed);

			(component as ExpandableAssistantMessageComponent).setExpanded(true);
			const expanded = renderPlain(component).join("\n");
			expect(expanded).toContain("row-15");
			expect(expanded).toContain("row-30");
			expect(expanded).not.toContain("more lines");
			expect(expanded).not.toContain("```");
			expect(expanded).not.toContain("text");
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("renders accent YAML fences as padded syntax-highlighted code rows without raw fence chrome or backgrounds", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("accent");
			const component = new AssistantMessageComponent(
				message([
					{
						type: "text",
						text: [
							"prose before",
							"",
							fence(['name: "agent"', "enabled: true", "count: 2"], "yaml"),
							"",
							"prose after",
						].join("\n"),
					},
				]),
			);
			const width = 44;
			const raw = component.render(width);
			const plain = raw.map(line => Bun.stripANSI(line).trimEnd());
			const joinedPlain = plain.join("\n");
			const codeRows = raw.filter(line => {
				const stripped = Bun.stripANSI(line);
				return stripped.includes("name:") || stripped.includes("enabled:") || stripped.includes("count:");
			});
			const proseColumn = plain.find(line => line.includes("prose before"))?.indexOf("prose before");
			const codeColumns = codeRows.map(line => {
				const stripped = Bun.stripANSI(line);
				return Math.max(stripped.indexOf("name:"), stripped.indexOf("enabled:"), stripped.indexOf("count:"));
			});

			expect(joinedPlain).toContain('name: "agent"');
			expect(joinedPlain).toContain("enabled: true");
			expect(joinedPlain).not.toContain("```");
			expect(joinedPlain).not.toContain("yaml");
			expectNoRoundedFrameGlyphs(joinedPlain);
			expect(codeRows).toHaveLength(3);
			expect(codeRows.every(line => visibleWidth(line) === width)).toBe(true);
			expect(codeRows.every(line => !BACKGROUND_SGR.test(line))).toBe(true);
			expect(proseColumn).toBe(1);
			expect(codeColumns).toEqual([1, 1, 1]);
			const foregrounds = new Set(codeRows.flatMap(line => line.match(FOREGROUND_SGR) ?? []));
			expect(foregrounds.size).toBeGreaterThanOrEqual(2);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("wraps long accent text fences without truncating the tail marker or emitting background SGR", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();

		try {
			setOutputBlockBorderStyle("accent");
			const firstLine = "plain color";
			const tail = "TAIL_UNIQUE_MARKER";
			const longLine = `${"abc123".repeat(13)}${tail}`;
			const width = 28;
			const component = new AssistantMessageComponent(
				message([{ type: "text", text: fence([firstLine, longLine], "text") }]),
			);
			const raw = component.render(width);
			const plain = raw.map(line => Bun.stripANSI(line).trimEnd());
			const codeRows = raw.filter(line => Bun.stripANSI(line).trim().length > 0);
			const joinedPlain = plain.join("\n");
			const firstCodeRow = codeRows.find(line => Bun.stripANSI(line).includes(firstLine));

			expect(joinedPlain).not.toContain("```");
			expect(joinedPlain).not.toContain("text");
			expect(codeRows.length).toBeGreaterThan(2);
			expect(codeRows.every(line => visibleWidth(line) === width)).toBe(true);
			expect(codeRows.every(line => !BACKGROUND_SGR.test(line))).toBe(true);
			expect(firstCodeRow).toBeDefined();
			expect(firstCodeRow!).toContain(activeTheme.fg("mdCodeBlock", firstLine));
			expect(codeRows.map(line => Bun.stripANSI(line).trim()).join("")).toContain(tail);
			expect(joinedPlain.split(tail)).toHaveLength(2);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
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
