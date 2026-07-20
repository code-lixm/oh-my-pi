import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../i18n/settings-locale";
import type { FileMentionMessage } from "../../session/messages";
import { initTheme } from "../theme/theme";
import { assistantUsageIsBilled, buildFileMentionBlock } from "./transcript-render-helpers";

let previousLocale = getSettingsUiLocale();

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
});

afterEach(() => {
	setSettingsUiLocale(previousLocale);
});

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("buildFileMentionBlock", () => {
	it("keeps transcript read summaries on the literal lowercase tool name in en and zh-CN", () => {
		const files = [{ path: "src/example.ts", lineCount: 12 }] as FileMentionMessage["files"];

		setSettingsUiLocale("en");
		const english = Bun.stripANSI(buildFileMentionBlock(files, 0).render(80).join("\n"));
		expect(english).toContain("read src/example.ts");
		expect(english).not.toContain("Read src/example.ts");

		setSettingsUiLocale("zh-CN");
		const chinese = Bun.stripANSI(buildFileMentionBlock(files, 0).render(80).join("\n"));
		expect(chinese).toContain("read src/example.ts");
		expect(chinese).not.toContain("读取 src/example.ts");
	});
});

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});
