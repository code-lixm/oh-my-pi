import { describe, expect, it } from "bun:test";
import { shouldUseNativeInput } from "@oh-my-pi/pi-tui/native-input";

describe("shouldUseNativeInput", () => {
	for (const platform of ["darwin", "linux"] as const) {
		it(`activates native stdin ownership on a direct ${platform} TTY`, () => {
			expect(shouldUseNativeInput({ platform, stdinIsTTY: true, env: {} })).toBe(true);
		});
	}

	const javascriptFallbackCases: Array<{
		name: string;
		platform: NodeJS.Platform;
		stdinIsTTY: boolean;
		env: NodeJS.ProcessEnv;
	}> = [
		{ name: "Windows terminals", platform: "win32", stdinIsTTY: true, env: {} },
		{ name: "a non-TTY stdin stream", platform: "linux", stdinIsTTY: false, env: {} },
		{ name: "tmux sessions", platform: "linux", stdinIsTTY: true, env: { TMUX: "/tmp/tmux-1000/default,1,0" } },
		{ name: "screen sessions", platform: "linux", stdinIsTTY: true, env: { TERM: "screen-256color" } },
		{ name: "Zellij sessions", platform: "linux", stdinIsTTY: true, env: { ZELLIJ: "session" } },
		{
			name: "the numeric native-input kill switch",
			platform: "darwin",
			stdinIsTTY: true,
			env: { PI_TUI_NATIVE_INPUT: "0" },
		},
		{
			name: "the false native-input kill switch",
			platform: "darwin",
			stdinIsTTY: true,
			env: { PI_TUI_NATIVE_INPUT: "false" },
		},
	];

	for (const { name, platform, stdinIsTTY, env } of javascriptFallbackCases) {
		it(`keeps the JavaScript stdin path for ${name}`, () => {
			expect(shouldUseNativeInput({ platform, stdinIsTTY, env })).toBe(false);
		});
	}
});
