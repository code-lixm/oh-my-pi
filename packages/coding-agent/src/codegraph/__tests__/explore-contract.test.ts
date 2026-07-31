import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCodeGraphIndexLocation } from "../location";
import { getCodeGraphExploreBudget, openCodeGraphRuntime } from "../runtime";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function initGitRepo(root: string, files: Readonly<Record<string, string>>): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	await Promise.all(
		Object.entries(files).map(([relativePath, source]) => Bun.write(path.join(root, relativePath), source)),
	);
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return root;
}

const COMPACT_PROBE_SOURCE = ["export function compactProbe(): number {", "  return 1;", "}", ""].join("\n");

function oversizedProbeSource(): string {
	const body = Array.from(
		{ length: 240 },
		(_, index) => `  const oversizedLine${index} = "${"x".repeat(32)}-${index}";`,
	);
	return ["export function oversizedProbe(): number {", ...body, "  return oversizedLine0.length;", "}", ""].join(
		"\n",
	);
}

describe("CodeGraph adaptive explore budget", () => {
	test.each([
		{ projectFileCount: 149, maxCharacters: 13_000, maxFiles: 4, maxCharactersPerFile: 3_800 },
		{ projectFileCount: 150, maxCharacters: 18_000, maxFiles: 5, maxCharactersPerFile: 3_800 },
		{ projectFileCount: 499, maxCharacters: 18_000, maxFiles: 5, maxCharactersPerFile: 3_800 },
		{ projectFileCount: 500, maxCharacters: 24_000, maxFiles: 8, maxCharactersPerFile: 6_500 },
		{ projectFileCount: 4_999, maxCharacters: 24_000, maxFiles: 8, maxCharactersPerFile: 6_500 },
		{ projectFileCount: 5_000, maxCharacters: 24_000, maxFiles: 8, maxCharactersPerFile: 7_000 },
	])(
		"selects the documented budget at $projectFileCount project files",
		({ projectFileCount, maxCharacters, maxFiles, maxCharactersPerFile }) => {
			const budget = getCodeGraphExploreBudget(projectFileCount, Number.MAX_SAFE_INTEGER);

			expect(budget).toMatchObject({
				projectFileCount,
				maxCharacters,
				maxFiles,
				maxCharactersPerFile,
			});
			expect(budget.effectiveMaxFiles).toBe(maxFiles);
			expect(budget.maxCharacters).toBeLessThanOrEqual(25_000);
		},
	);
});

describe("CodeGraph bounded source sections", () => {
	let tmp: string;
	let originalConfigDir: string | undefined;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-explore-contract-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-cg-explore-contract-${randomUUID()}`;
		isolatedConfigRoot = path.join(os.homedir(), isolatedConfigDir);
		process.env.PI_CONFIG_DIR = isolatedConfigDir;
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		await fs.rm(tmp, { recursive: true, force: true });
		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
	});

	test("keeps an ordinary target body whole and records it as complete coverage", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "complete"), { "compact.ts": COMPACT_PROBE_SOURCE });
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			const result = await runtime.explore("compactProbe", { mode: "locate" });
			const target = result.sourceSections.find(
				section => section.role === "target" && section.symbol?.name === "compactProbe",
			);

			expect(target).toBeDefined();
			expect(target?.completeness).toBe("complete");
			expect(target?.lines).toEqual(["export function compactProbe(): number {", "  return 1;", "}"]);
			expect(target?.text).toMatch(/return 1;\n\}$/u);
			expect(
				result.coverage.complete.some(
					item =>
						item.path === "compact.ts" &&
						item.role === "target" &&
						item.symbolId === target?.symbol?.id &&
						item.startLine === 1 &&
						item.endLine === 3,
				),
			).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("labels an oversized selected body partial instead of presenting a silently truncated section", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "partial"), { "oversized.ts": oversizedProbeSource() });
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			const result = await runtime.explore("oversizedProbe", { mode: "locate" });
			const target = result.sourceSections.find(
				section => section.role === "target" && section.symbol?.name === "oversizedProbe",
			);

			expect(target).toBeDefined();
			expect(target?.completeness).toBe("partial");
			expect(target?.reason).toBe("per-file-budget");
			expect(target?.text.length).toBeLessThanOrEqual(result.budget.maxCharactersPerFile);
			expect(
				result.coverage.partial.some(
					item =>
						item.path === "oversized.ts" &&
						item.role === "target" &&
						item.symbolId === target?.symbol?.id &&
						item.reason === "per-file-budget",
				),
			).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("records an unselected relationship as omitted coverage when maxFiles is exhausted", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "omitted"), {
			"target.ts": ["export function targetProbe(value: string): string {", "  return value.trim();", "}", ""].join(
				"\n",
			),
			"caller.ts": [
				'import { targetProbe } from "./target";',
				"export function callerProbe(): string {",
				'  return targetProbe(" covered relationship ");',
				"}",
				"",
			].join("\n"),
		});
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);

		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			const result = await runtime.explore("targetProbe", { mode: "understand", maxFiles: 1 });

			expect(
				result.coverage.omitted.some(
					item => item.path === "caller.ts" && item.role === "relationship" && item.reason === "file-limit",
				),
			).toBe(true);
		} finally {
			runtime.close();
		}
	});

	test("exposes mode-specific flow and impact envelopes", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "modes"), {
			"flow.ts": [
				"export function flowTarget(): number { return 1; }",
				"export function flowSource(): number { return flowTarget(); }",
				"",
			].join("\n"),
		});
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);
		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
			const flow = await runtime.explore("flowSource", { mode: "flow" });
			expect(flow.mode).toBe("flow");
			expect(Array.isArray(flow.flow)).toBe(true);
			expect(flow.sourceSections.some(section => section.role === "target")).toBe(true);

			const impact = await runtime.explore("flowTarget", { mode: "impact" });
			expect(impact.mode).toBe("impact");
			expect(impact.blastRadius?.focal.name).toBe("flowTarget");
			expect(impact.sourceSections.some(section => section.role === "target")).toBe(true);
		} finally {
			runtime.close();
		}
	});
});
