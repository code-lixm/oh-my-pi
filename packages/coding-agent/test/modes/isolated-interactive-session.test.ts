import { describe, expect, test } from "bun:test";
import { buildIsolatedChildArgs } from "../../src/modes/isolated-interactive-session";

describe("buildIsolatedChildArgs", () => {
	test("drops raw provider, model, and credential flags while retaining other agent and extension flags", () => {
		const args = buildIsolatedChildArgs(
			[
				"--cwd",
				"/foreground/navigated-worktree",
				"--mode",
				"print",
				"--session",
				"/foreground/previous.jsonl",
				"--continue",
				"previous-session-id",
				"--resume",
				"/foreground/resume.jsonl",
				"--new",
				"draft a release checklist",
				"@README.md",
				"--provider",
				"raw-provider-split",
				"--provider=raw-provider-equals",
				"--model",
				"raw-model-split",
				"--model=raw-model-equals",
				"--api-key",
				"secret-from-split-flag",
				"--api-key=secret-from-equals-flag",
				"--extension",
				"/extensions/explicit.ts",
				"--trusted-extension",
				"/extensions/trusted.ts",
				"--no-skills",
				"--add-dir",
				"/workspace/additional-root",
				"--review-depth",
				"raw-value-must-not-win",
				"--enforce-policy",
			],
			new Map<string, boolean | string>([
				["review-depth", "deep"],
				["enforce-policy", true],
			]),
		);

		expect(args).toEqual([
			"--extension",
			"/extensions/explicit.ts",
			"--trusted-extension",
			"/extensions/trusted.ts",
			"--no-skills",
			"--add-dir",
			"/workspace/additional-root",
			"--review-depth",
			"deep",
			"--enforce-policy",
		]);
	});
});
