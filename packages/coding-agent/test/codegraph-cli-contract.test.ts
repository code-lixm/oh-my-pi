import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCodeGraphIndexLocation } from "../src/codegraph/location";
import { openCodeGraphRuntime } from "../src/codegraph/runtime";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliProcessResult {
	exitCode: number;
	output: string;
	error: string;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function initGitRepo(root: string): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "src.ts"), "export const version = 1;\n", "utf8");
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
	return root;
}

async function runCliProcess(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliProcessResult> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", CODEGRAPH_KERNEL: "0", ...env },
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
	return { exitCode, output, error };
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch {
		return false;
	}
}

describe("codegraph CLI subprocess contract", () => {
	let tmp: string;
	let originalConfigDir: string | undefined;
	let isolatedConfigDir: string;
	let isolatedConfigRoot: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-cli-"));
		originalConfigDir = process.env.PI_CONFIG_DIR;
		isolatedConfigDir = `.omp-cg-cli-${randomUUID()}`;
		isolatedConfigRoot = path.join(os.homedir(), isolatedConfigDir);
		process.env.PI_CONFIG_DIR = isolatedConfigDir;
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		await fs.rm(tmp, { recursive: true, force: true });
		await fs.rm(isolatedConfigRoot, { recursive: true, force: true });
	});

	it("status/clear/prune JSON flows stay inside the configured CodeGraph root", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-codegraph-cli"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);
		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
		} finally {
			runtime.close();
		}

		const outsideSentinel = path.join(isolatedConfigRoot, "outside-sentinel.txt");
		await fs.mkdir(path.dirname(outsideSentinel), { recursive: true });
		await fs.writeFile(outsideSentinel, "do not touch\n", "utf8");

		const status = await runCliProcess(repoRoot, ["codegraph", "status", "--json"], {
			PI_CONFIG_DIR: isolatedConfigDir,
		});
		expect(status.exitCode, status.error).toBe(0);
		const statusJson = JSON.parse(status.output) as {
			available: boolean;
			exists: boolean;
			verified: boolean;
			paths: { indexDir: string };
			identity: { key: string };
		};
		expect(statusJson.available).toBe(true);
		expect(statusJson.exists).toBe(true);
		expect(statusJson.verified).toBe(true);
		expect(statusJson.identity.key).toBe(location.identity.key);
		expect(statusJson.paths.indexDir).toBe(location.indexDir);

		const prune = await runCliProcess(repoRoot, ["codegraph", "prune", "--dry-run", "--json"], {
			PI_CONFIG_DIR: isolatedConfigDir,
		});
		expect(prune.exitCode, prune.error).toBe(0);
		const pruneJson = JSON.parse(prune.output) as {
			root: string;
			scanned: number;
			entries: Array<{ path: string }>;
		};
		expect(pruneJson.scanned).toBeGreaterThanOrEqual(1);
		expect(pruneJson.entries.every(entry => entry.path.startsWith(pruneJson.root))).toBe(true);
		expect(await Bun.file(outsideSentinel).exists()).toBe(true);

		const clearDryRun = await runCliProcess(repoRoot, ["codegraph", "clear", "--dry-run", "--json"], {
			PI_CONFIG_DIR: isolatedConfigDir,
		});
		expect(clearDryRun.exitCode, clearDryRun.error).toBe(0);
		const clearDryRunJson = JSON.parse(clearDryRun.output) as {
			dryRun: boolean;
			removed: boolean;
			wouldRemove: boolean;
			indexDir: string;
		};
		expect(clearDryRunJson.dryRun).toBe(true);
		expect(clearDryRunJson.removed).toBe(false);
		expect(clearDryRunJson.wouldRemove).toBe(true);
		expect(await pathExists(clearDryRunJson.indexDir)).toBe(true);

		const clear = await runCliProcess(repoRoot, ["codegraph", "clear", "--json"], {
			PI_CONFIG_DIR: isolatedConfigDir,
		});
		expect(clear.exitCode, clear.error).toBe(0);
		const clearJson = JSON.parse(clear.output) as {
			removed: boolean;
			wouldRemove: boolean;
			indexDir: string;
		};
		expect(clearJson.removed).toBe(true);
		expect(clearJson.wouldRemove).toBe(false);
		expect(await pathExists(clearJson.indexDir)).toBe(false);

		const statusAfterClear = await runCliProcess(repoRoot, ["codegraph", "status", "--json"], {
			PI_CONFIG_DIR: isolatedConfigDir,
		});
		expect(statusAfterClear.exitCode, statusAfterClear.error).toBe(0);
		const statusAfterClearJson = JSON.parse(statusAfterClear.output) as { exists: boolean; verified: boolean };
		expect(statusAfterClearJson.exists).toBe(false);
		expect(statusAfterClearJson.verified).toBe(false);
	});

	it("prune JSON dry-run preserves byte-size policy parsing across suffix variants", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-codegraph-byte-policy"));
		const location = await resolveCodeGraphIndexLocation(repoRoot);
		expect(location.available).toBe(true);
		const runtime = await openCodeGraphRuntime({ location, sourceRoot: repoRoot });
		try {
			await runtime.initialize();
		} finally {
			runtime.close();
		}

		const cases = [
			{
				name: "single-letter gib suffix for per-project cap",
				args: ["--max-project-bytes", "2g"],
				key: "maxProjectBytes",
				expected: 2_147_483_648,
			},
			{
				name: "explicit GiB suffix for total cap",
				args: ["--max-total-bytes", "8GiB"],
				key: "maxTotalBytes",
				expected: 8_589_934_592,
			},
			{
				name: "raw integer bytes remain supported",
				args: ["--max-project-bytes", "4096"],
				key: "maxProjectBytes",
				expected: 4096,
			},
		] as const;

		for (const testCase of cases) {
			const prune = await runCliProcess(repoRoot, ["codegraph", "prune", "--dry-run", "--json", ...testCase.args], {
				PI_CONFIG_DIR: isolatedConfigDir,
			});
			expect(prune.exitCode, `${testCase.name}: ${prune.error}`).toBe(0);
			const pruneJson = JSON.parse(prune.output) as {
				policy: { maxProjectBytes?: number; maxTotalBytes?: number };
			};
			expect(pruneJson.policy[testCase.key], testCase.name).toBe(testCase.expected);
		}
	});

	it("prune rejects invalid byte-size suffixes with a CLI error contract", async () => {
		const repoRoot = await initGitRepo(path.join(tmp, "repo-codegraph-byte-policy-invalid"));
		const invalid = await runCliProcess(
			repoRoot,
			["codegraph", "prune", "--dry-run", "--json", "--max-project-bytes", "2xb"],
			{
				PI_CONFIG_DIR: isolatedConfigDir,
			},
		);

		expect(invalid.exitCode).not.toBe(0);
		expect(invalid.output).toBe("");
		expect(invalid.error).toContain("--max-project-bytes must be bytes or a size such as 512m, 2g, or 8GiB.");
	});
});
