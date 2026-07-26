import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const TAB = "\t";
const ENTER = "\n";
const BACKSPACE = "\x7f";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;
let previousSettingsUiLocale = getSettingsUiLocale();

beforeEach(async () => {
	previousSettingsUiLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	setSettingsUiLocale(previousSettingsUiLocale);
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(onChange: (path: string, value: unknown) => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange,
			onCancel: () => {},
		},
	);
}

function renderText(component: SettingsSelectorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function openRetryAttemptsEditor(component: SettingsSelectorComponent): void {
	component.handleInput(RIGHT);
	component.handleInput(TAB);

	for (let i = 0; i < 3; i++) {
		component.handleInput(DOWN);
	}

	const sectionView = renderText(component);
	expect(sectionView).toContain("Retry & Fallback");
	expect(sectionView).toContain("Tab/Enter to settings");

	component.handleInput(TAB);
	component.handleInput(ENTER);

	const editorView = renderText(component);
	expect(editorView).toContain("Retry Attempts");
	expect(editorView).toContain("Maximum retry attempts on API errors");
	expect(editorView).toContain(String(settings.get("retry.maxRetries")));
	expect(editorView).toContain("Enter to save · Esc to cancel");
	expect(editorView).not.toContain("Clear field to unset");
}

function replaceRetryAttemptsInput(component: SettingsSelectorComponent, next: string): void {
	for (let i = 0; i < String(settings.get("retry.maxRetries")).length; i++) {
		component.handleInput(BACKSPACE);
	}
	for (const ch of next) {
		component.handleInput(ch);
	}
}

describe("SettingsSelectorComponent retry attempts", () => {
	it("opens Retry Attempts as a number input prefilled with the saved retry budget", () => {
		const component = createSelector();

		openRetryAttemptsEditor(component);
		const editor = renderText(component);
		expect(editor).toContain("Retry Attempts");
		expect(editor).toContain("Maximum retry attempts on API errors");
		expect(editor).toContain("10");
		expect(editor).toContain("Enter to save · Esc to cancel");
		expect(editor).not.toContain("Clear field to unset");
	});

	it("saves an arbitrary integer retry budget and notifies onChange", () => {
		const onChange = vi.fn();
		const component = createSelector(onChange);

		openRetryAttemptsEditor(component);
		replaceRetryAttemptsInput(component, "7");
		component.handleInput(ENTER);

		expect(settings.get("retry.maxRetries")).toBe(7);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("retry.maxRetries", 7);
	});

	it("rejects negative, fractional, empty, and non-numeric retry budgets without overwriting the saved value", () => {
		const cases = [
			{ name: "negative numbers", input: "-1", error: "Value must be at least 0." },
			{ name: "fractional numbers", input: "1.5", error: "Value must be an integer." },
			{ name: "empty string", input: "", error: "Invalid number: " },
			{ name: "non-numeric text", input: "abc", error: "Invalid number: abc" },
		] as const;

		for (const testCase of cases) {
			settings.set("retry.maxRetries", 4);
			const onChange = vi.fn();
			const component = createSelector(onChange);

			openRetryAttemptsEditor(component);
			replaceRetryAttemptsInput(component, testCase.input);
			component.handleInput(ENTER);

			expect(settings.get("retry.maxRetries"), testCase.name).toBe(4);
			expect(onChange, testCase.name).not.toHaveBeenCalled();
			expect(renderText(component), testCase.name).toContain(testCase.error);
		}
	});
});
