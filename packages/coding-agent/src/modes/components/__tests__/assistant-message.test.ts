import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../theme/theme";
import { createAdvisorMessageCard } from "../advisor-message";
import { AssistantMessageComponent } from "../assistant-message";

const stripAnsi = (text: string): string => Bun.stripANSI(text).replace(/\x1b\]133;[AB]\x07/g, "");

describe("AssistantMessageComponent", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("renders fenced code frames flush with the framed-card left edge", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "```ts\nconst answer = 42;\n```" }],
			timestamp: 1,
		} as unknown as AssistantMessage;

		for (const width of [30, 80] as const) {
			const assistant = new AssistantMessageComponent(message);
			const assistantLines = assistant.render(width);
			const plainAssistantLines = assistantLines.map(stripAnsi);
			const codeFrameTopRow = plainAssistantLines.find(
				line =>
					line.startsWith(uiTheme.symbol("boxRound.topLeft")) &&
					line.endsWith(uiTheme.symbol("boxRound.topRight")),
			);
			if (!codeFrameTopRow) throw new Error(`missing framed code row at width ${width}`);

			const advisorTopRow = stripAnsi(
				createAdvisorMessageCard({ notes: [{ note: "framed card" }] }, uiTheme).render(width)[0]!,
			);

			expect(codeFrameTopRow[0]).toBe(uiTheme.symbol("boxRound.topLeft"));
			expect(advisorTopRow[0]).toBe(uiTheme.symbol("boxRound.topLeft"));
			expect(codeFrameTopRow.startsWith(" ")).toBe(false);
			expect(assistantLines.map(line => visibleWidth(line))).toEqual(Array(assistantLines.length).fill(width));
		}
	});
});
