import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSettingsUiLocale, setSettingsUiLocale } from "../src/i18n/settings-locale";

let previousLocale = getSettingsUiLocale();

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
});

afterEach(() => {
	setSettingsUiLocale(previousLocale);
	vi.restoreAllMocks();
});

function createFixture() {
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		settings: { get: vi.fn(() => false) },
		ui: { requestComponentRender: vi.fn() },
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		viewSession: { isStreaming: false, activity: undefined },
		session: { isAborting: false },
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		showStatus,
		showWarning,
		showError,
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), showStatus, showWarning, showError };
}

const restoredEvent = {
	type: "retry_fallback_restored",
	from: "fallback",
	to: "primary",
	role: "default",
} satisfies Extract<AgentSessionEvent, { type: "retry_fallback_restored" }>;

const recoveryNotices = [
	{
		name: "English",
		locale: "en",
		expected: "Primary endpoint recovered: fallback -> primary",
	},
	{
		name: "Chinese",
		locale: "zh-CN",
		expected: "主端点已恢复：fallback → primary",
	},
] as const;

describe("EventController primary endpoint recovery", () => {
	for (const { name, locale, expected } of recoveryNotices) {
		it(`shows the ${name} recovery notice on the status channel`, async () => {
			setSettingsUiLocale(locale);
			const { controller, showStatus, showWarning, showError } = createFixture();

			try {
				await controller.handleEvent(restoredEvent);

				expect(showStatus.mock.calls).toEqual([[expected]]);
				expect(showWarning).not.toHaveBeenCalled();
				expect(showError).not.toHaveBeenCalled();
			} finally {
				controller.dispose();
			}
		});
	}
});
