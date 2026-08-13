import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const OSC133_MARKER = /\x1b\]133;(?:A|B|C|D;0)\x07/g;
const WIDTH = 40;
function stripUserControls(line: string): string {
	return Bun.stripANSI(line.replace(OSC133_MARKER, ""));
}

function expectBorderlessBackgroundBlock(rendered: readonly string[], content: string): void {
	const plain = rendered.map(stripUserControls);
	const background = theme.getBgAnsi("userMessageBg");

	expect(plain).toHaveLength(3);
	expect(plain.map(line => visibleWidth(line))).toEqual(Array(plain.length).fill(WIDTH));
	expect(plain[0]).toBe(" ".repeat(WIDTH));
	expect(plain[1]?.indexOf(content)).toBe(1);
	expect(plain[2]).toBe(" ".repeat(WIDTH));
	expect(rendered.every(line => line.includes(background))).toBe(true);

	for (const glyph of [
		theme.boxRound.topLeft,
		theme.boxRound.topRight,
		theme.boxRound.bottomLeft,
		theme.boxRound.bottomRight,
		theme.boxRound.horizontal,
		theme.boxRound.vertical,
		"▌",
	]) {
		expect(plain.join("\n")).not.toContain(glyph);
	}
}

describe("UserMessageComponent visual contract", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders ordinary text and image placeholders as matching borderless background blocks", () => {
		const ordinary = new UserMessageComponent("Ship the fix.").render(WIDTH);
		const image = new UserMessageComponent("Inspect [Image #1]").render(WIDTH);

		expectBorderlessBackgroundBlock(ordinary, "Ship the fix.");
		expectBorderlessBackgroundBlock(image, "Inspect [Image #1]");
		expect(ordinary.map(stripUserControls).map(line => visibleWidth(line))).toEqual(
			image.map(stripUserControls).map(line => visibleWidth(line)),
		);
	});

	it("routes Markdown links from rendered coordinates in ordinary and image-placeholder messages", () => {
		const hrefs: string[] = [];
		for (const { name, text } of [
			{ name: "ordinary message", text: "[open](https://example.com)" },
			{ name: "image-placeholder message", text: "[Image #1]\n\n[open](https://example.com)" },
		]) {
			const component = new UserMessageComponent(text, false, undefined, href => hrefs.push(href));
			const lines = component.render(WIDTH);
			const plain = lines.map(stripUserControls);
			const row = plain.findIndex(line => line.includes("open"));
			if (row === -1) throw new Error(`Expected link row for ${name}`);
			const col = plain[row]!.indexOf("open");
			const event = {
				button: 0,
				col,
				row,
				release: false,
				wheel: null,
				motion: false,
				leftClick: true,
			};

			expect(col).toBe(1);
			expect(component.routeMouse(event, row, col)).toBe(true);
		}

		expect(hrefs).toEqual(["https://example.com", "https://example.com"]);
	});
});
