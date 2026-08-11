import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	confirmSkillInstallation,
	type PythonSkillInstallationConfirmer,
	type PythonSkillInstallationRequest,
} from "../../../src/extensibility/python-skill-trust";
import type { PythonBackedSkill } from "../../../src/extensibility/python-skills";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const skill: PythonBackedSkill = {
	name: "trusted-python-skill",
	description: "A local executable skill used to exercise the trust boundary.",
	filePath: path.join(os.tmpdir(), "omp-python-trust-skill", "SKILL.md"),
	baseDir: path.join(os.tmpdir(), "omp-python-trust-skill"),
	kind: "python",
	python: {
		importName: "trusted_python_skill",
		packagePath: path.join(os.tmpdir(), "omp-python-trust-skill"),
		pyprojectPath: path.join(os.tmpdir(), "omp-python-trust-skill", "pyproject.toml"),
		modulePath: path.join(os.tmpdir(), "omp-python-trust-skill", "src", "trusted_python_skill", "__init__.py"),
	},
};

describe("Python skill installation trust boundary", () => {
	it("normalizes the review request and accepts synchronous or asynchronous strict approval", async () => {
		const previousLocale = getSettingsUiLocale();
		try {
			setSettingsUiLocale("en");
			let request: PythonSkillInstallationRequest | undefined;
			const confirmer: PythonSkillInstallationConfirmer = received => {
				request = received;
				return Promise.resolve(true);
			};

			expect(
				await confirmSkillInstallation(
					skill,
					[" requests>=2 ", "", "requests>=2", " pydantic"],
					"prompt",
					confirmer,
				),
			).toBe(true);
			expect(request?.dependencies).toEqual(["requests>=2", "pydantic"]);
			expect(request?.title).toBe("Install Python skill trusted-python-skill?");
			expect(request?.message).toContain(`OMP will install ${skill.python.packagePath}`);
			expect(request?.message).toContain("dedicated Python skill environment");
			expect(request?.message).toContain("dedicated skill-venv interpreter");
			expect(request?.message).not.toContain("eval interpreter");
			expect(request?.message).toContain("- requests>=2\n- pydantic");

			expect(await confirmSkillInstallation(skill, ["local-dependency"], "prompt", () => true)).toBe(true);
			expect(await confirmSkillInstallation(skill, ["local-dependency"], "auto")).toBe(true);
			expect(await confirmSkillInstallation(skill, ["local-dependency"], "off", () => true)).toBe(false);
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});

	it("localizes review details in zh-CN and restores the global locale", async () => {
		const previousLocale = getSettingsUiLocale();
		try {
			setSettingsUiLocale("zh-CN");
			let chineseRequest: PythonSkillInstallationRequest | undefined;

			expect(
				await confirmSkillInstallation(skill, ["requests>=2", "pydantic"], "prompt", received => {
					chineseRequest = received;
					return true;
				}),
			).toBe(true);
			expect(chineseRequest?.title).toBe(`安装 Python 技能 ${skill.name}？`);
			expect(chineseRequest?.message).toContain(
				`OMP 将把 ${skill.python.packagePath} 安装到专用的 Python 技能环境中。`,
			);
			expect(chineseRequest?.message).toContain("获准的 Python 技能将在该专用 skill-venv 解释器中运行。");
			expect(chineseRequest?.message).toContain("声明的依赖：");
			expect(chineseRequest?.message).toContain("- requests>=2\n- pydantic");

			setSettingsUiLocale("en");
			let englishRequest: PythonSkillInstallationRequest | undefined;
			expect(
				await confirmSkillInstallation(skill, ["local-dependency"], "prompt", received => {
					englishRequest = received;
					return true;
				}),
			).toBe(true);
			expect(englishRequest?.title).toBe(`Install Python skill ${skill.name}?`);
			expect(englishRequest?.message).toContain("dedicated skill-venv interpreter");
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});

	it("fails closed for missing, declining, non-true, and throwing prompt confirmers", async () => {
		const previousLocale = getSettingsUiLocale();
		try {
			setSettingsUiLocale("en");
			const cases: Array<[string, PythonSkillInstallationConfirmer | undefined]> = [
				["missing", undefined],
				["declined", () => false],
				["undefined", () => undefined as unknown as boolean],
				["non-boolean", () => "true" as unknown as boolean],
				[
					"throwing",
					() => {
						throw new Error("fixture confirmer failure");
					},
				],
			];

			for (const [name, confirmer] of cases) {
				expect(await confirmSkillInstallation(skill, ["local-dependency"], "prompt", confirmer), name).toBe(false);
			}
		} finally {
			setSettingsUiLocale(previousLocale);
		}
	});
});
