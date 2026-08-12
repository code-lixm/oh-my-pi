import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import {
	getCurrentThemeName,
	getEditorTheme,
	getThemeByName,
	initTheme,
	previewTheme,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	Settings.instance.set("tui.hyperlinks", "always");
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function render(text: string): string {
	return new UserMessageComponent(text).render(80).join("\n");
}

const stripUserControls = (text: string) => Bun.stripANSI(text).replace(/\x1b\]133;[AB]\x07/g, "");
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]|10[0-7]|48;(?:5;\d+|2;\d+;\d+;\d+))m/;
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("UserMessageComponent magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the rendered (sent) message bubble", () => {
		const raw = render("please orchestrate the rollout");
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted: a per-character foreground sequence is emitted,
		// and the word no longer survives as a contiguous run in the rendered bytes.
		expect(raw).toContain("\x1b[38");
		expect(raw).not.toContain("orchestrate");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = render("ship the `orchestrate` helper");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		// Code spans render through the code style as a single run — the word stays intact.
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = render("intro\n```\norchestrate\n```");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		expect(raw).toContain("orchestrate");
	});

	it("renders fenced JSON and YAML with syntax colors on an unbroken terminal-adaptive bubble", async () => {
		const previousThemeName = getCurrentThemeName();
		if (!previousThemeName) throw new Error("Expected the UserMessage test theme to be initialized");
		let themeRestored = false;

		try {
			const preview = await previewTheme("light-terminal-adaptive");
			expect(preview.success).toBe(true);

			const bubbleBackground = theme.getBgAnsi("userMessageBg");
			expect(bubbleBackground).toBe("\x1b[48;5;15m");

			const codeLines = [
				'{"feature":"fenced-code","retries":3,"enabled":true}',
				"service:",
				"  retries: 3",
				"  enabled: false",
			];
			const rendered = new UserMessageComponent(
				["Payloads:", "```json", codeLines[0], "```", "```yaml", ...codeLines.slice(1), "```"].join("\n"),
			).render(80);
			const plain = stripUserControls(rendered.join("\n"));

			expect(plain).not.toContain("```");
			expect(plain).not.toContain("json");
			expect(plain).not.toContain("yaml");

			const codeRows = codeLines.map(codeLine => {
				const row = rendered.find(line => stripUserControls(line).includes(codeLine));
				if (row === undefined) throw new Error(`Expected rendered code row: ${codeLine}`);
				return row;
			});
			expect(codeRows.map(row => codeLines.find(codeLine => stripUserControls(row).includes(codeLine)))).toEqual(
				codeLines,
			);

			const syntaxColors = [
				"syntaxComment",
				"syntaxKeyword",
				"syntaxFunction",
				"syntaxVariable",
				"syntaxString",
				"syntaxNumber",
				"syntaxType",
				"syntaxOperator",
				"syntaxPunctuation",
			] as const;
			const syntaxForegrounds = new Set(
				codeRows.flatMap(row =>
					(row.match(/\x1b\[(?:3[0-7]|38;5;\d+|38;2;\d+;\d+;\d+)m/g) ?? []).filter(ansi =>
						syntaxColors.some(color => theme.getFgAnsi(color) === ansi),
					),
				),
			);
			expect(syntaxForegrounds.size).toBeGreaterThanOrEqual(2);

			for (const row of codeRows) {
				expect(row.startsWith(bubbleBackground)).toBe(true);
				expect(visibleWidth(row)).toBe(80);
				expect(row.endsWith("\x1b[49m")).toBe(true);

				for (const reset of row.matchAll(/\x1b\[(?:0|49)m/g)) {
					const nextOffset = reset.index! + reset[0].length;
					const isFinalBubbleReset = reset[0] === "\x1b[49m" && nextOffset === row.length;
					if (!isFinalBubbleReset) expect(row.slice(nextOffset).startsWith(bubbleBackground)).toBe(true);
				}
			}
		} finally {
			themeRestored = (await previewTheme(previousThemeName)).success;
		}
		expect(themeRestored).toBe(true);
	});

	it("closes OSC 133 prompt zones without opening a command-output zone", () => {
		const raw = render("first line\nsecond line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw).toContain("\x1b]133;B\x07");
		// #8030: the command-start marker is required. Terminals latch a sticky
		// `.input` cursor semantic on 133;B that only 133;C clears; without it every
		// later cell stays tagged as prompt input and click-to-move injects arrow
		// keys into the pty.
		expect(raw).toContain("\x1b]133;C\x07");
		// ...but the zone is closed inside the same render, so terminals still cannot
		// group later assistant/tool output under the submitted prompt.
		expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		// Exactly one balanced command zone per bubble.
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("closes the OSC 133 command zone for a single-line message too", () => {
		const raw = render("only line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("bolds and underlines image references in the rendered message bubble", () => {
		const raw = render("please inspect [Image #1] before continuing");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b[1m");
		expect(raw).toContain("\x1b[4m");
	});

	it("wraps image references in file hyperlinks when a blob path is available", () => {
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		const raw = new UserMessageComponent("please inspect [Image #1]", false, [imagePath]).render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("wraps draft editor image references in file hyperlinks when a blob path is available", () => {
		const editor = new CustomEditor(getEditorTheme());
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("please inspect [Image #1]");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("rebuilds user messages with image hyperlinks when image links are not precomputed", () => {
		const displayPath = path.resolve("/tmp/abc123.png");
		const displayUri = url.pathToFileURL(path.resolve(displayPath)).href;
		const chatContainer = new Container();
		const sessionManagerMock = {
			putBlobSync: () => ({
				hash: "abc123",
				path: path.resolve("/tmp/abc123"),
				displayPath,
				get ref() {
					return "blob:sha256:abc123";
				},
			}),
		};
		const helpers = new UiHelpers({
			chatContainer,
			getUserMessageText: () => "please inspect [Image #1]",
			sessionManager: sessionManagerMock,
			viewSession: { sessionManager: sessionManagerMock },
			transcriptMessageComponents: new WeakMap(),
		} as unknown as InteractiveModeContext);
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "please inspect [Image #1]" },
				{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};

		helpers.addMessageToChat(message);
		const component = chatContainer.children.at(-1);
		if (!component) throw new Error("Expected user message component to be appended");
		const raw = component.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(displayUri);
	});

	it("highlights paste markers in the draft editor without a hyperlink", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("see [Paste #1, +30 lines] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Paste #1, +30 lines]");
		// The marker label is bold-wrapped (highlighted), unlike surrounding plain text.
		expect(raw).toContain("\x1b[1m[Paste #1, +30 lines]");
		// Paste markers are not clickable, so no OSC-8 hyperlink is emitted (contrast with images).
		expect(raw).not.toContain("\x1b]8;id=");
	});

	it("hyperlinks the metadata-bearing image marker format", () => {
		const editor = new CustomEditor(getEditorTheme());
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("see [Image #1, 800x600] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1, 800x600]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("uses a full rounded frame without accent rail, tint, or bubble background for image placeholders under accent output styling", async () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		try {
			setOutputBlockBorderStyle("accent");
			const theme = await getThemeByName("dark");
			expect(theme).toBeDefined();
			const uiTheme = theme!;
			const rendered = new UserMessageComponent("see [Image #1, 2024x464] now").render(80);
			const plain = rendered.map(stripUserControls);

			expect(plain[0]?.trimStart().startsWith(uiTheme.boxRound.topLeft)).toBe(true);
			expect(plain[0]?.trimEnd().endsWith(uiTheme.boxRound.topRight)).toBe(true);
			expect(plain.at(-1)?.trimStart().startsWith(uiTheme.boxRound.bottomLeft)).toBe(true);
			expect(plain.at(-1)?.trimEnd().endsWith(uiTheme.boxRound.bottomRight)).toBe(true);
			expect(plain.map(line => visibleWidth(line))).toEqual(Array(plain.length).fill(80));
			expect(rendered.every(line => !BACKGROUND_SGR.test(line))).toBe(true);
			const bodyLine = plain.find(line => line.includes("[Image #1, 2024x464]"));
			expect(bodyLine).toBeDefined();
			expect(bodyLine?.trimStart().startsWith(uiTheme.boxRound.vertical)).toBe(true);
			expect(bodyLine?.trimEnd().endsWith(uiTheme.boxRound.vertical)).toBe(true);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("keeps ordinary text messages on the existing bubble background under accent output styling without adding a rounded frame", async () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		try {
			setOutputBlockBorderStyle("accent");
			const theme = await getThemeByName("dark");
			expect(theme).toBeDefined();
			const uiTheme = theme!;
			const rendered = new UserMessageComponent("plain user text").render(80);
			const plain = rendered.map(stripUserControls);

			expect(rendered.some(line => line.includes(uiTheme.getBgAnsi("userMessageBg")))).toBe(true);
			expect(plain[0]?.trimStart().startsWith(uiTheme.boxRound.topLeft)).toBe(false);
			expect(plain.at(-1)?.trimEnd().endsWith(uiTheme.boxRound.bottomRight)).toBe(false);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});
});
