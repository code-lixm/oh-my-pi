import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

const components: ToolExecutionComponent[] = [];
const uiStub = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

let previousLocale = getSettingsUiLocale();
let previousDisplayLanguage: "en" | "zh-CN";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	previousLocale = getSettingsUiLocale();
	previousDisplayLanguage = Settings.instance.get("displayLanguage") as "en" | "zh-CN";
});

afterEach(() => {
	for (const component of components.splice(0)) component.stopAnimation();
	setSettingsUiLocale(previousLocale);
	Settings.instance.override("displayLanguage", previousDisplayLanguage);
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function setDisplayLanguage(locale: "en" | "zh-CN") {
	setSettingsUiLocale(locale);
	Settings.instance.override("displayLanguage", locale);
}

function makeComponent(args: unknown) {
	const component = new ToolExecutionComponent("demo", args, {}, undefined, uiStub);
	component.stopAnimation();
	components.push(component);
	return component;
}

function render(component: ToolExecutionComponent): string {
	return Bun.stripANSI(component.render(80).join("\n"));
}

function rerender(component: ToolExecutionComponent): string {
	component.invalidate();
	return render(component);
}

describe("ToolExecutionComponent locale refresh", () => {
	it("re-renders expanded args chrome when the runtime locale changes", () => {
		const component = makeComponent({ path: "notes.txt" });
		component.setExpanded(true);

		setDisplayLanguage("en");
		const english = rerender(component);
		expect(english).toContain("Args");
		expect(english).not.toContain("参数");

		setDisplayLanguage("zh-CN");
		const chinese = rerender(component);
		expect(chinese).toContain("参数");
		expect(chinese).not.toContain("Args");
		expect(chinese).not.toBe(english);

		setDisplayLanguage("en");
		const englishAgain = rerender(component);
		expect(englishAgain).toContain("Args");
		expect(englishAgain).not.toContain("参数");
		expect(englishAgain).toBe(english);
	});
});
