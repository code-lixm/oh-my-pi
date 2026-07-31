import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { ExtensionUIDialogOptions, ExtensionUISelectItem } from "../src/extensibility/extensions";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { AskTool, type AskToolDetails } from "../src/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;
type AskSelect = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(options: { timeout: number; approvalMode?: string; plan?: boolean }): AskTool {
	const { timeout, approvalMode = "yolo", plan = false } = options;
	return new AskTool({
		hasUI: true,
		settings: {
			get(key: string): unknown {
				switch (key) {
					case "ask.timeout":
						return timeout;
					case "tools.approvalMode":
						return approvalMode;
					case "ask.notify":
						return "off";
					case "speech.enabled":
						return false;
					default:
						return undefined;
				}
			},
		},
		getPlanModeState: () => ({ enabled: plan }),
	} as unknown as ToolSession);
}

function createDefaultAskTool(): AskTool {
	return new AskTool({
		hasUI: true,
		settings: Settings.isolated(),
		getPlanModeState: () => ({ enabled: false }),
	} as unknown as ToolSession);
}

function createContext(select: AskSelect) {
	const abort = vi.fn();
	return {
		context: {
			hasUI: true,
			ui: { select, editor: vi.fn() },
			abort,
		} as unknown as AgentToolContext,
		abort,
	};
}

function waitForAbort(signal: AbortSignal | undefined): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	if (signal?.aborted) {
		resolve(undefined);
	} else {
		signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	}
	return promise;
}

function ask(
	tool: AskTool,
	context: AgentToolContext,
	questions: Parameters<AskTool["execute"]>[1]["questions"],
): Promise<AskExecutionResult> {
	return tool.execute("ask-timeout", { questions }, undefined, undefined, context);
}

describe("AskTool hard deadline", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("auto-selects a YOLO ask at the default thirty-second hard deadline", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => waitForAbort(dialogOptions?.signal));
		const { context, abort } = createContext(select);
		let settled: AskExecutionResult | undefined;
		const execution = ask(createDefaultAskTool(), context, [
			{
				id: "database",
				question: "Which database?",
				options: [{ label: "SQLite" }, { label: "Postgres" }],
				recommended: 1,
			},
		]).then(result => {
			settled = result;
			return result;
		});

		await drainMicrotasks();
		vi.advanceTimersByTime(29_999);
		await drainMicrotasks();
		expect(settled).toBeUndefined();

		vi.advanceTimersByTime(1);
		const result = await execution;

		expect(result.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "the approval mode is always-ask", timeout: 0.01, approvalMode: "always-ask", plan: false },
		{ label: "the approval mode is write", timeout: 0.01, approvalMode: "write", plan: false },
		{ label: "plan mode is active", timeout: 0.01, approvalMode: "yolo", plan: true },
		{ label: "the configured timeout is zero", timeout: 0, approvalMode: "yolo", plan: false },
	])("keeps waiting when $label", async ({ timeout, approvalMode, plan }) => {
		vi.useFakeTimers();
		const manual = Promise.withResolvers<string | undefined>();
		const select = vi.fn<AskSelect>(() => manual.promise);
		const { context, abort } = createContext(select);
		let settled: AskExecutionResult | undefined;
		const execution = ask(createAskTool({ timeout, approvalMode, plan }), context, [
			{
				id: "database",
				question: "Which database?",
				options: [{ label: "SQLite" }, { label: "Postgres" }],
				recommended: 1,
			},
		]).then(result => {
			settled = result;
			return result;
		});

		await drainMicrotasks();
		vi.advanceTimersByTime(50);
		await drainMicrotasks();
		expect(settled).toBeUndefined();

		manual.resolve("SQLite");
		const result = await execution;
		expect(result.details?.selectedOptions).toEqual(["SQLite"]);
		expect(result.details?.timedOut).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "no recommendation", question: {} },
		{ label: "an out-of-range recommendation", question: { recommended: 9 } },
		{ label: "a non-integer recommendation", question: { recommended: 0.5 } },
	])("never fabricates the first option for $label", async ({ question }) => {
		vi.useFakeTimers();
		const manual = Promise.withResolvers<string | undefined>();
		const select = vi.fn<AskSelect>(() => manual.promise);
		const { context, abort } = createContext(select);
		let settled: AskExecutionResult | undefined;
		const execution = ask(createAskTool({ timeout: 0.01 }), context, [
			{
				id: "database",
				question: "Which database?",
				options: [{ label: "SQLite" }, { label: "Postgres" }],
				...question,
			},
		]).then(result => {
			settled = result;
			return result;
		});

		await drainMicrotasks();
		vi.advanceTimersByTime(50);
		await drainMicrotasks();
		expect(settled).toBeUndefined();

		manual.resolve("Postgres");
		const result = await execution;
		expect(result.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result.details?.timedOut).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	it("gives the second question a fresh timeout after a quick manual first answer", async () => {
		vi.useFakeTimers();
		const firstPresented = Promise.withResolvers<void>();
		const secondPresented = Promise.withResolvers<void>();
		const firstAnswer = Promise.withResolvers<string | undefined>();
		const select = vi.fn<AskSelect>((title, _options, dialogOptions) => {
			if (title.includes("First?")) {
				firstPresented.resolve();
				return firstAnswer.promise;
			}
			if (title.includes("Second?")) {
				secondPresented.resolve();
				return waitForAbort(dialogOptions?.signal);
			}
			throw new Error(`unexpected question: ${title}`);
		});
		const { context, abort } = createContext(select);
		let settled: AskExecutionResult | undefined;
		const execution = ask(createAskTool({ timeout: 0.01 }), context, [
			{
				id: "first",
				question: "First?",
				options: [{ label: "keep-first" }, { label: "discard-first" }],
			},
			{
				id: "second",
				question: "Second?",
				options: [{ label: "manual-second" }, { label: "default-second" }],
				recommended: 1,
			},
		]).then(result => {
			settled = result;
			return result;
		});

		await firstPresented.promise;
		vi.advanceTimersByTime(1);
		firstAnswer.resolve("keep-first");
		await secondPresented.promise;

		vi.advanceTimersByTime(9);
		await drainMicrotasks();
		expect(settled).toBeUndefined();

		vi.advanceTimersByTime(1);
		const result = await execution;

		expect(result.details?.results).toEqual([
			expect.objectContaining({ id: "first", selectedOptions: ["keep-first"], timedOut: undefined }),
			expect.objectContaining({ id: "second", selectedOptions: ["default-second"], timedOut: true }),
		]);
		expect(abort).not.toHaveBeenCalled();
	});
});
