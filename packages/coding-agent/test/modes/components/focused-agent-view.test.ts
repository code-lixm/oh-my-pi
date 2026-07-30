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

	it("keeps wide focused controls and alerts above the transcript with no footer hint", () => {
		setSettingsUiLocale("en");
		pinRows(12);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("claude-live"));
		const transcriptLines = Array.from({ length: 20 }, (_, index) => `trace-${String(index).padStart(2, "0")}`);
		const controls = "p:previous · n:next · Esc:Main · j/k:scroll · o:expand";
		const wideWidth = 120;
		const wide = makeView({
			registry,
			progressById: { Worker: progress() },
			transcriptLines,
			mainNeedsInput: () => true,
		})
			.render(wideWidth)
			.map(line => Bun.stripANSI(line));
		const firstTranscript = wide.findIndex(line => line.includes("trace-"));
		const hintIndex = wide.findIndex(line => line.includes(controls));
		const alertIndex = wide.findIndex(line => line.includes("Main needs input"));

		expect(wide[1]).toContain("Subagent 1/2");
		expect(wide[1]).toContain("Build worker");
		expect(wide[1].endsWith(controls)).toBe(true);
		expect(firstTranscript).toBeGreaterThanOrEqual(0);
		expect(hintIndex).toBeGreaterThanOrEqual(0);
		expect(alertIndex).toBeGreaterThanOrEqual(0);
		expect(hintIndex).toBeLessThan(firstTranscript);
		expect(alertIndex).toBeLessThan(firstTranscript);
		expect(
			wide
				.slice(0, firstTranscript)
				.filter(
					line =>
						line.includes("p:previous") ||
						line.includes("n:next") ||
						line.includes("Esc:Main") ||
						line.includes("j/k:scroll") ||
						line.includes("o:expand") ||
						line.includes("Main needs input"),
				).length,
		).toBeLessThanOrEqual(2);
		expect(wide.slice(firstTranscript).join("\n")).not.toContain(controls);
		expect(wide.slice(firstTranscript).join("\n")).not.toContain("Main needs input");
		expectLinesWithinWidth(wide, wideWidth);
	});

	it("keeps localized narrow focused controls above the transcript in at most two rows", () => {
		setSettingsUiLocale("zh-CN");
		pinRows(12);
		const width = 82;
		const registry = new AgentRegistry();
		const displayName = "响应式导航检查员甲乙丙丁";
		registerSub(registry, "Worker", displayName, session("模型/实时"));
		const controls = "shift+tab:上一个 · tab:下一个 · Esc:主任务 · j/k:滚动 · enter:展开";
		const rendered = makeView({
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
			mainNeedsInput: () => true,
			previousKeys: ["shift+tab", "p"],
			nextKeys: ["tab", "n"],
			expandKeys: ["enter", "o"],
		})
			.render(width)
			.map(line => Bun.stripANSI(line));
		const firstTranscript = rendered.findIndex(line => line.includes("trace-cjk-"));
		const hintIndex = rendered.findIndex(line => line.includes("shift+tab:上一个"));
		const alertIndex = rendered.findIndex(line => line.includes("主代理需要输入"));

		expect(visibleWidth(displayName)).toBe(24);
		expect(visibleWidth(controls)).toBeGreaterThan(width - 2 - 24 - 2);
		expect(rendered[1]).toContain("子代理 1/2");
		expect(rendered[1]).toContain(displayName);
		expect(firstTranscript).toBeGreaterThanOrEqual(0);
		expect(hintIndex).toBeGreaterThanOrEqual(0);
		expect(alertIndex).toBeGreaterThanOrEqual(0);
		expect(hintIndex).toBeLessThan(firstTranscript);
		expect(alertIndex).toBeLessThan(firstTranscript);
		expect(
			rendered
				.slice(0, firstTranscript)
				.filter(
					line =>
						line.includes("shift+tab:上一个") ||
						line.includes("tab:下一个") ||
						line.includes("Esc:主任务") ||
						line.includes("j/k:滚动") ||
						line.includes("enter:展开") ||
						line.includes("主代理需要输入"),
				).length,
		).toBeLessThanOrEqual(2);
		expect(rendered.slice(firstTranscript).join("\n")).not.toContain("shift+tab:上一个");
		expect(rendered.slice(firstTranscript).join("\n")).not.toContain("主代理需要输入");
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

	it("places registry metadata directly below the title and never repeats it after the transcript", () => {
		setSettingsUiLocale("en");
		pinRows(14);

		for (const status of ["idle", "waiting"] as const) {
			const registry = new AgentRegistry();
			registerSub(registry, "Worker", "Build worker", session("claude-live"), status);
			const lines = makeView({ registry, progressById: { Worker: undefined } })
				.render(120)
				.map(line => Bun.stripANSI(line));
			const titleIndex = lines.findIndex(line => line.includes("Build worker"));
			const metadataIndex = lines.findIndex((line, index) => index > titleIndex && line.includes(status));
			const transcriptIndex = lines.findIndex(line => line.includes("subagent transcript line"));

			expect(metadataIndex).toBe(titleIndex + 1);
			expect(metadataIndex).toBeLessThan(transcriptIndex);
			expect(lines.slice(transcriptIndex + 1).join("\n")).not.toContain(status);
		}
	});

	it("reserves the transcript scrollbar column even when the focused transcript fits", () => {
		setSettingsUiLocale("en");
		pinRows(14);
		const registry = new AgentRegistry();
		registerSub(registry, "Worker", "Build worker", session("claude-live"));
		const marker = "single-line-transcript-marker";
		const lines = makeView({ registry, transcriptLines: [marker] })
			.render(100)
			.map(line => Bun.stripANSI(line));
		const transcriptLine = lines.find(line => line.includes(marker));

		expect(transcriptLine).toBeDefined();
		expect(transcriptLine?.endsWith("█")).toBe(true);
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
