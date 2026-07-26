import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatDefaultToolExecution } from "../../src/tools/default-renderer";

const plainOutputLines = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	settings.clearOverride("display.toolDetailMaxLines");
});

afterAll(() => {
	resetSettingsForTest();
});

async function renderLines(expanded: boolean): Promise<string[]> {
	const uiTheme = await getThemeByName("dark");
	expect(uiTheme).toBeDefined();

	return Bun.stripANSI(
		formatDefaultToolExecution(
			{
				label: "Tool",
				args: undefined,
				result: { output: plainOutputLines.join("\n"), isError: false },
				options: { expanded, isPartial: false },
			},
			120,
			uiTheme!,
		),
	)
		.split("\n")
		.map(line => line.trimEnd());
}

describe("formatDefaultToolExecution plain output detail budgets", () => {
	it("defaults collapsed plain output to a strict three-line body that keeps the first and last rows", async () => {
		const plainLines = await renderLines(false);
		const [header, ...bodyLines] = plainLines;

		expect(header).toContain("Tool");
		expect(bodyLines).toHaveLength(3);
		expect(bodyLines).toEqual(["alpha", "… 5 lines omitted", "eta"]);
	});

	it("keeps expanded plain output fully visible", async () => {
		const plainLines = await renderLines(true);

		expect(plainLines[0]).toContain("Tool");
		expect(plainLines.slice(1)).toEqual(plainOutputLines);
	});

	it("honors display.toolDetailMaxLines overrides for collapsed plain output", async () => {
		settings.override("display.toolDetailMaxLines", 5);
		const plainLines = await renderLines(false);
		const bodyLines = plainLines.slice(1);

		expect(bodyLines).toHaveLength(5);
		expect(bodyLines).toEqual(["alpha", "beta", "… 3 lines omitted", "zeta", "eta"]);
	});
});
