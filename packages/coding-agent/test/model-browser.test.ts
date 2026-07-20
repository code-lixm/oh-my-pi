import { beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildBrowserItems,
	formatRoleChip,
	formatRoleDisplayLabel,
	ModelBrowser,
	type RoleAssignment,
	sortModelItems,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

/** Browser preloaded with `models`, MRU-sorted like the hub does on sync. */
function makeBrowser(models: Model[], mruOrder: string[]): ModelBrowser {
	const browser = new ModelBrowser(Settings.isolated({}));
	const items = buildBrowserItems(models);
	sortModelItems(items, { mruOrder });
	browser.setMruOrder(mruOrder);
	browser.setItems(items);
	return browser;
}

describe("ModelBrowser search ranking", () => {
	test("an exact query match outranks the MRU model", () => {
		// Regression: with gpt-5.6-sol as the active (MRU) model, typing
		// "gpt-5.5" must select gpt-5.5, not keep the MRU pinned on top.
		const browser = makeBrowser(
			[
				makeModel("openai-codex", "gpt-5.6-sol"),
				makeModel("openai-codex", "gpt-5.6-luna"),
				makeModel("openai-codex", "gpt-5.5"),
				makeModel("openai-codex", "gpt-5.4"),
			],
			["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
		);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("openai-codex/gpt-5.5");
	});

	test("MRU breaks ties between equally good matches", () => {
		// Same model id under two providers: match quality is identical, so
		// the recently used provider must win over alphabetical order.
		const browser = makeBrowser([makeModel("g0i", "gpt-5.5"), makeModel("zenmux", "gpt-5.5")], ["zenmux/gpt-5.5"]);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("zenmux/gpt-5.5");
	});
});

describe("formatRoleDisplayLabel localization", () => {
	test("returns compact built-in role tags in English", () => {
		const previousLocale = getSettingsUiLocale();
		try {
			const settings = Settings.isolated({ displayLanguage: "en" });
			const labels = Object.fromEntries(MODEL_ROLE_IDS.map(role => [role, formatRoleDisplayLabel(role, settings)]));

			expect(labels).toEqual({
				default: "DEFAULT",
				smol: "SMOL",
				slow: "SLOW",
				vision: "VISION",
				plan: "PLAN",
				designer: "DESIGNER",
				commit: "COMMIT",
				tiny: "TINY",
				task: "TASK",
				advisor: "ADVISOR",
			});
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});

	test("returns localized built-in role names in zh-CN", () => {
		const previousLocale = getSettingsUiLocale();
		try {
			const settings = Settings.isolated({ displayLanguage: "zh-CN" });
			const labels = Object.fromEntries(MODEL_ROLE_IDS.map(role => [role, formatRoleDisplayLabel(role, settings)]));

			expect(labels).toEqual({
				default: "默认",
				smol: "轻量",
				slow: "深度思考",
				vision: "视觉",
				plan: "规划",
				designer: "设计",
				commit: "提交",
				tiny: "微型",
				task: "子任务",
				advisor: "审阅助手",
			});
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});

	test("keeps configured custom role names in zh-CN when no translation exists", () => {
		const previousLocale = getSettingsUiLocale();
		try {
			const settings = Settings.isolated({
				displayLanguage: "zh-CN",
				modelTags: {
					reviewer: { name: "代码审查员" },
				},
			});

			expect(formatRoleDisplayLabel("reviewer", settings)).toBe("代码审查员");
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});
});

describe("ModelBrowser perf display", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton.
		await initTheme(false);
	});

	function makePerfBrowser(): ModelBrowser {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));
		return browser;
	}

	function renderPlain(browser: ModelBrowser, width: number): string[] {
		return browser.render(width).map(line => Bun.stripANSI(line));
	}

	test("row perf column scales with width: off, TPS-only, TTFT+TPS", () => {
		const browser = makePerfBrowser();

		expect(renderPlain(browser, 70)[2]).not.toContain("t/s");
		expect(renderPlain(browser, 80)[2]).toContain("118t/s");
		const wideRow = renderPlain(browser, 120)[2];
		expect(wideRow).toContain("0.9s 118t/s");
	});

	test("detail line shows measured perf regardless of width", () => {
		const browser = makePerfBrowser();

		const lines = renderPlain(browser, 70);
		expect(lines[lines.length - 2]).toContain("~118t/s · 0.9s ttft");
	});

	test("models without measurements render no perf cell", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));

		expect(renderPlain(browser, 120)[2]).not.toContain("t/s");
	});
});

describe("formatRoleChip glyph-label spacing (zh-CN regression)", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	function strip(text: string): string {
		return Bun.stripANSI(text);
	}

	function assignment(model: Model, auto: boolean): RoleAssignment {
		return { model, thinkingLevel: "inherit", autoSelected: auto };
	}

	/**
	 * Core regression: formatRoleChip must separate the status glyph (●/○) from the
	 * label text with exactly one ASCII space.  The old buggy output "●默认" / "○设计师"
	 * had zero-width gap; the fixed output is "● 默认" / "○ 设计师".
	 *
	 * zh-CN labels are read dynamically so the test survives translation changes.
	 */

	test("configured zh-CN chip: one ASCII space between status glyph and label", () => {
		const prev = getSettingsUiLocale();
		try {
			setSettingsUiLocale("zh-CN");
			const settings = Settings.isolated({ displayLanguage: "zh-CN" });
			const model = makeModel("test", "m-zh");
			const out = strip(formatRoleChip("designer", assignment(model, false), settings));
			expect(out).toContain("● 设计");
			expect(out).not.toContain("●设计");
		} finally {
			setSettingsUiLocale(prev);
		}
	});

	test("auto-selected zh-CN chip: one ASCII space between status glyph and label", () => {
		const prev = getSettingsUiLocale();
		try {
			setSettingsUiLocale("zh-CN");
			const settings = Settings.isolated({ displayLanguage: "zh-CN" });
			const model = makeModel("test", "m-zh");
			const out = strip(formatRoleChip("designer", assignment(model, true), settings));
			expect(out).toContain("○ 设计");
			expect(out).not.toContain("○设计");
		} finally {
			setSettingsUiLocale(prev);
		}
	});
});
