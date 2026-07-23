import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const WIDTH = 40;

describe("UserMessageComponent visual contract", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders ordinary user text on the user message background while keeping transcript spacing", () => {
		const expectedBg = theme.getBgAnsi("userMessageBg");
		const lines = new UserMessageComponent("Ship the fix.").render(WIDTH);
		const withoutZones = lines.map(line => line.replace(/\x1b\]133;[AB]\x07/g, ""));
		const raw = withoutZones.join("\n");
		const plain = withoutZones.map(line => Bun.stripANSI(line));

		expect(expectedBg).toMatch(/\x1b\[48;/);
		expect(raw).toContain(expectedBg);
		expect(withoutZones.every(line => line.startsWith(expectedBg) && line.endsWith("\x1b[49m"))).toBe(true);
		expect(lines[0]!.startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines.at(-1)!.endsWith(OSC133_ZONE_END)).toBe(true);
		expect(withoutZones.map(line => visibleWidth(line))).toEqual([WIDTH, WIDTH, WIDTH]);
		expect(plain).toEqual([
			" ".repeat(WIDTH),
			` Ship the fix. ${" ".repeat(WIDTH - " Ship the fix. ".length)}`,
			" ".repeat(WIDTH),
		]);
	});
});
