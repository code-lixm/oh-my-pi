import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** Remove every locale-signal key so `??` fallthrough in the script works correctly. */
function scrubLocales(env: Record<string, string | undefined>) {
	const out = { ...env };
	for (const k of ["LANG", "LC_ALL", "OMP_LOCALE", "PI_LOCALE"]) {
		delete out[k];
	}
	return out;
}

async function runScript(args: string[], env: Record<string, string | undefined> = {}) {
	const cleanBase = scrubLocales(process.env as Record<string, string | undefined>);
	const proc = Bun.spawn(["bun", "scripts/claude-trace.ts", ...args], {
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

describe("scripts/claude-trace.ts locale", () => {
	describe("--help", () => {
		it("prints English help when no locale is set", async () => {
			const { stdout, exitCode } = await runScript(["--help"]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Usage: bun scripts/claude-trace.ts [options]");
			expect(stdout).toContain("Runs Claude Code in a headless PTY");
			expect(stdout).toContain("--command <cmd>");
			expect(stdout).toContain("Show this help");
		});

		it("prints Chinese help when OMP_LOCALE=zh-CN", async () => {
			const { stdout, exitCode } = await runScript(["--help"], { OMP_LOCALE: "zh-CN" });
			expect(exitCode).toBe(0);
			expect(stdout).toContain("用法：bun scripts/claude-trace.ts [选项]");
			expect(stdout).toContain("在本地 HTTPS 代理后以无头 PTY 方式运行");
			expect(stdout).toContain("--command <cmd>");
			expect(stdout).toContain("显示此帮助");
		});

		it("prints Chinese help when LANG=zh_CN.UTF-8", async () => {
			const { stdout, exitCode } = await runScript(["--help"], { LANG: "zh_CN.UTF-8" });
			expect(exitCode).toBe(0);
			expect(stdout).toContain("用法：bun scripts/claude-trace.ts [选项]");
		});
	});

	describe("unknown flag error", () => {
		it("prints English error with flag verbatim in stderr (en)", async () => {
			const { stderr, exitCode } = await runScript(["--bogus-flag"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("Unknown option: --bogus-flag");
			expect(stderr).toContain("--bogus-flag");
		});

		it("prints Chinese error with flag verbatim in stderr (zh-CN)", async () => {
			const { stderr, exitCode } = await runScript(["--bogus-flag"], { OMP_LOCALE: "zh-CN" });
			expect(exitCode).toBe(1);
			expect(stderr).toContain("未知选项：--bogus-flag");
			expect(stderr).toContain("--bogus-flag");
		});

		it("prints Chinese error when LANG=zh_CN.UTF-8", async () => {
			const { stderr, exitCode } = await runScript(["--unknown-opt"], { LANG: "zh_CN.UTF-8" });
			expect(exitCode).toBe(1);
			expect(stderr).toContain("未知选项：--unknown-opt");
		});
	});

	describe("dynamic value fidelity", () => {
		it("interpolates --port option name into err_requires_value in zh-CN", async () => {
			const { stderr, exitCode } = await runScript(["--port"], { OMP_LOCALE: "zh-CN" });
			expect(exitCode).toBe(1);
			expect(stderr).toContain("--port");
			expect(stderr).toContain("需要一个值");
		});

		it("interpolates --port option name into err_requires_value in en", async () => {
			const { stderr, exitCode } = await runScript(["--port"]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("--port");
			expect(stderr).toContain("requires a value");
		});
	});
});
