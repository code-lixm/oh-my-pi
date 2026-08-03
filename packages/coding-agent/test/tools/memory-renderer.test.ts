import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	recallToolRenderer,
	reflectToolRenderer,
	retainToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/memory-render";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

const localizedOperationLabels = ["保留", "回忆", "反思"];

function expectMemoryHeader(rendered: string[], operation: "retain" | "recall" | "reflect") {
	expect(rendered[0]).toContain(`Memory: ${operation}`);
	const text = rendered.join("\n");
	for (const label of localizedOperationLabels) expect(text).not.toContain(label);
}

describe("Memory renderer identity", () => {
	it("keeps the English Memory title and lowercase operation description in zh-CN", async () => {
		const initialLocale = getSettingsUiLocale();
		setSettingsUiLocale("zh-CN");
		try {
			const uiTheme = await theme();
			const cases = [
				{
					operation: "retain" as const,
					renderCall: () =>
						lines(
							retainToolRenderer.renderCall(
								{ items: [{ content: "memory to retain" }] },
								{ expanded: false, isPartial: true },
								uiTheme,
							),
						),
					renderResult: () =>
						lines(
							retainToolRenderer.renderResult(
								{ content: [{ type: "text", text: "1 memory stored." }] } as never,
								{ expanded: false, isPartial: false },
								uiTheme,
								{ items: [{ content: "memory to retain" }] },
							),
						),
				},
				{
					operation: "recall" as const,
					renderCall: () =>
						lines(
							recallToolRenderer.renderCall(
								{ query: "find memory" },
								{ expanded: false, isPartial: true },
								uiTheme,
							),
						),
					renderResult: () =>
						lines(
							recallToolRenderer.renderResult(
								{ content: [{ type: "text", text: "Found 1 relevant memory:\n\n- remembered fact" }] } as never,
								{ expanded: false, isPartial: false },
								uiTheme,
								{ query: "find memory" },
							),
						),
				},
				{
					operation: "reflect" as const,
					renderCall: () =>
						lines(
							reflectToolRenderer.renderCall(
								{ query: "summarize memory" },
								{ expanded: false, isPartial: true },
								uiTheme,
							),
						),
					renderResult: () =>
						lines(
							reflectToolRenderer.renderResult(
								{ content: [{ type: "text", text: "remembered fact" }] } as never,
								{ expanded: false, isPartial: false },
								uiTheme,
								{ query: "summarize memory" },
							),
						),
				},
			] as const;

			for (const { operation, renderCall, renderResult } of cases) {
				expectMemoryHeader(renderCall(), operation);
				expectMemoryHeader(renderResult(), operation);
			}
		} finally {
			setSettingsUiLocale(initialLocale);
		}
	});

	it("declares a bare transcript surface for every Memory operation", () => {
		for (const renderer of [retainToolRenderer, recallToolRenderer, reflectToolRenderer]) {
			const surface = "transcriptSurface" in renderer ? renderer.transcriptSurface : undefined;
			expect(surface).toBe("bare");
		}
	});
});

describe("retainToolRenderer", () => {
	const args = {
		items: [
			{ content: "First fact to remember", context: "ctx-a" },
			{ content: "Second fact to remember", context: "ctx-b" },
			{ content: "Third fact to remember" },
			{ content: "Fourth fact to remember" },
			{ content: "Fifth fact to remember" },
			{ content: "Sixth fact to remember" },
			{ content: "Seventh fact to remember" },
			{ content: "Eighth fact to remember" },
			{ content: "Ninth fact to remember" },
		],
	};

	it("renders collapsed retained memories as root tree rows with a trailing summary", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "9 memories stored." }], details: { count: 9 } };
		const rendered = lines(
			retainToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, args),
		);
		const body = rendered.slice(1);

		expect(rendered[0]).toContain("9 memories stored");
		expect(body).toHaveLength(9);
		for (const line of body.slice(0, 8)) expect(line).toStartWith("├─ ");
		expect(body[8]).toMatch(/^└─ … 1 more retained item\b/u);
		expect(body[0]).toContain("First fact to remember");
		expect(body[7]).toContain("Eighth fact to remember");
		expect(body.some(line => line.includes("Ninth fact to remember"))).toBe(false);
		expect(body.some(line => line.startsWith(`  ${uiTheme.format.bullet} `))).toBe(false);
		// No raw JSON arg tree leaks into the output.
		expect(rendered.some(line => line.includes("context") || line.includes("[0]"))).toBe(false);
	});

	it("truncates long memory content to one line", async () => {
		const uiTheme = await theme();
		const long = "x".repeat(400);
		const result = { content: [{ type: "text", text: "1 memory stored." }], details: { count: 1 } };
		const rendered = lines(
			retainToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				items: [{ content: long }],
			}),
			80,
		);
		const item = rendered.find(line => /^(?:├─|└─) /u.test(line));
		expect(item!.length).toBeLessThanOrEqual(80);
		expect(item).toContain("…");
	});

	it("shows pending collapsed tree rows while the call streams", async () => {
		const uiTheme = await theme();
		const rendered = lines(retainToolRenderer.renderCall(args, { expanded: false, isPartial: true }, uiTheme));
		const body = rendered.slice(1);

		expect(body).toHaveLength(9);
		expect(body.slice(0, 8).every(line => line.startsWith("├─ "))).toBe(true);
		expect(body[8]).toMatch(/^└─ … 1 more retained item\b/u);
		expect(body[7]).toContain("Eighth fact to remember");
		expect(body.some(line => line.includes("Ninth fact to remember"))).toBe(false);
	});

	it("ignores transient non-array items while the call streams", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			retainToolRenderer.renderCall({ items: "[" }, { expanded: false, isPartial: true }, uiTheme),
		);

		expect(rendered.some(line => /^(?:├─|└─) /u.test(line))).toBe(false);
	});
});

describe("recallToolRenderer", () => {
	it("summarizes the match count and hides memories until expanded", async () => {
		const uiTheme = await theme();
		const result = {
			content: [
				{
					type: "text",
					text: "Found 2 relevant memories (as of 2026-05-30 UTC):\n\n- alpha memory\n- beta memory",
				},
			],
		};
		const collapsed = lines(
			recallToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				query: "find stuff",
			}),
		);
		expect(collapsed[0]).toContain("find stuff");
		expect(collapsed[0]).toContain("2 found");
		expect(collapsed.some(line => line.includes("alpha memory"))).toBe(false);

		const expanded = lines(
			recallToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				query: "find stuff",
			}),
		);
		expect(expanded.some(line => line.includes("alpha memory"))).toBe(true);
		expect(expanded.some(line => line.includes("beta memory"))).toBe(true);
	});

	it("flags an empty recall as a single warning line", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "No relevant memories found." }] };
		const rendered = lines(
			recallToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				query: "q",
			}),
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("no matches");
	});
});

describe("reflectToolRenderer", () => {
	it("renders the synthesized answer under a concise header", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "Line one.\nLine two.\nLine three." }] };
		const rendered = lines(
			reflectToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				query: "what do you know",
			}),
		);
		expect(rendered[0]).toContain("what do you know");
		expect(rendered.some(line => line.includes("Line one."))).toBe(true);
		expect(rendered.some(line => line.includes("Line three."))).toBe(true);
	});
});
