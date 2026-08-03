import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexNativePrompt } from "@oh-my-pi/pi-ai/types";
import type { CodexPromptProfile } from "@oh-my-pi/pi-catalog/types";
import {
	type BuildSystemPromptOptions,
	type BuildSystemPromptResult,
	buildSystemPrompt,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getDefault } from "../src/config/settings-schema";
import { getPromptLocale, type PromptLocale, setPromptLocale } from "../src/prompts/prompt-locale";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

type NativePromptMode = "off" | "shadow" | "on";

type NativePromptBuildOptions = BuildSystemPromptOptions & {
	codexPromptMode: "off" | "shadow" | "on";
	codexPromptProfile?: CodexPromptProfile;
};

type NativePromptBuildResult = BuildSystemPromptResult & {
	codexNativePrompt?: CodexNativePrompt;
};

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const PROFILE: CodexPromptProfile = {
	modelId: "gpt-5.6-terra",
	baseInstructions: "VENDOR BASE: preserve this byte sequence exactly.",
	modelMessages: {
		instructionsTemplate: null,
		instructionsVariables: null,
		approvals: null,
		collaborationModes: null,
		autoReview: null,
		permissions: null,
		tokenBudget: null,
	},
	compHash: "vendor-comp-hash-terra",
	vendorDigest: "vendor-digest-terra",
	source: "openai-codex",
};

/**
 * These are behavioral fixtures, not copies of prompt source. Their distinct
 * roles and contents make role loss, reordering, and accidental string
 * concatenation observable without source-text assertions.
 */
describe("Codex native system-prompt modes", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let previousPromptLocale: PromptLocale;

	beforeEach(() => {
		previousPromptLocale = getPromptLocale();
		setPromptLocale("en");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-native-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-native-prompt-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(() => {
		setPromptLocale(previousPromptLocale);
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	async function build(
		mode: NativePromptMode,
		overrides: Partial<NativePromptBuildOptions> = {},
	): Promise<NativePromptBuildResult> {
		const options: NativePromptBuildOptions = {
			cwd: tempDir,
			contextFiles: [
				{ path: path.join(tempDir, "AGENTS.md"), content: "PROJECT CONTEXT: prefer the repository contract." },
			],
			skills: [],
			rules: [],
			toolNames: ["read", "edit"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			activeRepoContext: null,
			model: `openai-codex/${PROFILE.modelId}`,
			includeModelInPrompt: false,
			codexPromptMode: mode,
			codexPromptProfile: PROFILE,
			...overrides,
		};
		return (await buildSystemPrompt(options)) as NativePromptBuildResult;
	}
	it("keeps native prompt and communication policies opt-in by default", () => {
		expect(getDefault("providers.codex.nativePrompt")).toBe("off");
		expect(getDefault("communication.nextSteps")).toBe("off");
		expect(getDefault("communication.progressUpdates")).toBe("off");
		expect(getDefault("communication.nextStepNumberResolver")).toBe(false);
	});

	it("keeps the canonical fallback unchanged for explicit off and shadow modes", async () => {
		const off = await build("off");
		const shadow = await build("shadow");

		expect(off.codexNativePrompt).toBeUndefined();
		expect(shadow.codexNativePrompt).toBeUndefined();
		expect(shadow.systemPrompt).toEqual(off.systemPrompt);
	});
	it("applies enabled behavior policies to the canonical fallback without native eligibility", async () => {
		const fallback = await build("off", { nextSteps: "auto", progressUpdates: "auto" });
		const rendered = fallback.systemPrompt.join("\n");
		expect(rendered).toContain("next_step_offer");
		expect(rendered).toContain("entering verification");
	});

	it("attaches one complete native sidecar only when explicit on is eligible", async () => {
		const fallback = await build("off");
		const enabled = await build("on");
		const sidecar = enabled.codexNativePrompt;
		if (!sidecar) throw new Error("Expected an eligible Codex native prompt sidecar");

		// The generic prompt remains a complete fallback rather than a partially
		// rewritten hybrid, while the native payload preserves upstream structure.
		expect(enabled.systemPrompt).toEqual(fallback.systemPrompt);
		expect(sidecar.instructions).toBe(PROFILE.baseInstructions);
		expect(sidecar.modelMessages).toEqual(PROFILE.modelMessages);
		expect(sidecar.vendorDigest).toBe(PROFILE.vendorDigest);
		expect(sidecar.promptFingerprint).not.toBe(sidecar.fallbackFingerprint);
		const developerPrompt = sidecar.developerFragments.join("\n");
		expect(developerPrompt).toContain("NEVER call `apply_patch`");
		expect(developerPrompt).toContain("NEVER substitute `cat`");
		expect(sidecar.developerFragments).not.toContain(fallback.systemPrompt[0]);
		expect(sidecar.contextualUserFragments).toContain("PROJECT CONTEXT: prefer the repository contract.");
	});

	it("falls back as a whole when an explicit custom system prompt replaces the canonical prompt", async () => {
		const customPrompt = "CUSTOM OPERATOR CONTRACT: retain this caller-owned prompt.";
		const rendered = await build("on", { customPrompt });

		expect(rendered.codexNativePrompt).toBeUndefined();
		expect(rendered.systemPrompt.join("\n\n")).toContain(customPrompt);
	});

	it("does not expose a partial native profile when its exact model identity is incompatible", async () => {
		const incompatible = await build("on", {
			codexPromptProfile: { ...PROFILE, modelId: "gpt-5.6-sol" },
		});
		const fallback = await build("off", {
			codexPromptProfile: { ...PROFILE, modelId: "gpt-5.6-sol" },
		});

		expect(incompatible.codexNativePrompt).toBeUndefined();
		expect(incompatible.systemPrompt).toEqual(fallback.systemPrompt);
	});

	it("rotates the sidecar fingerprint when vendor provenance changes", async () => {
		const original = await build("on");
		const changed = await build("on", {
			codexPromptProfile: {
				...PROFILE,
				modelMessages: {
					...PROFILE.modelMessages,
					collaborationModes: { default: "changed provenance", plan: null },
				},
				vendorDigest: "vendor-digest-terra-changed",
			},
		});
		const originalSidecar = original.codexNativePrompt;
		const changedSidecar = changed.codexNativePrompt;
		if (!originalSidecar || !changedSidecar) throw new Error("Expected eligible native sidecars");

		expect(changedSidecar.modelMessages).toEqual({
			...PROFILE.modelMessages,
			collaborationModes: { default: "changed provenance", plan: null },
		});
		expect(changedSidecar.promptFingerprint).not.toBe(originalSidecar.promptFingerprint);
	});
});
