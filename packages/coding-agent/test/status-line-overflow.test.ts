import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSegmentId } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

/** Minimal SegmentContext factory — only path/git fields matter for these tests. */
function createCtx(overrides?: { pathMaxLength?: number; branch?: string | null }): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {
			path: {
				abbreviate: false,
				maxLength: overrides?.pathMaxLength ?? 40,
				stripWorkPrefix: false,
			},
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: {
			branch: overrides?.branch ?? null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

function registerFocusedChild(root: { id: string; displayName: string; sessionTitle?: string }, childId: string): void {
	const registry = AgentRegistry.global();
	registry.register({
		...root,
		kind: "main",
		session: {} as AgentSession,
		status: "idle",
	});
	registry.register({
		id: childId,
		displayName: childId,
		kind: "sub",
		parentId: root.id,
		session: {} as AgentSession,
		status: "idle",
	});
}

describe("pi status-line segment", () => {
	it("shows the focused subagent display name as Main › name", () => {
		registerFocusedChild({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID }, "Worker-7");
		const ctx: SegmentContext = {
			...createCtx(),
			focusedAgentId: "Worker-7",
			focusedAgentDisplayName: "Plan reviewer",
		};
		const result = renderSegment("pi", ctx);

		expect(result.visible).toBe(true);
		expect(result.content).toContain("Main › Plan reviewer ");
	});

	it("falls back to the focused subagent id when no display name is available", () => {
		registerFocusedChild({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID }, "Worker-7");
		const ctx: SegmentContext = {
			...createCtx(),
			focusedAgentId: "Worker-7",
		};
		const result = renderSegment("pi", ctx);

		expect(result.visible).toBe(true);
		expect(result.content).toContain("Main › Worker-7 ");
	});

	it("shows the owning secondary session title for a focused child", () => {
		registerFocusedChild(
			{
				id: "top-level:review",
				displayName: "4b1d4df0-0ae0-4ff8-8f25-d35a5ba13e2f",
				sessionTitle: "Review session",
			},
			"Worker-9",
		);
		const result = renderSegment("pi", {
			...createCtx(),
			focusedAgentId: "Worker-9",
			focusedAgentDisplayName: "Patch worker",
		});

		expect(result.content).toContain("Review session › Patch worker ");
	});

	it("fails closed to an unknown root for missing and cyclic parent chains", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "orphan",
			displayName: "orphan",
			kind: "sub",
			parentId: "missing",
			session: {} as AgentSession,
			status: "idle",
		});
		const missing = renderSegment("pi", { ...createCtx(), focusedAgentId: "orphan" });
		expect(missing.content).toContain("? › orphan ");

		AgentRegistry.resetGlobalForTests();
		const cyclic = AgentRegistry.global();
		cyclic.register({
			id: "cycle-a",
			displayName: "cycle-a",
			kind: "sub",
			parentId: "cycle-b",
			session: {} as AgentSession,
			status: "idle",
		});
		cyclic.register({
			id: "cycle-b",
			displayName: "cycle-b",
			kind: "sub",
			parentId: "cycle-a",
			session: {} as AgentSession,
			status: "idle",
		});
		const cycle = renderSegment("pi", { ...createCtx(), focusedAgentId: "cycle-a" });
		expect(cycle.content).toContain("? › cycle-a ");
	});
});

function createStatusLineSession(sessionName: string, modelName?: string) {
	const model = modelName ? { name: modelName, contextWindow: 128000 } : undefined;
	return {
		state: { messages: [], model },
		messages: [],
		model: model ?? { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
		getGoalModeState: () => null,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("status line session accent", () => {
	function buildComponent(sessionAccent: boolean) {
		const component = new StatusLineComponent(createStatusLineSession("Named session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent,
		});
		return component;
	}

	// Computed lazily: `theme` is assigned by initTheme() in beforeAll, after module evaluation.
	const accentAnsi = () =>
		getSessionAccentAnsi(
			getSessionAccentHex("Named session", theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
		);

	it("paints the gap with the session accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(true).getTopBorder(80).content;
		expect(border).toContain(`${ansi}${theme.boxRound.horizontal}`);
	});

	it("paints the gap with the border color and omits the session accent when disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(false).getTopBorder(80).content;
		// Positive: gap is rendered with the theme border color.
		expect(border).toContain(`${theme.getFgAnsi("border")}${theme.boxRound.horizontal}`);
		// Negative: the gap-painting pattern (accent ANSI directly followed by a horizontal
		// glyph) must not appear. The session_name segment may still emit the accent ANSI
		// for its own text — we only care that the gap is not accent-painted.
		expect(border).not.toContain(`${ansi}${theme.boxRound.horizontal}`);
	});
});

describe("status line focused-agent dimming", () => {
	it("keeps powerline end caps at full intensity while text stays dimmed", () => {
		const component = new StatusLineComponent(createStatusLineSession("Focused session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		component.setSession(createStatusLineSession("Focused session"), "agent-1");

		const border = component.getTopBorder(80).content;

		expect(border).toStartWith("\x1b[2m");
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineLeft}\x1b[0m\x1b[2m`);
		expect(border).toContain(`\x1b[22m${theme.sep.powerlineRight}\x1b[0m\x1b[2m`);
		expect(border).toContain("\x1b[0m\x1b[2m");
		expect(border).toEndWith("\x1b[22m");
	});
});

describe("path segment truncation at varying maxLength", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-very-long-directory-name-for-testing-"));
		setProjectDir(tmpDir);
	});

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		const full = renderSegment("path", createCtx({ pathMaxLength: 200 }));
		const short = renderSegment("path", createCtx({ pathMaxLength: 10 }));

		expect(full.visible).toBe(true);
		expect(short.visible).toBe(true);
		expect(visibleWidth(short.content)).toBeLessThan(visibleWidth(full.content));
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLen => {
			const rendered = renderSegment("path", createCtx({ pathMaxLength: maxLen }));
			return visibleWidth(rendered.content);
		});

		for (let i = 1; i < widths.length; i++) {
			expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
		}
	});

	it("still renders a visible segment at maxLength=4", () => {
		const rendered = renderSegment("path", createCtx({ pathMaxLength: 4 }));
		expect(rendered.visible).toBe(true);
		expect(visibleWidth(rendered.content)).toBeGreaterThan(0);
	});
});

describe("overflow: path shrinks before git is dropped", () => {
	let tmpDir: string;

	beforeAll(() => {
		// Long dir name guarantees the path segment is wide
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-a-very-long-worktree-directory-name-here-"));
		setProjectDir(tmpDir);
	});

	/**
	 * Simulates the overflow algorithm from #buildStatusLine:
	 * render left segments, then shrink path before popping, same as production code.
	 */
	function simulateOverflow(
		width: number,
		leftSegmentIds: StatusLineSegmentId[],
		ctx: SegmentContext,
	): { surviving: StatusLineSegmentId[]; contents: string[] } {
		const left: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of leftSegmentIds) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				left.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		// Simplified groupWidth: sum of visible widths + padding between segments
		const groupWidth = () => {
			if (left.length === 0) return 0;
			const partsWidth = left.reduce((sum, p) => sum + visibleWidth(p), 0);
			// Each separator gap ~ 3 chars, plus 2 for outer padding
			return partsWidth + Math.max(0, left.length - 1) * 3 + 2;
		};

		// Path shrink step (mirrors production code)
		const pathIdx = leftSegIds.indexOf("path");
		if (pathIdx >= 0 && groupWidth() > width) {
			const overflow = groupWidth() - width;
			const currentPathVW = visibleWidth(left[pathIdx]);
			const minPathVW = 8;
			const shrinkable = currentPathVW - minPathVW;
			if (shrinkable > 0) {
				const shrinkBy = Math.min(shrinkable, overflow);
				const currentMaxLen = ctx.options.path?.maxLength ?? 40;
				let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
				const pathCtx = (maxLen: number): SegmentContext => ({
					...ctx,
					options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
				});
				let reRendered = renderSegment("path", pathCtx(newMaxLen));
				if (reRendered.visible && reRendered.content) {
					for (let i = 0; i < 8; i++) {
						const saved = currentPathVW - visibleWidth(reRendered.content);
						if (saved >= shrinkBy) break;
						const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
						if (nextMaxLen >= newMaxLen) break;
						newMaxLen = nextMaxLen;
						const adjusted = renderSegment("path", pathCtx(newMaxLen));
						if (!adjusted.visible || !adjusted.content) break;
						reRendered = adjusted;
					}
					left[pathIdx] = reRendered.content;
				}
			}
		}

		// Left-segment fallback loop.
		const leftOverflowDropIndex = (): number => {
			for (let i = leftSegIds.length - 1; i >= 0; i--) {
				if (leftSegIds[i] !== "path") return i;
			}
			return left.length - 1;
		};
		while (groupWidth() > width && left.length > 0) {
			const dropIdx = leftOverflowDropIndex();
			left.splice(dropIdx, 1);
			leftSegIds.splice(dropIdx, 1);
		}

		return { surviving: [...leftSegIds], contents: [...left] };
	}

	it("keeps git segment when path can be shrunk to fit", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "feat/long-branch-name" });
		// Use a width that's tight but should fit both after path shrinks
		const fullPath = renderSegment("path", ctx);
		const fullGit = renderSegment("git", ctx);
		const bothWidth = visibleWidth(fullPath.content) + visibleWidth(fullGit.content);
		// Set width to ~60% of both segments — forces shrink but should keep both
		const tightWidth = Math.floor(bothWidth * 0.6) + 10;

		const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

		expect(result.surviving).toContain("git");
		expect(result.surviving).toContain("path");
	});

	it("drops git only when terminal is extremely narrow", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		// Absurdly narrow — even minimally-truncated path won't fit with git
		const result = simulateOverflow(5, ["path", "git"], ctx);

		// At 5 columns, nothing fits
		expect(result.surviving.length).toBeLessThanOrEqual(1);
	});

	it("is a no-op when there is enough space", () => {
		const ctx = createCtx({ pathMaxLength: 40, branch: "main" });
		const result = simulateOverflow(200, ["path", "git"], ctx);

		expect(result.surviving).toEqual(["path", "git"]);
	});

	it("shrinks a short path when maxLength exceeds actual path length", () => {
		// Short dir name — rendered path is well under the configured maxLength.
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-short-"));
		setProjectDir(shortDir);
		try {
			const maxLength = 160;
			const ctx = createCtx({ pathMaxLength: maxLength, branch: "feat/long-branch-name" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Sanity: path is shorter than maxLength — this is the bug scenario.
			// macOS temp paths can exceed 80 columns once the path icon is included.
			expect(pathVW).toBeLessThan(maxLength);

			// Width that fits a shrunken path + git but not the full path + git
			const tightWidth = Math.floor(pathVW * 0.5) + gitVW + 10;

			const result = simulateOverflow(tightWidth, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");
		} finally {
			// Restore for other tests
			setProjectDir(tmpDir);
		}
	});
	it("preserves git when overflow is only 1-2 columns", () => {
		const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-narrow-ovf-"));
		setProjectDir(shortDir);
		try {
			const ctx = createCtx({ pathMaxLength: 80, branch: "main" });
			const fullPath = renderSegment("path", ctx);
			const fullGit = renderSegment("git", ctx);
			const pathVW = visibleWidth(fullPath.content);
			const gitVW = visibleWidth(fullGit.content);

			// Compute exact full width using the test's groupWidth formula:
			// partsWidth + (numParts - 1) * 3 + 2
			const fullWidth = pathVW + gitVW + (2 - 1) * 3 + 2;

			// Overflow by exactly 2 columns — the scenario the single-pass missed
			const result = simulateOverflow(fullWidth - 2, ["path", "git"], ctx);

			expect(result.surviving).toContain("path");
			expect(result.surviving).toContain("git");

			// Path must have actually shrunk (proves the loop ran)
			const shrunkPathVW = visibleWidth(result.contents[result.surviving.indexOf("path")]);
			expect(shrunkPathVW).toBeLessThan(pathVW);
		} finally {
			setProjectDir(tmpDir);
		}
	});
});

describe("overflow: path survives before model", () => {
	it("drops the model segment before the cwd path when both cannot fit", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-statusline-overflow-"));
		const cwd = path.join(root, "cwdxyz");
		fs.mkdirSync(cwd);
		setProjectDir(cwd);

		const modelName = `MODEL_SHOULD_DROP_${"x".repeat(24)}`;
		const session = createStatusLineSession("overflow test", modelName);
		const component = new StatusLineComponent(session);
		const pathOptions = {
			abbreviate: false,
			maxLength: 32,
			stripWorkPrefix: false,
		};
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		});

		const ctx = {
			...createCtx({ pathMaxLength: pathOptions.maxLength }),
			session,
			options: {
				model: { showThinkingLevel: false },
				path: pathOptions,
			},
		} as SegmentContext;
		const pi = renderSegment("pi", ctx).content;
		const model = renderSegment("model", ctx).content;
		const minPath = renderSegment("path", {
			...ctx,
			options: { ...ctx.options, path: { ...pathOptions, maxLength: 4 } },
		}).content;
		const separatorWidth = visibleWidth(theme.sep.space);
		const groupWidth = (parts: string[]) =>
			parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
			Math.max(0, parts.length - 1) * (separatorWidth + 2) +
			2;
		const width = groupWidth([pi, model]) + 1;

		expect(groupWidth([pi, model, minPath])).toBeGreaterThan(width);
		expect(groupWidth([pi, minPath])).toBeLessThanOrEqual(width);

		const rendered = stripAnsi(component.getTopBorder(width).content);
		expect(rendered).toContain("xyz");
		expect(rendered).not.toContain("MODEL_SHOULD_DROP");
	});
});
