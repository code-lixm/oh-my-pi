import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { PromptContribution } from "../prime-integration/contracts";
import pythonSkillsMetadataTemplate from "../prompts/skills/python-skill-metadata.md" with { type: "text" };
import type { Skill } from "./skills";

const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS: Record<string, true> = {
	False: true,
	None: true,
	True: true,
	and: true,
	as: true,
	assert: true,
	async: true,
	await: true,
	break: true,
	case: true,
	class: true,
	continue: true,
	def: true,
	del: true,
	elif: true,
	else: true,
	except: true,
	finally: true,
	for: true,
	from: true,
	global: true,
	if: true,
	import: true,
	in: true,
	is: true,
	lambda: true,
	match: true,
	nonlocal: true,
	not: true,
	or: true,
	pass: true,
	raise: true,
	return: true,
	try: true,
	while: true,
	with: true,
	yield: true,
};

/** Metadata required to install and preload a Python-backed skill. */
export interface PythonSkillMetadata {
	/** Importable package name; skill dashes become underscores. */
	importName: string;
	/** Absolute directory containing the skill's pyproject.toml. */
	packagePath: string;
	/** Absolute path to the package's pyproject.toml. */
	pyprojectPath: string;
	/** Absolute path to the package's src/<importName>/__init__.py, when discovered. */
	modulePath?: string;
}

/** Minimal discovery shape accepted by {@link detectPythonSkill}. */
export interface PythonSkillCandidate {
	name: string;
	baseDir: string;
	description?: string;
	filePath?: string;
	/** Preserve normal Markdown-skill prompt visibility. */
	hide?: boolean;
	/** Preserve the canonical skill projection for consumers beyond the prompt. */
	source?: string;
	containRoot?: string;
	_source?: Skill["_source"];
}

/** A discovered skill with an executable Python package alongside SKILL.md. */
export interface PythonBackedSkill extends PythonSkillCandidate {
	description: string;
	filePath: string;
	kind: "python";
	python: PythonSkillMetadata;
}

export interface PythonSkillDiscoveryWarning {
	name: string;
	baseDir: string;
	message: string;
}

export interface PythonSkillDiscoveryResult {
	skills: PythonBackedSkill[];
	warnings: PythonSkillDiscoveryWarning[];
}

/** Convert an Agent Skill name into its importable Python package name. */
export function toPythonImportName(skillName: string): string {
	return skillName.replaceAll("-", "_");
}

function validatePythonModuleName(name: string): string | undefined {
	if (name.length === 0 || name.trim() !== name || !PYTHON_IDENTIFIER.test(name)) {
		return `Python import "${name}" must be one ASCII identifier`;
	}
	if (Object.hasOwn(PYTHON_KEYWORDS, name)) return `Python import "${name}" is a reserved keyword`;
	return undefined;
}

/** Validate an already-derived, single-segment Python import name. */
export function validatePythonImportNameExact(name: string): string | undefined {
	return validatePythonModuleName(name);
}

/**
 * Return an actionable validation error when a skill cannot safely become a
 * Python import. `undefined` means the derived import name is valid.
 */
export function validatePythonImportName(name: string): string | undefined {
	const importName = toPythonImportName(name);
	const error = validatePythonModuleName(importName);
	return error === undefined ? undefined : `Skill name "${name}" maps to invalid Python import "${importName}"`;
}

async function isRegularFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.lstat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Detect the executable shape without changing normal Markdown-skill behavior.
 * Both marker files must be ordinary files (not directories or symlinks).
 */
export async function detectPythonSkill(skill: PythonSkillCandidate): Promise<PythonSkillMetadata | null> {
	const validationError = validatePythonImportName(skill.name);
	if (validationError !== undefined) return null;

	const importName = toPythonImportName(skill.name);
	const packagePath = path.resolve(skill.baseDir);
	const pyprojectPath = path.join(packagePath, "pyproject.toml");
	const modulePath = path.join(packagePath, "src", importName, "__init__.py");
	const [hasPyproject, hasModule] = await Promise.all([isRegularFile(pyprojectPath), isRegularFile(modulePath)]);
	if (!hasPyproject || !hasModule) return null;

	return { importName, packagePath, pyprojectPath, modulePath };
}

/** Discover all executable Python skills while preserving ordinary skills. */
export async function discoverPythonSkills(
	candidates: readonly PythonSkillCandidate[],
): Promise<PythonSkillDiscoveryResult> {
	const skills: PythonBackedSkill[] = [];
	const warnings: PythonSkillDiscoveryWarning[] = [];
	const imports = new Map<string, PythonBackedSkill>();
	for (const candidate of candidates) {
		const validationError = validatePythonImportName(candidate.name);
		if (validationError !== undefined) {
			warnings.push({ name: candidate.name, baseDir: candidate.baseDir, message: validationError });
			continue;
		}
		const metadata = await detectPythonSkill(candidate);
		if (!metadata) continue;
		const skill: PythonBackedSkill = {
			...candidate,
			name: candidate.name,
			baseDir: metadata.packagePath,
			description: candidate.description ?? "",
			filePath: candidate.filePath ?? path.join(metadata.packagePath, "SKILL.md"),
			kind: "python",
			python: metadata,
		};
		const existing = imports.get(metadata.importName);
		if (existing) {
			warnings.push({
				name: candidate.name,
				baseDir: candidate.baseDir,
				message: `Python import "${metadata.importName}" is already claimed by ${existing.filePath}`,
			});
			continue;
		}
		imports.set(metadata.importName, skill);
		skills.push(skill);
	}
	return { skills, warnings };
}

/** Discover Python-backed packages from the canonical discovered Skill[] shape. */
export async function discoverPythonSkillsFromSkills(skills: readonly Skill[]): Promise<PythonSkillDiscoveryResult> {
	return await discoverPythonSkills(skills);
}

/**
 * Resolve only validated Python package metadata from discovered skills.
 * Invalid names, missing marker files, and duplicate imports are omitted.
 */
export async function resolvePythonSkillMetadata(skills: readonly Skill[]): Promise<PythonSkillMetadata[]> {
	const result = await discoverPythonSkillsFromSkills(skills);
	return result.skills.map(skill => skill.python);
}

const PythonSkillMetadataSchema = type({
	importName: "string",
	packagePath: "string",
	pyprojectPath: "string",
	"modulePath?": "string",
});
const PythonBackedSkillSchema = type({
	name: "string",
	baseDir: "string",
	description: "string",
	filePath: "string",
	"hide?": "boolean",
	kind: "'python'",
	python: PythonSkillMetadataSchema,
});

/** Runtime check useful at integration boundaries where skills are `unknown`. */
export function isPythonBackedSkill(value: unknown): value is PythonBackedSkill {
	if (!PythonBackedSkillSchema.allows(value)) return false;
	return (
		value.python.importName === toPythonImportName(value.name) &&
		validatePythonImportNameExact(value.python.importName) === undefined &&
		path.isAbsolute(value.python.packagePath) &&
		path.isAbsolute(value.python.pyprojectPath) &&
		(value.python.modulePath === undefined || path.isAbsolute(value.python.modulePath))
	);
}

function readPythonBackedSkills(value: unknown): PythonBackedSkill[] {
	const candidates = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "skills" in value && Array.isArray(value.skills)
			? value.skills
			: [];
	return candidates.filter(isPythonBackedSkill);
}

function redactPromptText(value: string): string {
	return value
		.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/g, "$1[redacted]@")
		.replace(/\b(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}\b/gi, "[redacted]");
}

/** Render Python skill metadata for a system-prompt contribution. */
export function renderPythonSkillsForPrompt(skills: readonly PythonBackedSkill[]): string | undefined {
	const validSkills = skills.filter(skill => isPythonBackedSkill(skill) && skill.hide !== true);
	if (validSkills.length === 0) return undefined;
	return prompt
		.render(pythonSkillsMetadataTemplate, {
			skills: validSkills.map(skill => ({
				name: redactPromptText(skill.name),
				description: redactPromptText(skill.description),
				filePath: skill.filePath,
				importName: skill.python.importName,
			})),
		})
		.trim();
}

/** Explicit prompt fragment wired by the integration owner. */
export const pythonSkillsPromptContribution: PromptContribution = {
	id: "python-skills",
	render(context) {
		return renderPythonSkillsForPrompt(readPythonBackedSkills(context.pythonSkillMetadata));
	},
};
