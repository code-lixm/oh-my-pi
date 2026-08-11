import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pythonBackend from "../../../src/eval/py/index";
import type { PythonBackedSkill } from "../../../src/extensibility/python-skills";
import { buildSystemPrompt } from "../../../src/system-prompt";
import type { ToolSession } from "../../../src/tools";

interface LocalSkill {
	name: string;
	packagePath: string;
	importName: string;
}

/**
 * Eval backend contract: a Python skill preload failure is local to that
 * binding. Healthy skill calls and unrelated statements in the same first eval
 * cell must still complete.
 */
describe("eval Python backend pythonSkills wiring", () => {
	async function makeSkill(root: string, name: string, moduleBody: string): Promise<LocalSkill> {
		const packagePath = path.join(root, name);
		const importName = name.replaceAll("-", "_");
		await fs.mkdir(path.join(packagePath, "src", importName), { recursive: true });
		await fs.writeFile(
			path.join(packagePath, "pyproject.toml"),
			`[project]\nname = "${name}"\nversion = "0.1.0"\ndependencies = []\n`,
		);
		await fs.writeFile(path.join(packagePath, "src", importName, "__init__.py"), moduleBody);
		return { name, packagePath, importName };
	}

	it("keeps healthy skill calls and ordinary Python eval available beside an unavailable skill", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-backend-"));
		try {
			const healthy = await makeSkill(root, "healthy-skill", 'def run():\n    return "healthy backend result"\n');
			const broken = await makeSkill(root, "broken-skill", 'raise ImportError("fixture backend import failure")\n');
			const session = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				getArtifactsDir: () => null,
				settings: {
					get: (key: string) => (key === "python.kernelMode" ? "per-call" : undefined),
				},
				pythonSkills: {
					metadata: [
						{ name: healthy.name, importName: healthy.importName, packagePath: healthy.packagePath },
						{ name: broken.name, importName: broken.importName, packagePath: broken.packagePath },
					],
				},
			} as unknown as ToolSession;

			const result = await pythonBackend.execute(
				`print("healthy:", await ${healthy.importName}())\ntry:\n    await ${broken.importName}()\nexcept RuntimeError as error:\n    print("unavailable:", error)\nprint("ordinary:", 6 * 7)`,
				{
					cwd: root,
					sessionId: "python-skill-backend-isolation",
					sessionFile: "",
					kernelOwnerId: "python-skill-backend-isolation",
					reset: false,
					onChunk: () => {},
					session,
				},
			);

			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("healthy: healthy backend result");
			expect(result.output).toContain("ordinary: 42");
			expect(result.output).toContain(broken.name);
			expect(result.output).toContain(broken.importName);
			expect(result.output).toContain("ImportError");
			expect(result.output).toContain("fixture backend import failure");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("renders approved Python metadata into the system prompt while excluding unapproved metadata", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-prompt-"));
		try {
			const packagePath = path.join(root, "approved-python-skill");
			const approved: PythonBackedSkill = {
				name: "approved-python-skill",
				description: "APPROVED_PYTHON_SKILL_DESCRIPTION",
				filePath: path.join(packagePath, "SKILL.md"),
				baseDir: packagePath,
				kind: "python",
				python: {
					importName: "approved_python_skill",
					packagePath,
					pyprojectPath: path.join(packagePath, "pyproject.toml"),
					modulePath: path.join(packagePath, "src", "approved_python_skill", "__init__.py"),
				},
			};
			const unapproved = {
				...approved,
				name: "unapproved-python-skill",
				description: "UNAPPROVED_PYTHON_SKILL_DESCRIPTION",
				filePath: path.join(root, "unapproved-python-skill", "SKILL.md"),
				baseDir: path.join(root, "unapproved-python-skill"),
				python: {
					...approved.python,
					importName: "unapproved_python_skill",
					packagePath: "relative-unapproved-package",
				},
			};

			const result = await buildSystemPrompt({
				resolvedCustomPrompt: "Python skill prompt fixture",
				cwd: root,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: {
					rootPath: root,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				activeRepoContext: null,
				pythonSkillMetadata: { skills: [approved, unapproved] },
			});
			const prompt = result.systemPrompt.join("\n");

			expect(prompt).toContain(`<name>${approved.name}</name>`);
			expect(prompt).toContain(`<python_import>${approved.python.importName}</python_import>`);
			expect(prompt).toContain(`<description>${approved.description}</description>`);
			expect(prompt).not.toContain(unapproved.name);
			expect(prompt).not.toContain(unapproved.python.importName);
			expect(prompt).not.toContain(unapproved.description);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
