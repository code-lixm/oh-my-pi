import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const uiStub = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

let previousLocale = getSettingsUiLocale();

describe("ModelSelectorComponent locale", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
		setSettingsUiLocale(previousLocale);
	});

	it("renders zh-CN temporary hint after locale is switched at runtime", async () => {
		previousLocale = getSettingsUiLocale();
		try {
			await Settings.init({ inMemory: true });

			setSettingsUiLocale("en");
			const models: Model[] = [];
			const modelRegistryFixture: Pick<
				ModelRegistry,
				| "getAll"
				| "getAvailable"
				| "getError"
				| "refresh"
				| "refreshProvider"
				| "getDiscoverableProviders"
				| "getProviderDiscoveryState"
			> = {
				getAll: () => models,
				getAvailable: () => models,
				getError: () => undefined,
				refresh: async () => {},
				refreshProvider: async () => {},
				getDiscoverableProviders: () => [],
				getProviderDiscoveryState: () => undefined,
			};

			const component = new ModelSelectorComponent(
				uiStub,
				undefined,
				Settings.instance,
				modelRegistryFixture as unknown as ModelRegistry,
				[],
				() => {},
				() => {},
				{ temporaryOnly: true },
			);

			const englishOutput = Bun.stripANSI(component.render(80).join("\n"));
			expect(englishOutput).toContain("Temporary model selection");
			expect(englishOutput).not.toContain("临时模型");

			setSettingsUiLocale("zh-CN");
			const chineseOutput = Bun.stripANSI(component.render(80).join("\n"));
			expect(chineseOutput).not.toContain("Temporary model selection");
			expect(chineseOutput).toContain("临时模型");
			expect(chineseOutput).toContain("Alt+M");
			expect(chineseOutput).toContain("default");
			expect(chineseOutput).toContain("slow");
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});
});
