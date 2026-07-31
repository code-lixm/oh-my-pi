import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getEnumValues,
	getUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";
import { SETTINGS_EN_MESSAGES } from "../../../src/i18n/settings-locale/en";
import { SETTINGS_ZH_CN_MESSAGES } from "../../../src/i18n/settings-locale/zh-CN";

interface TranslationRef {
	path: SettingPath;
	kind: "group" | "label" | "description" | "option label" | "option description" | "enum value";
	key: string;
}

const SETTINGS_UI_MESSAGES = {
	en: SETTINGS_EN_MESSAGES,
	"zh-CN": SETTINGS_ZH_CN_MESSAGES,
} as const;

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

let previousLocale = getSettingsUiLocale();

function collectTranslationRefs(): TranslationRef[] {
	const refs: TranslationRef[] = [];
	for (const tab of SETTING_TABS) {
		for (const def of getSettingsForTab(tab)) {
			const ui = getUi(def.path);
			if (!ui) throw new Error(`Missing ui metadata for ${def.path}`);

			if (ui.group) refs.push({ path: def.path, kind: "group", key: ui.group });
			refs.push({ path: def.path, kind: "label", key: ui.label });
			refs.push({ path: def.path, kind: "description", key: ui.description });

			if (Array.isArray(ui.options)) {
				for (const option of ui.options) {
					refs.push({ path: def.path, kind: "option label", key: option.label });
					if (option.description) {
						refs.push({ path: def.path, kind: "option description", key: option.description });
					}
				}
			}

			if (def.type === "enum") {
				for (const value of getEnumValues(def.path) ?? []) {
					refs.push({ path: def.path, kind: "enum value", key: value });
				}
			}
		}
	}
	return refs;
}

function collectUniqueTranslationRefs(): Array<{ key: string; refs: TranslationRef[] }> {
	const byKey = new Map<string, TranslationRef[]>();
	for (const ref of collectTranslationRefs()) {
		const existing = byKey.get(ref.key);
		if (existing) existing.push(ref);
		else byKey.set(ref.key, [ref]);
	}
	return [...byKey.entries()].map(([key, refs]) => ({ key, refs }));
}

describe("settings layout", () => {
	beforeEach(async () => {
		previousLocale = getSettingsUiLocale();
		resetSettingsForTest();
		setSettingsUiLocale("en");
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		setSettingsUiLocale(previousLocale);
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const ui = getUi(path);
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${path}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${path}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("keeps explicit en and zh-CN translations for every settings UI string the runtime renders", () => {
		const missing: string[] = [];

		for (const { key, refs } of collectUniqueTranslationRefs()) {
			const locations = refs.map(ref => `${ref.path} (${ref.kind})`).join(", ");
			for (const [locale, messages] of Object.entries(SETTINGS_UI_MESSAGES)) {
				if (!Object.hasOwn(messages, key)) {
					missing.push(`${locale}: ${JSON.stringify(key)} ← ${locations}`);
				}
			}
		}

		expect(missing).toEqual([]);
	});

	it("keeps placeholder sets identical between en and zh-CN for rendered settings UI strings", () => {
		const mismatches: string[] = [];

		for (const { key, refs } of collectUniqueTranslationRefs()) {
			const en = SETTINGS_EN_MESSAGES[key];
			const zh = SETTINGS_ZH_CN_MESSAGES[key];
			if (en === undefined || zh === undefined) continue;

			const enPlaceholders = [...en.matchAll(PLACEHOLDER_PATTERN)].map(([, name]) => name).sort();
			const zhPlaceholders = [...zh.matchAll(PLACEHOLDER_PATTERN)].map(([, name]) => name).sort();
			if (JSON.stringify(enPlaceholders) !== JSON.stringify(zhPlaceholders)) {
				const locations = refs.map(ref => `${ref.path} (${ref.kind})`).join(", ");
				mismatches.push(
					`${JSON.stringify(key)} ← ${locations} | en=${JSON.stringify(enPlaceholders)} zh-CN=${JSON.stringify(zhPlaceholders)}`,
				);
			}
		}

		expect(mismatches).toEqual([]);
	});

	it("keeps provider option values stable across locales while labels localize independently", () => {
		setSettingsUiLocale("en");
		const english = getSettingsForTab("providers")
			.filter(def => "options" in def)
			.map(def => ({ path: def.path, values: def.options.map(option => option.value) }));

		setSettingsUiLocale("zh-CN");
		const chinese = getSettingsForTab("providers")
			.filter(def => "options" in def)
			.map(def => ({ path: def.path, values: def.options.map(option => option.value) }));

		expect(chinese).toEqual(english);
	});

	it("exposes native terminal progress in the appearance settings menu", () => {
		const def = getSettingsForTab("appearance").find(def => def.path === "terminal.showProgress");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Native Terminal Progress",
			group: "Display",
		});
	});

	it("exposes every accepted snapcompact shape in the settings submenu", () => {
		const def = getSettingsForTab("context").find(def => def.path === "snapcompact.shape");

		expect(def?.type).toBe("submenu");
		if (def?.type !== "submenu") throw new Error("snapcompact.shape should render as a submenu");
		const values = def.options.map(option => option.value);
		expect(values).toContain("silver16-bw");
		expect(values).toEqual([...SETTINGS_SCHEMA["snapcompact.shape"].values]);
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths: SettingPath[] = ["advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set(advisorDependentPaths);
		const defs = getSettingsForTab("model").filter(def => advisorDependentPathSet.has(def.path));

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		Settings.instance.set("advisor.enabled", true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("shows provider request limits as a providers services submenu setting", () => {
		const [def] = getSettingsForTab("providers").filter(item => item.path === "providers.maxInFlightRequests");

		expect(def).toMatchObject({
			path: "providers.maxInFlightRequests",
			type: "providerLimits",
			tab: "providers",
			group: "Services",
		});
	});

	it("exposes retry fallback chains as editable JSON in the model settings", () => {
		const def = getSettingsForTab("model").find(item => item.path === "retry.fallbackChains");

		expect(def).toMatchObject({
			path: "retry.fallbackChains",
			type: "text",
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
		});
		if (!def) throw new Error("retry.fallbackChains setting definition missing");

		const description = def.description.toLowerCase();
		expect(description).toContain("json");
		expect(description).toContain("fallback");
		expect(description).toContain("selector");
	});

	it("exposes usage-aware fallback as an opt-in advanced policy", () => {
		const defs = getSettingsForTab("model").filter(def => def.path.startsWith("retry.usage"));
		expect(defs.map(def => def.path)).toEqual([
			"retry.usageAwareFallback",
			"retry.usageReservePct",
			"retry.usageReservePolicy",
		]);
		expect(defs[0]).toMatchObject({ type: "boolean", label: "Usage-Aware Fallback" });
		expect(defs[1]?.condition?.()).toBe(false);
		expect(defs[2]?.condition?.()).toBe(false);
		Settings.instance.set("retry.usageAwareFallback", true);
		expect(defs[1]?.condition?.()).toBe(true);
		expect(defs[2]?.condition?.()).toBe(true);
	});

	it("exposes ask.enabled as a boolean under Available Tools", () => {
		const def = getSettingsForTab("tools").find(def => def.path === "ask.enabled");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Ask",
			group: "Available Tools",
		});
	});
	it("exposes fixed localized Ask timeout choices", () => {
		expect(SETTINGS_SCHEMA["ask.timeout"].default).toBe(30);

		setSettingsUiLocale("zh-CN");
		const def = getSettingsForTab("interaction").find(def => def.path === "ask.timeout");
		if (def?.type !== "submenu") throw new Error("ask.timeout should render as a submenu");

		expect(def).toMatchObject({
			label: "Ask 超时",
			description:
				"在 YOLO 模式下，每个问题都会获得独立的新倒计时；倒计时结束后会自动选择该问题明确标记的推荐选项（0 表示关闭）",
		});
		expect(def.options).toEqual([
			{ value: "0", label: "已禁用" },
			{ value: "30", label: "30 秒" },
			{ value: "60", label: "60 秒" },
		]);
	});
});
