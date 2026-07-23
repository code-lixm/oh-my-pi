import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FocusedAgentView } from "@oh-my-pi/pi-coding-agent/modes/components/focused-agent-view";
import type { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { type KeyId, visibleWidth } from "@oh-my-pi/pi-tui";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const initialLocale = getSettingsUiLocale();
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
beforeEach(async () => {
	await initTheme(false);
});

afterEach(() => {
	setSettingsUiLocale(initialLocale);
	if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

function pinRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function strip(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

function expectLinesWithinWidth(lines: readonly string[], width: number): void {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function session(modelId: string, thinkingLevel: string = "off"): AgentSession {
	return { model: { id: modelId }, thinkingLevel } as unknown as AgentSession;
}

function registerSub(
	registry: AgentRegistry,
	id: string,
	displayName: string,
	agentSession: AgentSession,
	status: AgentRef["status"] = "running",
): void {
	registry.register({ id, displayName, kind: "sub", parentId: MAIN_AGENT_ID, session: agentSession, status });
}

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "do work",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeView(options: {
	agentId?: string;
	registry?: AgentRegistry;
	progressById?: Record<string, AgentProgress | undefined>;
	transcriptLines?: string[];
	mainNeedsInput?: () => boolean;
	nextKeys?: KeyId[];
	previousKeys?: KeyId[];
	expandKeys?: KeyId[];
	onCycle?: (direction: "next" | "previous") => void;
	onClose?: () => void;
	onToggleExpanded?: () => void;
	requestRender?: () => void;
}) {
	const registry = options.registry ?? new AgentRegistry();
	return new FocusedAgentView({
		agentId: options.agentId ?? "Worker",
		registry,
		transcript: {
			render: () => options.transcriptLines ?? ["subagent transcript line"],
		} as unknown as TranscriptContainer,
		getProgress: id => options.progressById?.[id],
		getViewableAgentIds: () => ["Worker", "Other"],
		mainNeedsInput: options.mainNeedsInput ?? (() => false),
		nextKeys: options.nextKeys ?? ["n"],
		previousKeys: options.previousKeys ?? ["p"],
		expandKeys: options.expandKeys ?? ["o"],
		onCycle: options.onCycle ?? (() => {}),
		onClose: options.onClose ?? (() => {}),
		onToggleExpanded: options.onToggleExpanded ?? (() => {}),
		requestRender: options.requestRender ?? (() => {}),
	});
}

describe("FocusedAgentView", () => {
	it("renders the read-only HUD with resolved model, live TPS, compact stats, transcript, and no submit prompt", () => {
		setSettingsUiLocale("en");
		pinRows(18);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("claude-live", "high"));
		registerSub(registry, "Other", "Other worker", session("other-live"));
		const view = makeView({
			registry,
			progressById: {
				Worker: progress({
					resolvedModel: "openai/gpt-5",
					tokensPerSecond: 12.34,
					tokensPerSecondLive: true,
					durationMs: 5_000,
					tokens: 1_234,
					contextTokens: 4_000,
					contextWindow: 8_000,
					toolCount: 2,
					cost: 0.25,
				}),
			},
			transcriptLines: ["agent output only"],
		});

		const rendered = strip(view.render(120));

		expect(rendered).toContain("Subagent 1/2");
		expect(rendered).toContain("Build worker");
		expect(rendered).toContain("running");
		expect(rendered).toContain("openai/gpt-5");
		expect(rendered).toContain("12.3 tok/s");
		expect(rendered).toContain("tok");
		expect(rendered).toContain("ctx 50%");
		expect(rendered).toContain("2 tools");
		expect(rendered).toContain("$0.25");
		expect(rendered).toContain("agent output only");
		expect(rendered).toContain("p:previous");
		expect(rendered).toContain("n:next");
		expect(rendered).toContain("Esc:Main");
		expect(rendered).not.toContain("Submit");
		expect(rendered).not.toContain("follow-up");
	});

	it("right-aligns complete controls in the header when they fit and gives the transcript the saved row", () => {
		setSettingsUiLocale("en");
		pinRows(12);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("claude-live"));
		const transcriptLines = Array.from({ length: 20 }, (_, index) => `trace-${String(index).padStart(2, "0")}`);
		const progressById = { Worker: progress() };
		const responsiveOptions = {
			registry,
			progressById,
			transcriptLines,
			mainNeedsInput: () => true,
		};
		const controls = "p:previous · n:next · Esc:Main · j/k:scroll · o:expand";
		const wideWidth = 120;
		const narrowWidth = 70;

		expect(visibleWidth(controls)).toBeLessThanOrEqual(wideWidth - 2 - 24 - 2);
		const wide = makeView(responsiveOptions)
			.render(wideWidth)
			.map(line => Bun.stripANSI(line));
		const narrow = makeView(responsiveOptions)
			.render(narrowWidth)
			.map(line => Bun.stripANSI(line));

		expect(wide[1]).toContain("Subagent 1/2");
		expect(wide[1]).toContain("Build worker");
		expect(wide[1].endsWith(controls)).toBe(true);
		expect(wide.reduce((count, line) => count + line.split(controls).length - 1, 0)).toBe(1);
		expect(wide.at(-3)).toContain("Main needs input");
		expect(wide.at(-2)).toContain("running");
		expect(wide.at(-1)).not.toContain(controls);
		expect(wide.filter(line => line.includes("trace-")).length).toBe(
			narrow.filter(line => line.includes("trace-")).length + 1,
		);
		expectLinesWithinWidth(wide, wideWidth);
		expectLinesWithinWidth(narrow, narrowWidth);
	});

	it("keeps localized remapped controls in the footer when CJK-width labels cannot leave 24 identity cells", () => {
		setSettingsUiLocale("zh-CN");
		pinRows(12);
		const width = 82;
		const registry = new AgentRegistry();
		const displayName = "响应式导航检查员甲乙丙丁";
		registerSub(registry, "Worker", displayName, session("模型/实时"));
		const controls = "shift+tab:上一个 · tab:下一个 · Esc:主任务 · j/k:滚动 · enter:展开";
		const view = makeView({
			registry,
			progressById: { Worker: progress() },
			transcriptLines: [
				"trace-cjk-00",
				"trace-cjk-01",
				"trace-cjk-02",
				"trace-cjk-03",
				"trace-cjk-04",
				"trace-cjk-05",
			],
			previousKeys: ["shift+tab", "p"],
			nextKeys: ["tab", "n"],
			expandKeys: ["enter", "o"],
		});

		expect(visibleWidth(displayName)).toBe(24);
		expect(visibleWidth(controls)).toBeGreaterThan(width - 2 - 24 - 2);
		const rendered = view.render(width).map(line => Bun.stripANSI(line));

		expect(rendered[1]).toContain("子代理 1/2");
		expect(rendered[1]).toContain(displayName);
		expect(rendered[1]).not.toContain(controls);
		expect(rendered[1]).not.toContain("shift+tab");
		expect(rendered[1]).not.toContain("Esc:主任务");
		expect(rendered[1]).not.toContain("j/k:滚动");
		expect(rendered[1]).not.toContain("enter:展开");
		expect(rendered.at(-3)).toContain("运行中");
		expect(rendered.at(-2)).toContain(controls);
		expect(rendered.reduce((count, line) => count + line.split(controls).length - 1, 0)).toBe(1);
		expect(rendered.join("\n")).not.toContain("p:上一个");
		expect(rendered.join("\n")).not.toContain("n:下一个");
		expect(rendered.join("\n")).not.toContain("o:展开");
		expectLinesWithinWidth(rendered, width);
	});

	it("falls back to the live session model and labels finalized TPS as last", () => {
		setSettingsUiLocale("en");
		pinRows(14);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Live worker", session("claude-live", "high"));
		const view = makeView({
			registry,
			progressById: { Worker: progress({ tokensPerSecond: 8, tokensPerSecondLive: false }) },
		});

		const rendered = strip(view.render(140));

		expect(rendered).toContain("claude-live");
		expect(rendered).toContain("high");
		expect(rendered).toContain("last 8.0 tok/s");
	});

	it("closes on Esc, navigates configured previous/next keys, toggles expand, and ignores ordinary text", () => {
		const calls: string[] = [];
		const view = makeView({
			onCycle: direction => calls.push(`cycle:${direction}`),
			onClose: () => calls.push("close"),
			onToggleExpanded: () => calls.push("expand"),
			requestRender: () => calls.push("render"),
		});

		view.handleInput("n");
		view.handleInput("p");
		view.handleInput("o");
		view.handleInput("x");
		view.handleInput("\x1b");

		expect(calls).toEqual(["cycle:next", "cycle:previous", "expand", "close"]);
	});

	it("shows the main-needs-input alert only while Main is waiting", () => {
		setSettingsUiLocale("en");
		pinRows(14);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("claude-live"));
		let needsInput = false;
		const view = makeView({ registry, mainNeedsInput: () => needsInput });

		expect(strip(view.render(100))).not.toContain("Main needs input");

		needsInput = true;
		expect(strip(view.render(100))).toContain("Main needs input");
		expect(strip(view.render(100))).toContain("Esc return");
	});

	it("retargets the fullscreen view to the newly focused agent", () => {
		setSettingsUiLocale("en");
		pinRows(14);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("worker-live"));
		registerSub(registry, "Other", "Review worker", session("review-live"));
		const view = makeView({
			registry,
			progressById: {
				Worker: progress({ id: "Worker", resolvedModel: "provider/worker" }),
				Other: progress({ id: "Other", resolvedModel: "provider/review" }),
			},
		});

		expect(strip(view.render(140))).toContain("Build worker");
		expect(strip(view.render(140))).toContain("provider/worker");

		view.setAgentId("Other");
		const rendered = strip(view.render(140));
		expect(rendered).toContain("Subagent 2/2");
		expect(rendered).toContain("Review worker");
		expect(rendered).toContain("provider/review");
		expect(rendered).not.toContain("Build worker");
	});
});
