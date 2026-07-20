import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { askToolRenderer } from "../../src/tools/ask";

const initialSettingsUiLocale = getSettingsUiLocale();

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false);
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	uiTheme = theme!;
});

afterEach(() => {
	setSettingsUiLocale(initialSettingsUiLocale);
});

function renderCall(args: Parameters<typeof askToolRenderer.renderCall>[0]): string {
	return stripVTControlCharacters(
		askToolRenderer.renderCall(args, { expanded: true, isPartial: false }, uiTheme).render(120).join("\n"),
	);
}

function renderResult(result: Parameters<typeof askToolRenderer.renderResult>[0]): string {
	return stripVTControlCharacters(
		askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme).render(120).join("\n"),
	);
}

describe("askToolRenderer locale switching", () => {
	it("switches ask chrome to zh-CN at runtime while preserving literal user-provided labels", () => {
		const args: Parameters<typeof askToolRenderer.renderCall>[0] = {
			question: "Choose the literal protocol/status tokens to keep.",
			options: [
				{
					label: "GET",
					description: "HTTP method value from the user payload.",
				},
				{
					label: "Cancelled",
					description: "Literal status string from the upstream protocol.",
				},
			],
			multi: true,
		};

		setSettingsUiLocale("en");
		const english = renderCall(args);
		expect(english).toContain("Ask");
		expect(english).toContain("multi");
		expect(english).toContain("options:2");
		expect(english).toContain("GET");
		expect(english).toContain("Cancelled");
		expect(english).toContain("HTTP method value from the user payload.");
		expect(english).toContain("Literal status string from the upstream protocol.");
		expect(english).not.toContain("询问");
		expect(english).not.toContain("多项");
		expect(english).not.toContain("选项：2");

		setSettingsUiLocale("zh-CN");
		const chinese = renderCall(args);
		expect(chinese).toContain("询问");
		expect(chinese).toContain("多项");
		expect(chinese).toContain("选项：2");
		expect(chinese).not.toContain("Ask");
		expect(chinese).not.toContain("multi");
		expect(chinese).not.toContain("options:2");
		expect(chinese).toContain("GET");
		expect(chinese).toContain("Cancelled");
		expect(chinese).toContain("HTTP method value from the user payload.");
		expect(chinese).toContain("Literal status string from the upstream protocol.");
		expect(chinese).not.toContain("已取消");
		expect(chinese).not.toBe(english);
	});

	it("switches result chrome to zh-CN at runtime while preserving selected literal values", () => {
		const result: Parameters<typeof askToolRenderer.renderResult>[0] = {
			content: [{ type: "text", text: "" }],
			details: {
				question: "Which upstream status should stay literal?",
				multi: false,
				options: ["GET", "Cancelled"],
				selectedOptions: ["Cancelled"],
			},
		};

		setSettingsUiLocale("en");
		const english = renderResult(result);
		expect(english).toContain("Ask");
		expect(english).toContain("Which upstream status should stay literal?");
		expect(english).toContain("GET");
		expect(english).toContain("Cancelled");
		expect(english).not.toContain("询问");

		setSettingsUiLocale("zh-CN");
		const chinese = renderResult(result);
		expect(chinese).toContain("询问");
		expect(chinese).not.toContain("Ask");
		expect(chinese).toContain("Which upstream status should stay literal?");
		expect(chinese).toContain("GET");
		expect(chinese).toContain("Cancelled");
		expect(chinese).not.toContain("已取消");
		expect(chinese).not.toBe(english);
	});
});
