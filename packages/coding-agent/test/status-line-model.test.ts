import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createModelContext(
	advisorActive: boolean,
	options: { provider?: string } = { provider: "provider-a" },
): SegmentContext {
	return {
		session: {
			state: {
				model: {
					id: "test-model",
					name: "Test Model",
					...(options.provider === undefined ? {} : { provider: options.provider }),
				},
			},
			isFastModeActive: () => false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running" }] : [],
			}),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
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
			ttftMs: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		schedule: null,
	};
}

describe("status line model segment advisor badge", () => {
	it("appends a success-colored ++ badge when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		const display = Bun.stripANSI(rendered.content);
		expect(display).toContain("Test Model");
		expect(display).toContain("++");
		expect(rendered.content).toContain(theme.fg("success", "++"));
	});

	it("omits the badge when every configured advisor has no resolved model", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [{ name: "unresolved", status: "no_model" }],
		});

		const rendered = renderSegment("model", ctx);
		const display = Bun.stripANSI(rendered.content);
		expect(display).toContain("Test Model");
		expect(display).not.toContain("++");
	});

	it("omits the badge when configured advisors are all unavailable", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "paused", status: "paused" },
				{ name: "quota-exhausted", status: "quota_exhausted" },
				{ name: "failed", status: "error" },
			],
		});

		const rendered = renderSegment("model", ctx);
		const display = Bun.stripANSI(rendered.content);
		expect(display).toContain("Test Model");
		expect(display).not.toContain("++");
	});

	it("keeps the badge for a mixed roster and colors it by the worst status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "running", status: "running" },
				{ name: "quota-exhausted", status: "quota_exhausted" },
			],
		});
		const warningRendered = renderSegment("model", ctx);
		expect(Bun.stripANSI(warningRendered.content)).toContain("++");
		expect(warningRendered.content).toContain(theme.fg("warning", "++"));

		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "running", status: "running" },
				{ name: "quota-exhausted", status: "quota_exhausted" },
				{ name: "failed", status: "error" },
			],
		});
		const errorRendered = renderSegment("model", ctx);
		expect(Bun.stripANSI(errorRendered.content)).toContain("++");
		expect(errorRendered.content).toContain(theme.fg("error", "++"));
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain("++");
	});
});

describe("status line model segment provider label", () => {
	it("renders provider/model when showProvider is enabled", () => {
		const ctx = createModelContext(false, { provider: "provider-a" });
		ctx.options = { model: { showProvider: true } };

		const display = Bun.stripANSI(renderSegment("model", ctx).content);
		expect(display).toContain("provider-a/Test Model");
	});

	it("distinguishes the same model name across providers", () => {
		const providerA = createModelContext(false, { provider: "provider-a" });
		const providerB = createModelContext(false, { provider: "provider-b" });
		providerA.options = { model: { showProvider: true } };
		providerB.options = { model: { showProvider: true } };

		const providerADisplay = Bun.stripANSI(renderSegment("model", providerA).content);
		const providerBDisplay = Bun.stripANSI(renderSegment("model", providerB).content);
		expect(providerADisplay).toContain("provider-a/Test Model");
		expect(providerBDisplay).toContain("provider-b/Test Model");
		expect(providerADisplay).not.toBe(providerBDisplay);
	});

	it("keeps model-only output when showProvider is disabled", () => {
		const ctx = createModelContext(false, { provider: "provider-a" });
		ctx.options = { model: { showProvider: false } };

		const display = Bun.stripANSI(renderSegment("model", ctx).content);
		expect(display).toContain("Test Model");
		expect(display).not.toContain("provider-a");
	});

	it("keeps model-only output when showProvider is omitted", () => {
		const ctx = createModelContext(false, { provider: "provider-a" });

		const display = Bun.stripANSI(renderSegment("model", ctx).content);
		expect(display).toContain("Test Model");
		expect(display).not.toContain("provider-a");
	});

	it("does not add a separator when provider is missing", () => {
		const ctx = createModelContext(false, { provider: undefined });
		ctx.options = { model: { showProvider: true } };

		const display = Bun.stripANSI(renderSegment("model", ctx).content);
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		expect(display).toBe(`${modelPrefix}Test Model`);
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(rendered.content)).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(rendered.content)).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(rendered.content)).not.toContain(theme.sep.dot);
	});
});
