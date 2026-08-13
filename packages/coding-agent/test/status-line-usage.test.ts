import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageAmount, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type {
	SegmentContext,
	StatusLineUsageItem,
	StatusLineUsageSummary,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	resetSettingsForTest();
});

function percentAmount(usedFraction: number): UsageAmount {
	return { usedFraction, unit: "percent" };
}

function makeLimit(options: {
	provider: string;
	id: string;
	label: string;
	amount: UsageAmount;
	windowId?: string;
	durationMs?: number;
	resetsAt?: number;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	status?: UsageLimit["status"];
}): UsageLimit {
	return {
		id: options.id,
		label: options.label,
		scope: {
			provider: options.provider,
			accountId: options.accountId,
			projectId: options.projectId,
			orgId: options.orgId,
			modelId: options.modelId,
			tier: options.tier,
			windowId: options.windowId,
		},
		window:
			options.windowId || options.durationMs !== undefined || options.resetsAt !== undefined
				? {
						id: options.windowId ?? options.id,
						label: options.label,
						durationMs: options.durationMs,
						resetsAt: options.resetsAt,
					}
				: undefined,
		amount: options.amount,
		status: options.status ?? "ok",
	};
}

function makeReport(
	provider: string,
	limits: UsageLimit[],
	metadata?: UsageReport["metadata"],
	fetchedAt = Date.now(),
): UsageReport {
	return { provider, fetchedAt, limits, metadata };
}
type UsageSegmentOptions = {
	batteryStyle?: "blocks" | "segmented";
	batteryWidth?: number;
	latestOnly?: boolean;
	maxItems?: number;
	maxWidth?: number;
	providers?: string[];
	showLabel?: boolean;
	showPercentage?: boolean;
	showResetTime?: boolean;
	showTrack?: boolean;
	style?: "battery" | "text";
};

function makeUsageItem(options: {
	provider: string;
	label: string;
	amount: UsageAmount;
	accountLabel?: string;
	modelId?: string;
	tier?: string;
	durationMs?: number;
	windowId?: string;
	resetsAt?: number;
	usedFraction?: number;
	status?: StatusLineUsageItem["status"];
}): StatusLineUsageItem {
	return {
		provider: options.provider,
		accountLabel: options.accountLabel,
		label: options.label,
		tier: options.tier,
		modelId: options.modelId,
		durationMs: options.durationMs,
		windowId: options.windowId,
		resetsAt: options.resetsAt,
		usedFraction: options.usedFraction,
		amount: options.amount,
		status: options.status,
	};
}

function makeComponent(
	reports: unknown,
	options: {
		provider?: string;
		modelId?: string;
		activeIdentity?: { accountId?: string; email?: string; projectId?: string; orgId?: string };
		segmentOptions?: {
			usage?: UsageSegmentOptions;
		};
	} = {},
): StatusLineComponent {
	let usageRevision = 0;
	const component = new StatusLineComponent({
		state: { messages: [], model: { contextWindow: 1000, provider: options.provider, id: options.modelId } },
		model: { contextWindow: 1000, provider: options.provider, id: options.modelId },
		sessionManager: {
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
		fetchUsageReports: async () => reports,
		modelRegistry: {
			authStorage: {
				getOAuthAccountIdentity: (provider: string) =>
					provider === options.provider ? options.activeIdentity : undefined,
				getGeneration: () => 1,
				get usageRevision() {
					return usageRevision;
				},
				incrementUsageRevision: () => {
					usageRevision++;
				},
			},
		},
		getVisibleAsyncJobCount: () => 0,
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		segmentOptions: {
			usage: {
				showResetTime: false,
				...(options.segmentOptions?.usage ?? {}),
			},
		},
		sessionAccent: false,
	});
	return component;
}

function makeUsageContext(
	items: StatusLineUsageItem[],
	usageOptions?: UsageSegmentOptions,
	session?: SegmentContext["session"],
): SegmentContext {
	const usage: StatusLineUsageSummary = { items };
	return {
		usage,
		session:
			session ??
			({ state: { messages: [], model: undefined }, model: undefined } as unknown as SegmentContext["session"]),
		options: { usage: usageOptions ?? {} },
	} as unknown as SegmentContext;
}

async function flushUsageRefresh(): Promise<void> {
	vi.advanceTimersByTime(0);
	await Promise.resolve();
	await Promise.resolve();
}

async function renderUsage(component: StatusLineComponent, width = 200): Promise<string> {
	component.refreshUsageInBackground();
	await flushUsageRefresh();
	return stripVTControlCharacters(component.getTopBorder(width).content);
}
const SEGMENTED_BATTERY_GLYPH = "▬";
const BLOCK_BATTERY_WIDTH = 5;
const SEGMENTED_BATTERY_WIDTH = 7;
const SEGMENTED_BATTERY_FULL = SEGMENTED_BATTERY_GLYPH.repeat(SEGMENTED_BATTERY_WIDTH);
const SEGMENTED_BATTERY_FORBIDDEN_CHARS = ["\ue0b6", "\ue0b4", "▕", " "];
type BatteryStyle = "blocks" | "segmented";
type BatteryColor = "success" | "warning" | "error";
function expectedSegmentedBatteryAnsi(usedCells: number, color: BatteryColor): string {
	const remainingCells = SEGMENTED_BATTERY_WIDTH - usedCells;
	return (
		(usedCells > 0 ? theme.fg("muted", SEGMENTED_BATTERY_GLYPH.repeat(usedCells)) : "") +
		(remainingCells > 0 ? theme.fg(color, SEGMENTED_BATTERY_GLYPH.repeat(remainingCells)) : "")
	);
}
function expectedBlockBatteryAnsi(fill: string, color: BatteryColor): string {
	return (
		(fill ? theme.fg(color, fill) : "") +
		theme.fg("muted", "█".repeat(Math.max(0, BLOCK_BATTERY_WIDTH - visibleWidth(fill))))
	);
}
const BLOCK_BATTERY_OPTIONS: UsageSegmentOptions = {
	style: "battery",
	batteryWidth: BLOCK_BATTERY_WIDTH,
	showLabel: false,
	showPercentage: false,
	showTrack: true,
};
const SEGMENTED_BATTERY_OPTIONS: UsageSegmentOptions = {
	style: "battery",
	batteryStyle: "segmented",
	batteryWidth: SEGMENTED_BATTERY_WIDTH,
	showLabel: false,
	showPercentage: false,
};
function renderBattery(style: BatteryStyle, remainingFraction?: number, status?: StatusLineUsageItem["status"]) {
	const amount: UsageAmount =
		remainingFraction === undefined ? { unit: "percent" } : { remainingFraction, unit: "percent" };
	return renderSegment(
		"usage",
		makeUsageContext(
			[
				makeUsageItem({
					provider: "anthropic",
					label: "Weekly",
					amount,
					status,
				}),
			],
			style === "segmented" ? SEGMENTED_BATTERY_OPTIONS : BLOCK_BATTERY_OPTIONS,
		),
	);
}
const BATTERY_COLOR_CASES: Array<{
	name: string;
	remainingFraction: number;
	status?: StatusLineUsageItem["status"];
	expectedColor: BatteryColor;
	blockFill: string;
	segmentedUsedCells: number;
}> = [
	{
		name: "0.60 remaining stays green",
		remainingFraction: 0.6,
		expectedColor: "success",
		blockFill: "███",
		segmentedUsedCells: 3,
	},
	{
		name: "0.599 remaining turns yellow",
		remainingFraction: 0.599,
		expectedColor: "warning",
		blockFill: "███",
		segmentedUsedCells: 3,
	},
	{
		name: "0.20 remaining stays yellow",
		remainingFraction: 0.2,
		expectedColor: "warning",
		blockFill: "█",
		segmentedUsedCells: 6,
	},
	{
		name: "0.199 remaining turns red",
		remainingFraction: 0.199,
		expectedColor: "error",
		blockFill: "█",
		segmentedUsedCells: 6,
	},
	{
		name: "warning status forces yellow",
		remainingFraction: 0.8,
		status: "warning",
		expectedColor: "warning",
		blockFill: "████",
		segmentedUsedCells: 1,
	},
	{
		name: "exhausted status forces red",
		remainingFraction: 0.8,
		status: "exhausted",
		expectedColor: "error",
		blockFill: "████",
		segmentedUsedCells: 1,
	},
];

describe("status-line usage", () => {
	it("renders complete usage reports in configured provider order and window-duration order", async () => {
		const reports = [
			makeReport("anthropic", [
				makeLimit({
					provider: "anthropic",
					id: "anthropic:7d",
					label: "7 Day",
					windowId: "7d",
					durationMs: 7 * 86_400_000,
					amount: percentAmount(0.08),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					amount: percentAmount(0.24),
				}),
			]),
			makeReport("cursor", [
				makeLimit({
					provider: "cursor",
					id: "cursor:monthly",
					label: "Monthly",
					windowId: "monthly",
					amount: percentAmount(0.1),
				}),
			]),
		];
		const component = makeComponent(reports, {
			segmentOptions: { usage: { providers: ["cursor", "anthropic"], maxItems: 3 } },
		});

		const content = await renderUsage(component);

		const cursorIndex = content.indexOf("cursor:Monthly 10%");
		const anthropicFiveHourIndex = content.indexOf("anthropic:5h 24%");
		const anthropicSevenDayIndex = content.indexOf("anthropic:7d 8%");
		expect(cursorIndex).toBeGreaterThan(-1);
		expect(anthropicFiveHourIndex).toBeGreaterThan(-1);
		expect(anthropicSevenDayIndex).toBeGreaterThan(-1);
		expect(cursorIndex).toBeLessThan(anthropicFiveHourIndex);
		expect(anthropicFiveHourIndex).toBeLessThan(anthropicSevenDayIndex);
	});

	it("normalizes configured provider names before filtering and ordering rendered usage", async () => {
		const reports = [
			makeReport("anthropic", [
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					amount: percentAmount(0.24),
				}),
			]),
			makeReport("cursor", [
				makeLimit({
					provider: "cursor",
					id: "cursor:monthly",
					label: "Monthly",
					windowId: "monthly",
					amount: percentAmount(0.1),
				}),
			]),
			makeReport("gemini", [
				makeLimit({
					provider: "gemini",
					id: "gemini:weekly",
					label: "Weekly",
					windowId: "weekly",
					durationMs: 7 * 86_400_000,
					amount: percentAmount(0.67),
				}),
			]),
		];
		const component = makeComponent(reports, {
			segmentOptions: { usage: { providers: ["  CURSOR  ", "\tAnThRoPiC  ", "cursor", "   "], maxItems: 3 } },
		});

		const content = await renderUsage(component);

		const cursorIndex = content.indexOf("cursor:Monthly 10%");
		const anthropicIndex = content.indexOf("anthropic:5h 24%");
		expect(cursorIndex).toBeGreaterThan(-1);
		expect(anthropicIndex).toBeGreaterThan(-1);
		expect(cursorIndex).toBeLessThan(anthropicIndex);
		expect(content).not.toContain("gemini");
		expect(content).not.toContain("67%");
	});

	it("keeps only the shortest window per provider when latestOnly is enabled and breaks equal durations by earlier reset", async () => {
		const reports = [
			makeReport("anthropic", [
				makeLimit({
					provider: "anthropic",
					id: "anthropic:monthly",
					label: "Monthly",
					windowId: "monthly",
					amount: percentAmount(0.91),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:weekly",
					label: "Weekly",
					windowId: "weekly",
					durationMs: 7 * 86_400_000,
					amount: percentAmount(0.61),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h:late",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					resetsAt: 50_000,
					amount: percentAmount(0.49),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h:early",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					resetsAt: 40_000,
					amount: percentAmount(0.24),
				}),
			]),
			makeReport("cursor", [
				makeLimit({
					provider: "cursor",
					id: "cursor:monthly",
					label: "Monthly",
					windowId: "monthly",
					amount: percentAmount(0.82),
				}),
				makeLimit({
					provider: "cursor",
					id: "cursor:5h:late",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					resetsAt: 70_000,
					amount: percentAmount(0.52),
				}),
				makeLimit({
					provider: "cursor",
					id: "cursor:weekly",
					label: "Weekly",
					windowId: "weekly",
					durationMs: 7 * 86_400_000,
					amount: percentAmount(0.73),
				}),
				makeLimit({
					provider: "cursor",
					id: "cursor:5h:early",
					label: "5 Hour",
					windowId: "5h",
					durationMs: 5 * 3_600_000,
					resetsAt: 60_000,
					amount: percentAmount(0.13),
				}),
			]),
		];
		const component = makeComponent(reports, {
			segmentOptions: { usage: { providers: ["anthropic", "cursor"], latestOnly: true, maxItems: 4 } },
		});

		const content = await renderUsage(component);

		expect(content).toContain("anthropic:5h 24%");
		expect(content).toContain("cursor:5h 13%");
		expect(content).not.toContain("49%");
		expect(content).not.toContain("52%");
		expect(content).not.toContain("61%");
		expect(content).not.toContain("73%");
		expect(content).not.toContain("91%");
		expect(content).not.toContain("82%");
		expect(content).not.toContain("Monthly");
		expect(content).not.toContain("Weekly");
	});

	it("prefers untiered windows over same-window tiered duplicates and keeps distinct tiered windows", async () => {
		const reports = [
			makeReport("anthropic", [
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h:tier",
					label: "5 Hour",
					windowId: "5h",
					tier: "stale",
					amount: percentAmount(0.5),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h",
					label: "5 Hour",
					windowId: "5h",
					amount: percentAmount(0.24),
				}),
				makeLimit({
					provider: "anthropic",
					id: "anthropic:7d:prolite",
					label: "7 Day",
					windowId: "7d",
					tier: "prolite",
					amount: percentAmount(0.08),
				}),
			]),
		];
		const component = makeComponent(reports);

		const content = await renderUsage(component);

		expect(content).toContain("anthropic:5 Hour 24%");
		expect(content).toContain("anthropic:prolite 7 Day 8%");
		expect(content).not.toContain("stale");
		expect(content).not.toContain("50%");
	});

	it("filters to the active provider, identity, and model while still rendering shared limits and labels", async () => {
		const reports = [
			makeReport(
				"anthropic",
				[
					makeLimit({
						provider: "anthropic",
						id: "anthropic:5h",
						label: "5 Hour",
						windowId: "5h",
						amount: percentAmount(0.99),
					}),
				],
				{ accountId: "ignored-account", orgId: "org-prod" },
			),
			makeReport(
				"openai-codex",
				[
					makeLimit({
						provider: "openai-codex",
						id: "openai-codex:other",
						label: "5 Hour",
						windowId: "5h",
						modelId: "gpt-5.6-sol",
						tier: "other",
						amount: percentAmount(0.66),
					}),
				],
				{ accountId: "other-account", orgId: "org-prod" },
			),
			makeReport(
				"openai-codex",
				[
					makeLimit({
						provider: "openai-codex",
						id: "openai-codex:wrong-org",
						label: "7 Day",
						windowId: "7d",
						modelId: "gpt-5.6-sol",
						tier: "wrong-org",
						amount: percentAmount(0.9),
					}),
				],
				{ accountId: "active-account", orgId: "org-dev" },
			),
			makeReport(
				"openai-codex",
				[
					makeLimit({
						provider: "openai-codex",
						id: "openai-codex:active:sol",
						label: "5 Hour",
						windowId: "5h",
						modelId: "gpt-5.6-sol",
						tier: "prolite",
						amount: percentAmount(0.24),
					}),
					makeLimit({
						provider: "openai-codex",
						id: "openai-codex:active:luna",
						label: "5 Hour",
						windowId: "5h",
						modelId: "gpt-5.6-luna",
						tier: "prolite",
						amount: percentAmount(0.31),
					}),
					makeLimit({
						provider: "openai-codex",
						id: "openai-codex:active:shared",
						label: "Monthly",
						windowId: "monthly",
						amount: percentAmount(0.12),
					}),
				],
				{ accountId: "active-account", orgId: "org-prod" },
			),
		];
		const component = makeComponent(reports, {
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			activeIdentity: { accountId: "active-account", orgId: "org-prod" },
		});

		const content = await renderUsage(component);

		expect(content).toContain("openai-codex/active-account/org-prod/gpt-5.6-sol:prolite 5 Hour 24%");
		expect(content).toContain("openai-codex/active-account/org-prod:Monthly 12%");
		expect(content).not.toContain("99%");
		expect(content).not.toContain("66%");
		expect(content).not.toContain("90%");
		expect(content).not.toContain("gpt-5.6-luna");
		expect(content).not.toContain("31%");
		expect(content).not.toContain("other-account");
		expect(content).not.toContain("org-dev");
	});

	it("renders arbitrary monthly labels and currency symbols without inventing conversions", async () => {
		const reports = [
			makeReport("cursor", [
				makeLimit({
					provider: "cursor",
					id: "cursor:billing-month",
					label: "Billing Month",
					windowId: "billing-month",
					amount: { used: 5_000, limit: 20_000, remaining: 15_000, unit: "currency", currency: "USD" },
				}),
			]),
			makeReport("gemini", [
				makeLimit({
					provider: "gemini",
					id: "gemini:april-cycle",
					label: "April Cycle",
					windowId: "april-cycle",
					amount: { remaining: 35_000, unit: "currency", currency: "CNY" },
				}),
			]),
		];
		const component = makeComponent(reports, {
			segmentOptions: { usage: { providers: ["cursor", "gemini"] } },
		});

		const content = await renderUsage(component);

		expect(content).toContain("cursor:Billing Month $15000.00");
		expect(content).toContain("gemini:April Cycle ¥35000.00");
	});

	it("filters usage items to the configured provider list", async () => {
		const reports = [
			makeReport("anthropic", [
				makeLimit({
					provider: "anthropic",
					id: "anthropic:5h",
					label: "5 Hour",
					windowId: "5h",
					amount: percentAmount(0.99),
				}),
			]),
			makeReport("cursor", [
				makeLimit({
					provider: "cursor",
					id: "cursor:monthly",
					label: "Monthly",
					windowId: "monthly",
					amount: percentAmount(0.1),
				}),
			]),
		];
		const component = makeComponent(reports, {
			segmentOptions: { usage: { providers: ["anthropic"] } },
		});

		const content = await renderUsage(component);

		expect(content).toContain("anthropic:5 Hour 99%");
		expect(content).not.toContain("cursor");
	});

	describe("shared battery color thresholds", () => {
		for (const testCase of BATTERY_COLOR_CASES) {
			it(`renders ${testCase.name} for block batteries`, () => {
				const rendered = renderBattery("blocks", testCase.remainingFraction, testCase.status);

				expect(rendered.visible).toBe(true);
				expect(stripVTControlCharacters(rendered.content)).toBe("█████");
				expect(rendered.content).toBe(expectedBlockBatteryAnsi(testCase.blockFill, testCase.expectedColor));
			});

			it(`renders ${testCase.name} for segmented batteries`, () => {
				const rendered = renderBattery("segmented", testCase.remainingFraction, testCase.status);
				const content = stripVTControlCharacters(rendered.content);

				expect(rendered.visible).toBe(true);
				expect(content).toBe(SEGMENTED_BATTERY_FULL);
				expect(rendered.content).toBe(
					expectedSegmentedBatteryAnsi(testCase.segmentedUsedCells, testCase.expectedColor),
				);
			});
		}
	});

	it("keeps zero, full, and partial inline block batteries at a fixed five-cell width with no labels or percentages", () => {
		const cases = [
			{ name: "zero", remainingFraction: 0, plain: "█████", fill: "", color: "error" as const },
			{ name: "full", remainingFraction: 1, plain: "█████", fill: "█████", color: "success" as const },
			{ name: "partial", remainingFraction: 0.5, plain: "██▌██", fill: "██▌", color: "warning" as const },
		];

		for (const testCase of cases) {
			const rendered = renderBattery("blocks", testCase.remainingFraction);
			const content = stripVTControlCharacters(rendered.content);

			expect(rendered.visible, testCase.name).toBe(true);
			expect(content, testCase.name).toBe(testCase.plain);
			expect(rendered.content, testCase.name).toBe(expectedBlockBatteryAnsi(testCase.fill, testCase.color));
			expect(visibleWidth(rendered.content), testCase.name).toBe(BLOCK_BATTERY_WIDTH);
			expect(content, testCase.name).not.toContain("anthropic");
			expect(content, testCase.name).not.toMatch(/\d/);
			expect(content, testCase.name).not.toContain("%");
		}
	});

	it("shows formatted currency remaining in battery mode when no remaining fraction is available", () => {
		const rendered = renderSegment(
			"usage",
			makeUsageContext(
				[
					makeUsageItem({
						provider: "cursor",
						label: "Wallet",
						amount: { remaining: 15.04, unit: "currency", currency: "USD" },
					}),
				],
				BLOCK_BATTERY_OPTIONS,
			),
		);
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toBe("$15.04");
		expect(content).not.toContain("%");
		expect(content).not.toContain("█");
	});

	it("hides the inline block battery when remaining quota is unknown", () => {
		const rendered = renderBattery("blocks");

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("renders exact seven-glyph segmented batteries with muted used quota on the left and colored remaining quota on the right", () => {
		const cases = [
			{ remainingFraction: 0, usedCells: 7, color: "error" as const },
			{ remainingFraction: 0.5, usedCells: 3, color: "warning" as const },
			{ remainingFraction: 1, usedCells: 0, color: "success" as const },
		];

		for (const testCase of cases) {
			const rendered = renderBattery("segmented", testCase.remainingFraction);
			const content = stripVTControlCharacters(rendered.content);

			expect(rendered.visible).toBe(true);
			expect(content).toBe(SEGMENTED_BATTERY_FULL);
			expect(rendered.content).toBe(expectedSegmentedBatteryAnsi(testCase.usedCells, testCase.color));
			expect(visibleWidth(rendered.content)).toBe(SEGMENTED_BATTERY_WIDTH);

			for (const forbiddenChar of SEGMENTED_BATTERY_FORBIDDEN_CHARS) {
				expect(content).not.toContain(forbiddenChar);
			}

			expect(content).not.toContain("anthropic");
			expect(content).not.toMatch(/\d/);
			expect(content).not.toContain("%");
		}
	});

	it("hides the segmented battery when the remaining quota fraction is unknown", () => {
		const rendered = renderBattery("segmented");

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("shows battery labels and whole-number percentage text by default, preferring the active model label for same-provider items", () => {
		const activeSession = {
			state: { messages: [], model: { contextWindow: 1000, provider: "openai-proxy", id: "gpt-5.6-sol" } },
			model: { contextWindow: 1000, provider: "openai-proxy", id: "gpt-5.6-sol" },
		} as unknown as SegmentContext["session"];
		const rendered = renderSegment(
			"usage",
			makeUsageContext(
				[
					makeUsageItem({
						provider: "openai-proxy",
						label: "5 Hour",
						modelId: "stale-model-id",
						amount: percentAmount(0.2),
						usedFraction: 0.2,
					}),
					makeUsageItem({
						provider: "openai-codex",
						label: "5 Hour",
						modelId: "gpt-5.6-luna",
						amount: percentAmount(0.1),
						usedFraction: 0.1,
					}),
				],
				{ style: "battery", batteryWidth: 5, maxItems: 2 },
				activeSession,
			),
		);
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("gpt-5.6-sol ████ 80");
		expect(content).not.toContain("stale-model-id");
		expect(content).toContain("gpt-5.6-luna ████▌ 90");
		expect(content).not.toContain("openai-codex ████▌ 90");
		expect(content).not.toContain("%");
	});

	it("truncates text style usage items at maxItems and shows a +N indicator", () => {
		const rendered = renderSegment(
			"usage",
			makeUsageContext(
				[
					makeUsageItem({ provider: "anthropic", label: "5 Hour", amount: percentAmount(0.1), usedFraction: 0.1 }),
					makeUsageItem({ provider: "cursor", label: "Monthly", amount: percentAmount(0.2), usedFraction: 0.2 }),
					makeUsageItem({ provider: "gemini", label: "Monthly", amount: percentAmount(0.3), usedFraction: 0.3 }),
				],
				{ maxItems: 2, showResetTime: false },
			),
		);
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("anthropic:5 Hour 10%");
		expect(content).toContain("cursor:Monthly 20%");
		expect(content).toContain("+1");
		expect(content).not.toContain("gemini");
	});

	it("sanitizes arbitrary provider, account, model, tier, and window labels before rendering", () => {
		const rendered = renderSegment(
			"usage",
			makeUsageContext([
				makeUsageItem({
					provider: "\u001b[31mcu\tr\nsor\u001b[0m",
					accountLabel: "acct\tone\norg",
					modelId: "gpt\n5",
					tier: "pro\tmax",
					label: "Billing\nMonth",
					amount: percentAmount(0.25),
					usedFraction: 0.25,
				}),
			]),
		);
		const content = stripVTControlCharacters(rendered.content);

		expect(content).toContain("cu r sor/acct one org/gpt 5:pro max Billing Month 25%");
		expect(content).not.toContain("\u001b[31m");
		expect(content).not.toContain("\t");
		expect(content).not.toContain("\n");
	});

	it("switches to the warning color once usage reaches eighty percent", () => {
		const high = renderSegment(
			"usage",
			makeUsageContext([
				makeUsageItem({ provider: "anthropic", label: "5 Hour", amount: percentAmount(0.8), usedFraction: 0.8 }),
			]),
		).content.replace("80%", "PCT");
		const low = renderSegment(
			"usage",
			makeUsageContext([
				makeUsageItem({ provider: "anthropic", label: "5 Hour", amount: percentAmount(0.79), usedFraction: 0.79 }),
			]),
		).content.replace("79%", "PCT");

		expect(stripVTControlCharacters(high)).toBe(stripVTControlCharacters(low));
		expect(high).not.toBe(low);
	});

	it("hides null or empty usage summaries", () => {
		const hiddenNull = renderSegment("usage", { usage: null } as unknown as SegmentContext);
		const hiddenEmpty = renderSegment("usage", { usage: { items: [] } } as unknown as SegmentContext);

		expect(hiddenNull.visible).toBe(false);
		expect(hiddenNull.content).toBe("");
		expect(hiddenEmpty.visible).toBe(false);
		expect(hiddenEmpty.content).toBe("");
	});

	it("caps rendered usage content to maxWidth by visible width", () => {
		const rendered = renderSegment(
			"usage",
			makeUsageContext(
				[
					makeUsageItem({
						provider: "anthropic",
						accountLabel: "acct-primary/org-prod",
						modelId: "claude-sonnet-4-5",
						tier: "enterprise",
						label: "Monthly Billing Window",
						amount: percentAmount(0.25),
						usedFraction: 0.25,
					}),
				],
				{ maxWidth: 10, showResetTime: false },
			),
		);

		expect(visibleWidth(rendered.content)).toBeLessThanOrEqual(10);
	});

	it("renders tiered limits with the tier label", () => {
		const result = renderSegment("usage", {
			usage: {
				tier: "prolite",
				fiveHour: { percent: 50, resetMinutes: 120 },
				sevenDay: { percent: 10, resetHours: 48 },
			},
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("prolite");
		expect(content).toContain("5h");
		expect(content).toContain("50%");
		expect(content).toContain("7d");
		expect(content).toContain("10%");
	});

	it("sanitizes tier labels before rendering", () => {
		const result = renderSegment("usage", {
			usage: {
				tier: "\u001b[31mbad\t tier\nvalue\u001b[0m",
				fiveHour: { percent: 50 },
			},
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("bad tier value");
		expect(result.content).not.toContain("\u001b[31m");
		expect(result.content).not.toContain("\t");
		expect(result.content).not.toContain("\n");
	});

	it("hides null usage", () => {
		const result = renderSegment("usage", { usage: null } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("hides usage without visible windows", () => {
		const result = renderSegment("usage", { usage: {} } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("renders five-hour usage without seven-day usage", () => {
		const result = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h");
		expect(content).toContain("80%");
		expect(content).not.toContain("7d");
	});

	it("renders monthly Cursor usage when five-hour and seven-day windows are absent", () => {
		const result = renderSegment("usage", {
			usage: { monthly: { percent: 1.88, resetHours: 743 } },
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("mo");
		// Match Cursor web dashboard flooring (1.88 → 1%), not Math.round → 2%.
		expect(content).toContain("1%");
		expect(content).not.toContain("2%");
		expect(content).toContain("30d 23h");
		expect(content).not.toContain("5h");
		expect(content).not.toContain("7d");
	});

	it("keeps monthly Cursor personal usage from the active provider", async () => {
		const component = makeComponent(
			[
				{
					provider: "cursor",
					limits: [
						{
							id: "cursor:usd:individual-plan",
							scope: { windowId: "monthly" },
							window: { id: "monthly", resetsAt: Date.now() + 743 * 3_600_000 },
							amount: { usedFraction: 0.132 },
						},
					],
				},
			],
			{ provider: "cursor" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("mo");
		expect(content).toContain("13%");
	});

	it("prefers Cursor personal dashboard rails over legacy monthly request limits", async () => {
		const component = makeComponent(
			[
				{
					provider: "cursor",
					limits: [
						{
							id: "cursor:requests:gpt-4",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.9 },
						},
						{
							id: "cursor:usd:individual-auto",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.0185 },
						},
					],
				},
			],
			{ provider: "cursor" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("mo");
		expect(content).toContain("1%");
		expect(content).not.toContain("90%");
	});

	it("renders all three OpenCode Go windows including monthly", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "opencode-go",
					limits: [
						{
							id: "rolling-5h",
							scope: { windowId: "5h" },
							window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: now + 90 * 60_000 },
							amount: { used: 12, usedFraction: 0.12, unit: "percent" },
						},
						{
							id: "weekly",
							scope: { windowId: "7d" },
							window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: now + 100 * 3_600_000 },
							amount: { used: 8, usedFraction: 0.08, unit: "percent" },
						},
						{
							id: "monthly",
							scope: { windowId: "monthly" },
							window: { id: "monthly", resetsAt: now + 160 * 3_600_000 },
							amount: { used: 42, usedFraction: 0.42, unit: "percent" },
						},
					],
				},
			],
			{ provider: "opencode-go" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("12%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).toContain("mo");
		expect(content).toContain("42%");
	});

	it("does not render monthly usage for providers outside the single-bucket gate", async () => {
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [{ id: "copilot:premium", scope: { windowId: "monthly" }, amount: { usedFraction: 0.42 } }],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("mo");
		expect(content).not.toContain("42%");
	});

	it("uses a distinct error color at the eighty-percent threshold", () => {
		const high = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const low = renderSegment("usage", { usage: { fiveHour: { percent: 24 } } } as unknown as SegmentContext);
		const highWithoutValue = high.content.replace("80%", "PCT");
		const lowWithoutValue = low.content.replace("24%", "PCT");

		expect(high.visible).toBe(true);
		expect(low.visible).toBe(true);
		expect(stripVTControlCharacters(highWithoutValue)).toBe(stripVTControlCharacters(lowWithoutValue));
		expect(highWithoutValue).not.toBe(lowWithoutValue);
	});

	it("maps non-canonical window ids onto subscription windows by reported span", async () => {
		// Kimi-shaped rows: the burst window reports duration/timeUnit instead
		// of a canonical id, and rows written before canonicalization keep the
		// old id. The reported span still identifies the window.
		const now = Date.now();
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "300time_unit_minute" },
						window: { durationMs: 5 * 3_600_000, resetsAt: now + 30 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "weekly" },
						window: { durationMs: 7 * 86_400_000, resetsAt: now + 141 * 3_600_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("ignores non-canonical windows without a reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{ scope: { windowId: "default" }, window: {}, amount: { usedFraction: 0.24 } },
					{
						scope: { windowId: "monthly" },
						window: { durationMs: 30 * 86_400_000 },
						amount: { usedFraction: 0.5 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("24%");
		expect(content).not.toContain("50%");
	});

	it("prefers canonical window ids over a conflicting reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "5h" },
						window: { durationMs: 7 * 86_400_000 },
						amount: { usedFraction: 0.24 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).not.toContain("7d");
	});
});
