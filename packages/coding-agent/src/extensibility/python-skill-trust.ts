import { tSettingsUi } from "../i18n/settings-locale";
import type { PythonBackedSkill } from "./python-skills";

/** Installation policy for executable Python skills. */
export type PythonSkillTrustMode = "auto" | "prompt" | "off";

export interface PythonSkillInstallationRequest {
	skill: PythonBackedSkill;
	/** PEP 621 dependency specifications requested by the package. */
	dependencies: readonly string[];
	title: string;
	message: string;
}

/** Session/UI integration supplies this callback for `prompt` policy. */
export type PythonSkillInstallationConfirmer = (request: PythonSkillInstallationRequest) => boolean | Promise<boolean>;

/** Accept only known policy values before an installation reaches `uv`. */
export function isPythonSkillTrustMode(value: unknown): value is PythonSkillTrustMode {
	return value === "auto" || value === "prompt" || value === "off";
}

/** Format the complete user-facing request before a package install. */
export function createPythonSkillInstallationRequest(
	skill: PythonBackedSkill,
	dependencies: readonly string[],
): PythonSkillInstallationRequest {
	const uniqueDependencies = [...new Set(dependencies.map(dependency => dependency.trim()).filter(Boolean))];
	const dependencyLines = uniqueDependencies.length
		? uniqueDependencies.map(dependency => `- ${dependency}`).join("\n")
		: `- ${tSettingsUi("No declared third-party dependencies")}`;
	return {
		skill,
		dependencies: uniqueDependencies,
		title: tSettingsUi("Install Python skill {name}?", { name: skill.name }),
		message: [
			tSettingsUi("OMP will install {packagePath} into its dedicated Python skill environment.", {
				packagePath: skill.python.packagePath,
			}),
			tSettingsUi("Approved Python skills run in that dedicated skill-venv interpreter."),
			tSettingsUi("Declared dependencies:"),
			dependencyLines,
		].join("\n"),
	};
}

/**
 * Enforce the installation trust boundary. Only explicit `auto` permits an
 * install without a confirmer. Prompt confirmation fails closed for missing,
 * throwing, or non-true confirmer results.
 */
export async function confirmSkillInstallation(
	skill: PythonBackedSkill,
	dependencies: readonly string[],
	trustMode: PythonSkillTrustMode,
	confirmer?: PythonSkillInstallationConfirmer,
): Promise<boolean> {
	if (trustMode === "off") return false;
	if (trustMode === "auto") return true;
	if (trustMode !== "prompt" || !confirmer) return false;
	try {
		return (await confirmer(createPythonSkillInstallationRequest(skill, dependencies))) === true;
	} catch {
		return false;
	}
}
