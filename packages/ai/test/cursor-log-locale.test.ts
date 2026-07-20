import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

/**
 * Locate `python3` from the current PATH so we use the version the developer
 * actually installed (3.10+ required — cursor-log.py uses `str | None` syntax).
 */
function resolvePythonPath(): Promise<string> {
	const which = Bun.spawn(["/bin/sh", "-c", "which python3"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return new Response(which.stdout)
		.text()
		.then(t => t.trim())
		.catch(() => "python3");
}

const pythonPathPromise = resolvePythonPath();

/** Remove every locale-signal key so `??`/`or` fallthrough in the script works correctly. */
function scrubLocales(env: Record<string, string | undefined>) {
	const out = { ...env };
	for (const k of ["LANG", "LC_ALL", "OMP_LOCALE", "PI_LOCALE"]) {
		delete out[k];
	}
	return out;
}

async function runScript(args: string[], env: Record<string, string | undefined> = {}) {
	const pythonPath = await pythonPathPromise;
	const scriptPath = join(repoRoot, "packages", "ai", "scripts", "cursor-log.py");
	const cleanBase = scrubLocales(process.env as Record<string, string | undefined>);
	const proc = Bun.spawn([pythonPath, scriptPath, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...cleanBase, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

const ABSENT_FILE = "/tmp/this-file-absolutely-does-not-exist-12345.jsonl";

describe("packages/ai/scripts/cursor-log.py locale", () => {
	describe("--help", () => {
		it("prints English help when no locale is set", async () => {
			const { stdout, exitCode } = await runScript(["--help"]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Filter Cursor debug logs");
			expect(stdout).toContain("JSONL log file");
			expect(stdout).toContain("Show all entries");
		});

		it("prints Chinese help when OMP_LOCALE=zh-CN", async () => {
			const { stdout, exitCode } = await runScript(["--help"], { OMP_LOCALE: "zh-CN" });
			expect(exitCode).toBe(0);
			expect(stdout).toContain("过滤并展示 Cursor 调试日志");
			expect(stdout).toContain("JSONL 日志文件");
			expect(stdout).toContain("显示全部条目");
		});

		it("prints Chinese help when LANG=zh_CN.UTF-8", async () => {
			const { stdout, exitCode } = await runScript(["--help"], { LANG: "zh_CN.UTF-8" });
			expect(exitCode).toBe(0);
			expect(stdout).toContain("过滤并展示 Cursor 调试日志");
		});
	});

	describe("missing file error", () => {
		it("prints English error with path verbatim in stderr (en)", async () => {
			const { stderr, exitCode } = await runScript([ABSENT_FILE]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`File not found: ${ABSENT_FILE}`);
			expect(stderr).toContain(ABSENT_FILE);
		});

		it("prints Chinese error with path verbatim in stderr (zh-CN)", async () => {
			const { stderr, exitCode } = await runScript([ABSENT_FILE], { OMP_LOCALE: "zh-CN" });
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`未找到文件：${ABSENT_FILE}`);
			expect(stderr).toContain(ABSENT_FILE);
		});

		it("prints Chinese error when LANG=zh_CN.UTF-8", async () => {
			const { stderr, exitCode } = await runScript([ABSENT_FILE], { LANG: "zh_CN.UTF-8" });
			expect(exitCode).toBe(1);
			expect(stderr).toContain("未找到文件：");
			expect(stderr).toContain(ABSENT_FILE);
		});
	});

	describe("flag labels are locale-switched but flag names stay English", () => {
		it("shows English flag descriptions in en locale", async () => {
			const { stdout } = await runScript(["--help"]);
			expect(stdout).toContain("-h");
			expect(stdout).toContain("--help");
			expect(stdout).toContain("--last");
			expect(stdout).toContain("Show all entries");
			expect(stdout).toContain("Follow mode");
		});

		it("shows Chinese flag descriptions in zh-CN locale", async () => {
			const { stdout } = await runScript(["--help"], { OMP_LOCALE: "zh-CN" });
			expect(stdout).toContain("-h");
			expect(stdout).toContain("--help");
			expect(stdout).toContain("--last");
			expect(stdout).toContain("显示全部条目");
			expect(stdout).toContain("持续跟踪模式");
		});
	});
});
