import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { createAdvisorMessageCard } from "../../../src/modes/components/advisor-message";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { theme as activeTheme, getThemeByName, setThemeInstance, type Theme } from "../../../src/modes/theme/theme";
import {
	getOutputBlockBorderStyle,
	type OutputBlockBorderStyle,
	setOutputBlockBorderStyle,
} from "../../../src/tui/output-block";

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
				createAdvisorMessageCard({ notes: [{ note: "framed card" }] }, () => true, uiTheme).render(width)[0]!,
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

	it("keeps fallback image bytes stable and opens the original image", () => {
		const previousProtocol = TERMINAL.imageProtocol;
		TERMINAL.imageProtocol = null;
		try {
			const image = { type: "image" as const, data: "b3JpZ2luYWw=", mimeType: "image/webp" };
			const message = { role: "assistant", content: [image], timestamp: 1 } as unknown as AssistantMessage;
			const baseline = new AssistantMessageComponent(message).render(40);
			const opened: (typeof image)[] = [];
			const component = new AssistantMessageComponent(message, false, undefined, [], undefined, false, {
				openImage: value => opened.push(value as typeof image),
			});
			const lines = component.render(40);
			expect(lines).toEqual(baseline);

			const row = lines.findIndex(line => Bun.stripANSI(line).includes("[Image:"));
			const col = Bun.stripANSI(lines[row]!).indexOf("[Image:");
			const event = {
				button: 0,
				col,
				row,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			};
			expect(component.routeMouse(event, row, col)).not.toBe(false);
			expect(opened).toEqual([image]);
		} finally {
			TERMINAL.imageProtocol = previousProtocol;
		}
	});
});
