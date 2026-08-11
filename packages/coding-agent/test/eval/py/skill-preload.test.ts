import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { buildSkillPreloadCode } from "../../../src/eval/py/skill-preload";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

interface LocalSkill {
	name: string;
	dir: string;
	importName: string;
}

/**
 * Python skill preload contract: the generated code must run inside a real
 * Python interpreter and expose each healthy skill as an awaitable callable
 * wrapper. A malformed sibling must degrade to an unavailable wrapper rather
 * than prevent ordinary Python eval or healthy skills from starting.
 */
describe("buildSkillPreloadCode", () => {
	async function runPreload(
		skills: readonly LocalSkill[],
		body: string,
	): Promise<{ exit: number; out: string; err: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-preload-test-"));
		try {
			// The kernel executes preload and user code in one shared namespace; the
			// probe mirrors that by appending its body after the preload source.
			const preload = buildSkillPreloadCode(
				skills.map(skill => ({ name: skill.name, importName: skill.importName, packagePath: skill.dir })),
			);
			await fs.writeFile(path.join(dir, "probe.py"), `${preload}\n${body}`);
			const proc = Bun.spawn([pythonPath, "probe.py"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			const [out, err, exit] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { exit, out, err };
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	async function makeSkill(root: string, name: string, moduleBody: string): Promise<LocalSkill> {
		const dir = path.join(root, name);
		const importName = name.replaceAll("-", "_");
		await fs.mkdir(path.join(dir, "src", importName), { recursive: true });
		await fs.writeFile(
			path.join(dir, "pyproject.toml"),
			`[project]\nname = "${name}"\nversion = "0.1.0"\ndependencies = []\n`,
		);
		await fs.writeFile(path.join(dir, "src", importName, "__init__.py"), moduleBody);
		return { name, dir, importName };
	}

	it("exposes a callable awaitable wrapper for both direct and run-based calls", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-preload-package-"));
		try {
			const skill = await makeSkill(root, "hello-world", 'def run(name="world"):\n    return f"hello, {name}"\n');
			const result = await runPreload(
				[skill],
				`import asyncio\nasync def main():\n    print("direct:", await ${skill.importName}("smoke"))\n    print("run:", await ${skill.importName}.run("run-path"))\nasyncio.run(main())\n`,
			);
			expect(result.exit).toBe(0);
			expect(result.err).toBe("");
			expect(result.out).toContain("direct: hello, smoke");
			expect(result.out).toContain("run: hello, run-path");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("copies the run signature onto the wrapper and forwards module attributes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-preload-package-"));
		try {
			const skill = await makeSkill(root, "math-util", "import inspect\n\ndef run(a, b=2):\n    return a + b\n");
			const result = await runPreload(
				[skill],
				`import inspect, asyncio\nasync def main():\n    sig = inspect.signature(${skill.importName})\n    print("params:", list(sig.parameters))\n    print("value:", await ${skill.importName}(3, b=4))\nasyncio.run(main())\n`,
			);
			expect(result.exit).toBe(0);
			expect(result.err).toBe("");
			expect(result.out).toContain("params: ['a', 'b']");
			expect(result.out).toContain("value: 7");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps healthy skills and ordinary eval available when a sibling preload fails", async () => {
		const cases = [
			{
				name: "broken-import",
				moduleBody: 'raise ImportError("fixture import failed")\n',
				errorType: "ImportError",
				errorText: "fixture import failed",
			},
			{
				name: "system-exit",
				moduleBody: 'raise SystemExit("fixture process exit")\n',
				errorType: "SystemExit",
				errorText: "fixture process exit",
			},
		] as const;

		for (const failingCase of cases) {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-preload-isolation-"));
			try {
				const healthy = await makeSkill(root, "healthy-skill", 'def run():\n    return "healthy result"\n');
				const unavailable = await makeSkill(root, failingCase.name, failingCase.moduleBody);
				const result = await runPreload(
					[healthy, unavailable],
					`import asyncio\nasync def main():\n    print("healthy:", await ${healthy.importName}())\n    try:\n        await ${unavailable.importName}()\n    except RuntimeError as error:\n        print("unavailable:", error)\n    print("ordinary:", 6 * 7)\nasyncio.run(main())\n`,
				);

				expect(result.exit).toBe(0);
				expect(result.err).toBe("");
				expect(result.out).toContain("healthy: healthy result");
				expect(result.out).toContain("ordinary: 42");
				expect(result.out).toContain(failingCase.name);
				expect(result.out).toContain(unavailable.importName);
				expect(result.out).toContain(failingCase.errorType);
				expect(result.out).toContain(failingCase.errorText);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	});

	it("keeps an import-only module usable as its module projection", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-preload-import-only-"));
		try {
			const skill = await makeSkill(
				root,
				"module-only",
				'ANSWER = 41\ndef describe():\n    return "module projection"\n',
			);
			const result = await runPreload(
				[skill],
				`print("answer:", ${skill.importName}.ANSWER)\nprint("description:", ${skill.importName}.describe())\n`,
			);

			expect(result.exit).toBe(0);
			expect(result.err).toBe("");
			expect(result.out).toContain("answer: 41");
			expect(result.out).toContain("description: module projection");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("is empty when no valid skills are supplied", () => {
		expect(buildSkillPreloadCode([])).toBe("");
		expect(buildSkillPreloadCode([{ importName: "not valid!", packagePath: "/tmp" }])).toBe("");
	});
});
