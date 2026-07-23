import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../config/settings";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "../../../tui/output-block";
import { theme as activeTheme, getThemeByName, setThemeInstance, type Theme } from "../../theme/theme";
import { createAdvisorMessageCard } from "../advisor-message";
import { AssistantMessageComponent } from "../assistant-message";

const stripAnsi = (text: string): string => Bun.stripANSI(text).replace(/\x1b\]133;[AB]\x07/g, "");

describe("AssistantMessageComponent", () => {
	let uiTheme: Theme;
	let previousTheme: Theme | undefined;
	let previousBorderStyle: OutputBlockBorderStyle;

	beforeAll(async () => {
		previousTheme = activeTheme;
		previousBorderStyle = getOutputBlockBorderStyle();
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
		setOutputBlockBorderStyle("full");
	});

	afterAll(() => {
		if (previousTheme) setThemeInstance(previousTheme);
		setOutputBlockBorderStyle(previousBorderStyle);
	});

	it("renders prose, fenced code frames, and advisor frames in the shared x=1 gutter", () => {
		const prose = "Plain prose starts here";
		const message = {
			role: "assistant",
			content: [{ type: "text", text: `${prose}\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`` }],
			timestamp: 1,
		} as unknown as AssistantMessage;

		for (const width of [30, 80] as const) {
			const assistant = new AssistantMessageComponent(message);
			const assistantLines = assistant.render(width);
			const plainAssistantLines = assistantLines.map(stripAnsi);
			const topLeft = uiTheme.symbol("boxRound.topLeft");
			const topRight = uiTheme.symbol("boxRound.topRight");
			const codeFrameTopRow = plainAssistantLines.find(
				line => line.indexOf(topLeft) >= 0 && line.trimEnd().endsWith(topRight),
			);
			if (!codeFrameTopRow) throw new Error(`missing framed code row at width ${width}`);

			const advisorTopRow = stripAnsi(
				createAdvisorMessageCard({ notes: [{ note: "framed card" }] }, uiTheme).render(width)[0]!,
			);
			const proseRow = plainAssistantLines.find(line => line.includes(prose));
			if (!proseRow) throw new Error(`missing prose row at width ${width}`);

			expect(proseRow.indexOf(prose)).toBe(1);
			expect(codeFrameTopRow.indexOf(topLeft)).toBe(1);
			expect(advisorTopRow.indexOf(topLeft)).toBe(1);
			expect(codeFrameTopRow.indexOf(topLeft)).toBe(advisorTopRow.indexOf(topLeft));
			expect(assistantLines.map(line => visibleWidth(line) <= width)).toEqual(
				Array(assistantLines.length).fill(true),
			);
		}
	});
});
