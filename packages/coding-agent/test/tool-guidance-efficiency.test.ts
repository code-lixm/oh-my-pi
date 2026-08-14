import { describe, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import bashPrompt from "../src/prompts/tools/bash.md" with { type: "text" };
import fffGrepPrompt from "../src/prompts/tools/fff-grep.md" with { type: "text" };
import findPrompt from "../src/prompts/tools/find.md" with { type: "text" };
import multiGrepPrompt from "../src/prompts/tools/multi-grep.md" with { type: "text" };

const bash = prompt.render(bashPrompt, {
	asyncEnabled: true,
	autoBackgroundEnabled: true,
	autoBackgroundThresholdSeconds: 60,
	hasAstEdit: true,
	hasAstGrep: true,
	hasFind: true,
	hasGrep: true,
	hasLaunch: true,
	hasRead: true,
	hasShellBuiltins: true,
	isWindows: false,
});

const find = prompt.render(findPrompt);
const grep = prompt.render(fffGrepPrompt);
const multiGrep = prompt.render(multiGrepPrompt);

describe("tool guidance efficiency", () => {
	test("keeps the corrected guidance smaller than the previous prompt set", () => {
		expect(bash.length + find.length + grep.length + multiGrep.length).toBeLessThan(4_000);
	});
});
