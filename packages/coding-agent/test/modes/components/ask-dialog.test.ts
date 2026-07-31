import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { getSettingsUiLocale, setSettingsUiLocale, tSettingsUi } from "../../../src/i18n/settings-locale";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const ENTER = "\n";
const CANCEL = "\x07";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

let darkTheme = await getThemeByName("dark");
let previousSettingsUiLocale = getSettingsUiLocale();

function render(component: AskDialogComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("AskDialogComponent", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		previousSettingsUiLocale = getSettingsUiLocale();
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.useRealTimers();
		vi.restoreAllMocks();
		setSettingsUiLocale(previousSettingsUiLocale);
	});

	it("single-question, single-select: Enter on option submits immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Choose one?",
					options: ["Option A", "Option B"],
					multi: false,
					selectedOptions: ["Option A"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
	});

	it("single-question, single-select: Space does not submit the highlighted answer", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("single-question, single-select: DOWN then Enter selects second option and submits", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
	});

	it("multi-question, single-select: Enter on option advances tab, does not submit", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Press Enter on A1 - should advance tab to Q2 (tab 1), not submit
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Q2: Down to B2 and Enter - should advance tab to Submit (tab 2), not submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Submit tab: Enter on Submit row - should submit
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			{
				id: "q1",
				question: "Q1?",
				options: ["A1", "B1"],
				multi: false,
				selectedOptions: ["A1"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
			{
				id: "q2",
				question: "Q2?",
				options: ["A2", "B2"],
				multi: false,
				selectedOptions: ["B2"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
		]);
	});

	it("multi-select: Space and Enter both toggle without advancing; Submit tab confirms", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Space on Option A - toggles without advancing
		component.handleInput(SPACE);
		expect(onSubmit).not.toHaveBeenCalled();

		// Down to Option B, Enter - toggles B, still no submit and no movement
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// Tab to the Submit tab (present even for a single multi question),
		// Enter confirms the selection.
		component.handleInput(TAB);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A", "Option B"]);
	});

	it("tab-state persistence: answer question 0, Tab forward, Tab back, answer still present", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Enter on A1 selects it and auto-advances to Q2 (tab 1)
		component.handleInput(ENTER);

		// Shift+Tab back to Q1 (tab 0)
		component.handleInput(SHIFT_TAB);

		// Enter again on Q1's currently selected option (which will re-select/keep it and auto-advance to Q2)
		component.handleInput(ENTER);

		// On Q2: select B2 and advance to Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// On Submit: Enter to submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["A1"]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Tab and Shift+Tab switches tabs", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab from Q1 -> Q2
		component.handleInput(TAB);
		// Tab from Q2 -> Submit
		component.handleInput(TAB);
		// Shift+Tab from Submit -> Q2
		component.handleInput(SHIFT_TAB);

		// Down to B2, Enter -> Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Submit tab shows unanswered warning but Enter still submits", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab to Submit
		component.handleInput(TAB);
		component.handleInput(TAB);

		const output = render(component);
		expect(output.toLowerCase()).toContain("unanswered");

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual([]);
	});

	it("Esc/cancel fires onCancel", () => {
		const onCancel = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel,
			onPrompt: vi.fn(),
		});

		component.handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("n on an option calls onPrompt and stores note with marker", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("My Custom Note"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Highlight is on Option A. Press 'n'.
		component.handleInput("n");

		// Await microtasks so the async #promptForNote runs
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");

		// Verify note is saved by submitting
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBe("My Custom Note");
	});

	it("note prefill is empty when editing a different row after noting another option", async () => {
		const onPrompt = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Cursor starts on Option A. Add a note for A.
		onPrompt.mockReturnValueOnce(Promise.resolve("Note for A"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");
		// No prior note → prefill is undefined.
		expect(onPrompt.mock.calls[0][1]).toBeUndefined();

		// Move down to Option B and open its note.
		component.handleInput(DOWN);
		onPrompt.mockReturnValueOnce(Promise.resolve("Note for B"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(2);
		// Prefill for Option B must be undefined — not the note from Option A.
		expect(onPrompt.mock.calls[1][1]).toBeUndefined();

		// Move back up to Option A and re-open its note.
		component.handleInput("\x1b[A"); // UP
		onPrompt.mockReturnValueOnce(Promise.resolve("Updated note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(3);
		// Note now belongs to Option B, so re-editing Option A starts empty.
		expect(onPrompt.mock.calls[2][1]).toBeUndefined();
	});

	it("note prefill reuses the existing note when re-editing the same row", async () => {
		const onPrompt = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Add a note on Option A.
		onPrompt.mockReturnValueOnce(Promise.resolve("My note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		// Re-open the note on the same row (cursor still on Option A).
		onPrompt.mockReturnValueOnce(Promise.resolve("Updated note"));
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(2);
		// Same row → prefill reuses the existing note.
		expect(onPrompt.mock.calls[1][1]).toBe("My note");
	});

	it("omits a note when a single-select answer changes to a different option", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("clears the note when a noted multi-select option is toggled off", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(SPACE);
		component.handleInput(SPACE);
		expect(render(component)).not.toContain("✎ note");

		// Select Option B and confirm from the Submit tab; the cleared note
		// must not resurface.
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		component.handleInput(TAB);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("shows selected multi-select options together with custom input on Submit", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom detail"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
			{
				id: "q2",
				question: "Second question?",
				options: [{ label: "Option C" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		// Multi questions do not auto-advance after the Other prompt: still on
		// q1, so Tab twice (q2, then Submit) to reach the review.
		component.handleInput(TAB);
		component.handleInput(TAB);
		const review = render(component);
		expect(review).toContain("Option A");
		expect(review).toContain("custom detail");

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBe("custom detail");
	});

	it("starts the hard deadline on first render and never resets it for navigation or ordinary input", () => {
		vi.useFakeTimers();
		setSettingsUiLocale("en");
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "database",
					question: "Which database?",
					options: [{ label: "SQLite" }, { label: "Postgres" }],
					recommended: 1,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000, onTimeout },
		);

		vi.advanceTimersByTime(5_000);
		expect(onSubmit).not.toHaveBeenCalled();

		expect(render(component)).toContain("Ask · defaults to Postgres in 1s");
		vi.advanceTimersByTime(900);
		component.handleInput(DOWN);
		component.handleInput("x");
		vi.advanceTimersByTime(100);

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0]).toEqual(
			expect.objectContaining({ selectedOptions: ["Postgres"], timedOut: true }),
		);
	});

	it("renders only the current question's recommended option in the deadline title", () => {
		vi.useFakeTimers();
		setSettingsUiLocale("en");
		const component = new AskDialogComponent(
			[
				{
					id: "automatic",
					question: "Can default?",
					options: [{ label: "No" }, { label: "Yes" }],
					recommended: 1,
				},
				{
					id: "manual",
					question: "Needs a person?",
					options: [{ label: "Later" }, { label: "Now" }],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000 },
		);

		const title = render(component).split("\n")[0] ?? "";
		expect(title).toContain("Ask · defaults to Yes in 1s");
		expect(title).not.toContain("manual question");
		component.dispose();
	});

	it("gives the next recommended question a full timeout after a manual answer near the first deadline", () => {
		vi.useFakeTimers();
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "first",
					question: "First?",
					options: [{ label: "First default" }, { label: "First manual" }],
					recommended: 0,
				},
				{
					id: "second",
					question: "Second?",
					options: [{ label: "Second default" }, { label: "Second manual" }],
					recommended: 0,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000, onTimeout },
		);

		render(component);
		vi.advanceTimersByTime(900);
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(component)).toContain("Ask · defaults to Second default in 1s");
		vi.advanceTimersByTime(999);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			expect.objectContaining({ id: "first", selectedOptions: ["First manual"], timedOut: undefined }),
			expect.objectContaining({ id: "second", selectedOptions: ["Second default"], timedOut: true }),
		]);
	});

	it("defaults only the current question when its timeout expires", () => {
		vi.useFakeTimers();
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "first",
					question: "First?",
					options: [{ label: "First default" }, { label: "First manual" }],
					recommended: 0,
				},
				{
					id: "second",
					question: "Second?",
					options: [{ label: "Second default" }, { label: "Second manual" }],
					recommended: 0,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000, onTimeout },
		);

		render(component);
		vi.advanceTimersByTime(1_000);

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(render(component)).toContain("Ask · defaults to Second default in 1s");

		component.handleInput(DOWN);
		component.handleInput(ENTER);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			expect.objectContaining({ id: "first", selectedOptions: ["First default"], timedOut: true }),
			expect.objectContaining({ id: "second", selectedOptions: ["Second manual"], timedOut: undefined }),
		]);
	});

	it("does not start a countdown when the current question has no recommendation", () => {
		vi.useFakeTimers();
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "missing",
					question: "Missing recommendation?",
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
				{
					id: "later",
					question: "Valid recommendation later?",
					options: [{ label: "Option C" }, { label: "Option D" }],
					recommended: 1,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000, onTimeout },
		);

		expect(render(component).split("\n")[0] ?? "").not.toContain("defaults");
		vi.advanceTimersByTime(1_000);

		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		component.dispose();
	});

	it("does not start a countdown when the current question has an invalid recommendation", () => {
		vi.useFakeTimers();
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const component = new AskDialogComponent(
			[
				{
					id: "invalid",
					question: "Invalid recommendation?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					recommended: 9,
				},
				{
					id: "later",
					question: "Valid recommendation later?",
					options: [{ label: "Option C" }, { label: "Option D" }],
					recommended: 1,
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
			{ timeout: 1_000, onTimeout },
		);

		expect(render(component).split("\n")[0] ?? "").not.toContain("defaults");
		vi.advanceTimersByTime(1_000);

		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		component.dispose();
	});

	it("bounds custom input prompt title for long multi-line questions", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom"));
		const longQuestion = "This is a very long question ".repeat(20);
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: longQuestion,
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Navigate to "Other" and press Enter to trigger the custom prompt.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		const title = onPrompt.mock.calls[0][0] as string;
		const lines = title.split("\n");
		// Title must be bounded to at most MAX_PROMPT_TITLE_ROWS lines.
		expect(lines.length).toBeLessThanOrEqual(3);
		// Each line must fit within the terminal content width.
		for (const line of lines) {
			expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual((process.stdout.columns ?? 80) - 4);
		}
		// Must contain the prefix and a truncation indicator on the last line.
		expect(stripVTControlCharacters(title)).toContain("Custom answer:");
	});

	it("bounds note prompt title for long multi-line questions", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("note"));
		const longQuestion = "Multi\nline\nquestion ".repeat(30);
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: longQuestion,
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt,
		});

		// Press 'n' on the highlighted option to trigger the note prompt.
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		const title = onPrompt.mock.calls[0][0] as string;
		const lines = title.split("\n");
		// Title must be bounded to at most MAX_PROMPT_TITLE_ROWS lines.
		expect(lines.length).toBeLessThanOrEqual(3);
		// The multi-line question must be flattened (no raw newlines expanding rows).
		expect(stripVTControlCharacters(title)).toContain("Note for Option A:");
	});

	it("scrolls question rows when cursor moves below the viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const options = Array.from({ length: 30 }, (_, i) => ({
				label: `Option ${String(i + 1).padStart(2, "0")}`,
			}));
			const questions: ExtensionAskDialogQuestion[] = [{ id: "q1", question: "Pick one?", options }];
			const component = new AskDialogComponent(questions, {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});
			const renderAt = (width: number): string => stripVTControlCharacters(component.render(width).join("\n"));

			const initial = renderAt(60);
			expect(initial).toContain("Option 01");
			expect(initial).not.toContain("Option 30");
			expect(initial).toContain("↓ scroll");

			for (let i = 0; i < 28; i++) component.handleInput(DOWN);
			const scrolled = renderAt(60);
			expect(scrolled).not.toContain("Option 01");
			expect(scrolled).toContain("Option 29");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("single-question multi-select: Enter toggles instead of submitting", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Enter on Option B toggles it — no submit, no tab movement.
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// The toggle registered: Submit tab confirms only Option B.
		component.handleInput(TAB);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
	});

	it("multi-select: Enter on a checked option toggles it off; empty answer submits from Submit tab", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Space checks Option A, Enter on the same row unchecks it.
		component.handleInput(SPACE);
		component.handleInput(ENTER);

		// Submit tab warns about the unanswered question but still submits.
		component.handleInput(TAB);
		expect(render(component).toLowerCase()).toContain("unanswered");
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
	});

	it("renders every option's preview inline, not only the highlighted one", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick one?",
				options: [
					{ label: "Alpha", preview: "PREVIEW-ALPHA" },
					{ label: "Bravo", preview: "PREVIEW-BRAVO" },
					{ label: "Charlie" },
				],
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		// Cursor defaults to option 0; both previews must be visible without navigating.
		const out = stripVTControlCharacters(component.render(80).join("\n"));
		expect(out).toContain("PREVIEW-ALPHA");
		expect(out).toContain("PREVIEW-BRAVO");
	});

	it("refreshes cached preview styling after theme invalidation", async () => {
		const createComponent = (): AskDialogComponent =>
			new AskDialogComponent(
				[{ id: "q1", question: "Pick one?", options: [{ label: "Alpha", preview: "CACHE-PREVIEW" }] }],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
		const previewLine = (component: AskDialogComponent): string =>
			component.render(80).find(line => line.includes("CACHE-PREVIEW")) ?? "";
		const originalTheme = darkTheme;
		if (!originalTheme) throw new Error("Failed to load dark theme");
		const lightTheme = await getThemeByName("light");
		if (!lightTheme) throw new Error("Failed to load light theme");
		const cachedComponent = createComponent();
		const before = previewLine(cachedComponent);
		expect(stripVTControlCharacters(before)).toContain("│ CACHE-PREVIEW");
		try {
			setThemeInstance(lightTheme);
			const stale = previewLine(cachedComponent);
			const fresh = previewLine(createComponent());
			expect(stripVTControlCharacters(stale)).toBe(stripVTControlCharacters(fresh));
			expect(stale).not.toBe(fresh);

			cachedComponent.invalidate();
			expect(previewLine(cachedComponent)).toBe(fresh);
		} finally {
			setThemeInstance(originalTheme);
			cachedComponent.invalidate();
		}
	});

	it("keeps the memoized overflowing render identical to the initial width-adjusted render", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const edgeLine = `${"X".repeat(67)}Ω`;
			const filler = Array.from({ length: 30 }, (_, index) => `filler-${index}`).join("\n");
			const component = new AskDialogComponent(
				[
					{
						id: "q1",
						question: "Inspect?",
						options: [{ label: "Alpha", preview: `\`\`\`\n${edgeLine}\n${filler}\n\`\`\`` }],
					},
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);

			const initial = render(component);
			const cached = render(component);
			expect(initial).toContain("Ω");
			expect(cached).toBe(initial);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps the cancel hint visible with tabs and a tall preview", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const preview = `\`\`\`\n${Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n")}\n\`\`\``;
			const component = new AskDialogComponent(
				[
					{ id: "q1", question: "Inspect?", options: [{ label: "Alpha", preview }], multi: true },
					{ id: "q2", question: "Continue?", options: [{ label: "Bravo" }] },
				],
				{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
			);
			const out = render(component);

			expect(out).toContain("PgUp/PgDn");
			expect(out).toContain("Tab/←/→");
			expect(out).not.toContain(" tabs");
			expect(out).toContain("ctrl+g cancel");
			setKeybindings(
				KeybindingsManager.inMemory({
					"tui.select.cancel": "ctrl+g",
					"tui.select.pageUp": "ctrl+u",
					"tui.select.pageDown": "ctrl+d",
				}),
			);
			const remapped = render(component);
			expect(remapped).toContain("ctrl+u/ctrl+d");
			expect(remapped).toContain("ctrl+g cancel");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("pages through an inline preview taller than the question viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const previewLines = Array.from({ length: 80 }, (_, index) => {
				if (index === 0) return "PREVIEW-FIRST";
				if (index === 40) return "PREVIEW-MIDDLE";
				if (index === 79) return "PREVIEW-LAST";
				return `preview-line-${index}`;
			});
			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q1",
					question: "Inspect the preview?",
					options: [{ label: "Plain" }, { label: "Alpha", preview: `\`\`\`\n${previewLines.join("\n")}\n\`\`\`` }],
				},
			];
			const component = new AskDialogComponent(questions, {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});

			let out = render(component);
			expect(out).toContain("PREVIEW-FIRST");
			expect(out).not.toContain("PREVIEW-MIDDLE");
			expect(out).not.toContain("PREVIEW-LAST");
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toContain("↓ scroll");
			component.handleInput(DOWN);
			for (let page = 0; page < 4; page++) component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PgUp/PgDn");
			expect(out).toContain("PREVIEW-MIDDLE");
			component.handleInput(DOWN);
			out = render(component);
			expect(out).toContain("Other (type your own)");
			expect(out).not.toContain("PREVIEW-MIDDLE");
			expect(out).not.toContain("PgUp/PgDn");
			component.handleInput(UP);
			out = render(component);
			expect(out).toContain("PREVIEW-FIRST");
			expect(out).toContain("PgUp/PgDn");
			for (let page = 0; page < 10; page++) {
				component.handleInput(PAGE_DOWN);
				out = render(component);
			}
			expect(out).toContain("PREVIEW-LAST");
			expect(out).not.toContain("Other (type your own)");
			component.handleInput(DOWN);
			out = render(component);
			expect(out).toContain("Other (type your own)");
			component.handleInput(UP);
			out = render(component);
			for (let page = 0; page < 10; page++) {
				component.handleInput(PAGE_UP);
				out = render(component);
			}
			expect(out).toContain("PREVIEW-FIRST");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("keeps a selected inline preview visible when its row fits the viewport", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const options = [
				...Array.from({ length: 8 }, (_, index) => ({ label: `Plain ${index}` })),
				{ label: "Target", preview: "```\nPREVIEW-SHORT-FIRST\npreview-short-middle\nPREVIEW-SHORT-LAST\n```" },
				...Array.from({ length: 8 }, (_, index) => ({ label: `After ${index}` })),
			];
			const component = new AskDialogComponent([{ id: "q1", question: "Pick one?", options }], {
				onSubmit: vi.fn(),
				onCancel: vi.fn(),
				onPrompt: vi.fn(),
			});

			for (let index = 0; index < 8; index++) component.handleInput(DOWN);
			let out = render(component);
			expect(out).toContain("PREVIEW-SHORT-FIRST");
			expect(out).toContain("PREVIEW-SHORT-LAST");
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toMatch(/[↓↑↕] scroll/);
			component.handleInput(PAGE_DOWN);
			out = render(component);
			expect(out).toContain("PREVIEW-SHORT-FIRST");
			expect(out).toContain("PREVIEW-SHORT-LAST");
			expect(out).not.toContain("PgUp/PgDn");
			expect(out).toMatch(/[↓↑↕] scroll/);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("does not repeat the tab chip in the question line", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "First question?", header: "Alpha", options: [{ label: "A" }] },
			{ id: "q2", question: "Second question?", header: "Beta", options: [{ label: "B" }] },
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const output = render(component);
		// Tab bar still shows the chip…
		expect(output).toContain("Alpha");
		// …but the question line is just the question, not "[Alpha] First question?".
		expect(output).toContain("First question?");
		expect(output).not.toContain("[Alpha]");
	});

	it("bounds in-body question header for long multi-line questions", () => {
		const onSubmit = vi.fn();
		const longQuestion = "This is a very long question ".repeat(30);
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: longQuestion,
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});

		// The rendered body must not blow out with the full 30-line question.
		// The header is capped to MAX_HEADER_ROWS lines.
		const output = render(component);
		// The question text should appear but be truncated — verify it does
		// not contain the full repeated text (30 copies would be ~870 chars).
		expect(output).toContain("This is a very long question");
		// Count occurrences of the repeated phrase — should be far fewer than 30.
		const matches = output.match(/This is a very long question/g);
		expect(matches?.length ?? 0).toBeLessThan(10);
	});

	it("Other editor cancel returns to the option list without submitting", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve(undefined));
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onPrompt,
		});

		// Navigate to "Other" and press Enter to open the custom input prompt.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		// The prompt was cancelled (returns undefined). The dialog must stay
		// open — no submit, no cancel.
		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		// The dialog should still be usable: select Option A and submit.
		component.handleInput("\x1b[A"); // UP to Option B
		component.handleInput("\x1b[A"); // UP to Option A
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
	});

	it("keeps a fixed spawn-time height across tabs, clamped to 70% of the terminal", () => {
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Pick one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const cap = Math.max(12, Math.floor((process.stdout.rows || 40) * 0.7));
		const questionTab = component.render(80);
		expect(questionTab.length).toBeLessThanOrEqual(cap);

		// The submit tab renders at exactly the same height — the box is
		// sized once from the tallest tab, not per-tab content.
		component.handleInput(TAB);
		const submitTab = component.render(80);
		expect(submitTab.length).toBe(questionTab.length);

		// Toggling an option (which changes the review summary) does not
		// resize the box either.
		component.handleInput(SHIFT_TAB);
		component.handleInput(SPACE);
		expect(component.render(80).length).toBe(questionTab.length);
	});

	it("clears the custom answer when the Other prompt is submitted empty", async () => {
		const onPrompt = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];
		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt,
		});

		// Set a custom answer via Other.
		onPrompt.mockReturnValueOnce(Promise.resolve("my custom answer"));
		component.handleInput(DOWN); // Option B
		component.handleInput(DOWN); // Other
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(render(component)).toContain("my custom answer");

		// Reopen Other (prefilled with the current answer) and submit an
		// empty value: the custom answer is unselected.
		onPrompt.mockReturnValueOnce(Promise.resolve(""));
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();
		expect(onPrompt).toHaveBeenNthCalledWith(2, expect.any(String), "my custom answer");
		expect(render(component)).not.toContain("my custom answer");

		// Submitting confirms nothing was kept.
		component.handleInput(TAB);
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBeUndefined();
	});

	it("renders runtime-switched zh-CN labels for Other and Submit after module load", () => {
		setSettingsUiLocale("en");
		setSettingsUiLocale("zh-CN");
		const component = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Choose multiple?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: true,
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);

		const questionView = render(component);
		expect(questionView).toContain(tSettingsUi("Other (type your own)"));
		expect(questionView).toContain(tSettingsUi("Submit"));
		expect(questionView).not.toContain("Other (type your own)");
		expect(questionView).not.toContain("Submit");

		component.handleInput(TAB);
		const submitView = render(component);
		expect(submitView).toContain(tSettingsUi("Review answers"));
		expect(submitView).not.toContain("Review answers");
	});
});
