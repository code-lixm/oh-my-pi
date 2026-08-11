import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { PythonSkillMetadata } from "../../extensibility/python-skills";

const SKILL_BOOTSTRAP_MANIFEST_FILE = ".skill-bootstrap-version";
const SKILL_BOOTSTRAP_VERSION = 1;
const PythonProjectFileSchema = type({
	"project?": {
		"name?": "string",
		"dependencies?": "string[]",
	},
});
const SkillManifestEntrySchema = type({
	importName: "string",
	packagePath: "string",
	pyprojectHash: "string",
});
const SkillBootstrapManifestSchema = type({
	version: "number",
	skills: SkillManifestEntrySchema.array(),
});

function resolveHomeDirectory(): string {
	const home = Bun.env.HOME ?? Bun.env.USERPROFILE;
	if (!home) throw new Error("Cannot resolve the home directory for the Python skill environment");
	return home;
}

/** Dedicated environment for executable skills; never the normal eval interpreter. */
export const OMP_SKILL_VENV_DIR = path.join(resolveHomeDirectory(), ".omp", "python-skill-venv");

/** Resolve a Python executable under a virtual environment on every platform. */
export function pythonSkillVenvPythonPath(venvPath: string = OMP_SKILL_VENV_DIR): string {
	return path.join(venvPath, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export interface SkillManifestEntry {
	importName: string;
	packagePath: string;
	pyprojectHash: string;
}

interface SkillBootstrapManifest {
	version: number;
	skills: SkillManifestEntry[];
}

/** PEP 621 details used for dependency-aware installation and trust review. */
export interface PythonSkillPackageInfo {
	skill: PythonSkillMetadata;
	packageName?: string;
	dependencies: string[];
	pyprojectHash: string;
	parseError?: string;
}

export interface PythonSkillBootstrapWarning {
	importName?: string;
	packagePath?: string;
	message: string;
}

export interface PythonSkillBootstrapOptions {
	/** Test-only or embedding override; production callers use OMP_SKILL_VENV_DIR. */
	venvPath?: string;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface PythonSkillBootstrapResult {
	venvPath: string;
	manifestPath: string;
	/** Dedicated venv executable path selected for this bootstrap result. */
	pythonPath: string;
	/** Skills known installed in this environment and safe to pass to preload. */
	installedSkills: PythonSkillMetadata[];
	manifest: SkillManifestEntry[];
	warnings: PythonSkillBootstrapWarning[];
}

function sha256Hex(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function readProjectMetadata(content: string): {
	packageName?: string;
	dependencies: string[];
	parseError?: string;
} {
	try {
		const parsed = Bun.TOML.parse(content);
		const project = PythonProjectFileSchema.allows(parsed) ? parsed.project : undefined;
		if (!project) return { dependencies: [] };
		return {
			packageName: project.name?.trim() || undefined,
			dependencies: project.dependencies ?? [],
		};
	} catch (error) {
		return {
			dependencies: [],
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Read a Python skill's PEP 621 metadata without installing anything. */
export async function inspectPythonSkillPackage(skill: PythonSkillMetadata): Promise<PythonSkillPackageInfo> {
	const content = await Bun.file(skill.pyprojectPath).text();
	const project = readProjectMetadata(content);
	return {
		skill,
		packageName: project.packageName,
		dependencies: project.dependencies,
		pyprojectHash: sha256Hex(content),
		...(project.parseError !== undefined && { parseError: project.parseError }),
	};
}

/** Dependencies are exposed for the trust boundary before `uv` runs. */
export async function readPythonSkillDependencies(skill: PythonSkillMetadata): Promise<string[]> {
	return (await inspectPythonSkillPackage(skill)).dependencies;
}

function normalizePackageName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replaceAll(/[._-]+/g, "-");
}

function requirementPackageName(requirement: string): string | undefined {
	const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
	return match?.[1] ? normalizePackageName(match[1]) : undefined;
}

function manifestEntry(info: PythonSkillPackageInfo): SkillManifestEntry {
	return {
		importName: info.skill.importName,
		packagePath: info.skill.packagePath,
		pyprojectHash: info.pyprojectHash,
	};
}

function isCurrentManifestEntry(entry: SkillManifestEntry | undefined, info: PythonSkillPackageInfo): boolean {
	return (
		entry?.packagePath === info.skill.packagePath &&
		entry.pyprojectHash === info.pyprojectHash &&
		entry.importName === info.skill.importName
	);
}

async function readManifest(manifestPath: string): Promise<SkillBootstrapManifest> {
	const manifestFile = Bun.file(manifestPath);
	if (!(await manifestFile.exists())) return { version: SKILL_BOOTSTRAP_VERSION, skills: [] };
	try {
		const parsed: unknown = JSON.parse(await manifestFile.text());
		if (!SkillBootstrapManifestSchema.allows(parsed) || parsed.version !== SKILL_BOOTSTRAP_VERSION) {
			return { version: SKILL_BOOTSTRAP_VERSION, skills: [] };
		}
		return {
			version: SKILL_BOOTSTRAP_VERSION,
			skills: parsed.skills,
		};
	} catch {
		return { version: SKILL_BOOTSTRAP_VERSION, skills: [] };
	}
}

function orderBySiblingDependencies(
	packages: readonly PythonSkillPackageInfo[],
	warnings: PythonSkillBootstrapWarning[],
): PythonSkillPackageInfo[] {
	const byPackageName = new Map<string, PythonSkillPackageInfo>();
	for (const info of packages) {
		if (!info.packageName) continue;
		const key = normalizePackageName(info.packageName);
		if (byPackageName.has(key)) {
			warnings.push({
				importName: info.skill.importName,
				packagePath: info.skill.packagePath,
				message: `Duplicate Python package name "${info.packageName}"; sibling dependency ordering is ambiguous.`,
			});
			continue;
		}
		byPackageName.set(key, info);
	}

	const ordered: PythonSkillPackageInfo[] = [];
	const permanent = new Set<PythonSkillPackageInfo>();
	const temporary = new Set<PythonSkillPackageInfo>();
	const reportedCycles = new Set<string>();
	const visit = (info: PythonSkillPackageInfo): void => {
		if (permanent.has(info)) return;
		if (temporary.has(info)) {
			const cycleKey = info.skill.importName;
			if (!reportedCycles.has(cycleKey)) {
				reportedCycles.add(cycleKey);
				warnings.push({
					importName: info.skill.importName,
					packagePath: info.skill.packagePath,
					message:
						"Python skill sibling dependencies contain a cycle; installing in deterministic discovery order.",
				});
			}
			return;
		}
		temporary.add(info);
		for (const dependency of info.dependencies) {
			const sibling = requirementPackageName(dependency);
			if (!sibling) continue;
			const dependencyInfo = byPackageName.get(sibling);
			if (dependencyInfo) visit(dependencyInfo);
		}
		temporary.delete(info);
		permanent.add(info);
		ordered.push(info);
	};

	for (const info of packages) visit(info);
	return ordered;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runUv(
	uvPath: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ProcessResult> {
	const proc = Bun.spawn([uvPath, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal,
		windowsHide: true,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function commandError(result: ProcessResult): string {
	const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 2_000);
	return output ? `uv exited with code ${result.exitCode}: ${output}` : `uv exited with code ${result.exitCode}`;
}

async function ensureDedicatedVenv(
	venvPath: string,
	pythonPath: string,
	options: PythonSkillBootstrapOptions,
): Promise<void> {
	if (await Bun.file(pythonPath).exists()) return;
	const uvPath = Bun.which("uv");
	if (!uvPath) throw new Error("uv is required to create the Python skill environment");

	options.onProgress?.("Creating dedicated Python skill environment");
	await fs.mkdir(path.dirname(venvPath), { recursive: true });
	const result = await runUv(uvPath, ["venv", venvPath], path.dirname(venvPath), options.signal);
	if (result.exitCode !== 0) throw new Error(commandError(result));
	if (!(await Bun.file(pythonPath).exists())) {
		throw new Error(`uv created no Python executable at ${pythonPath}`);
	}
}

function uniqueSkillMetadata(
	skills: readonly PythonSkillMetadata[],
	warnings: PythonSkillBootstrapWarning[],
): PythonSkillMetadata[] {
	const unique = new Map<string, PythonSkillMetadata>();
	for (const skill of skills) {
		if (!skill.importName || !skill.packagePath || !skill.pyprojectPath) {
			warnings.push({
				importName: skill.importName,
				packagePath: skill.packagePath,
				message: "Invalid Python skill metadata.",
			});
			continue;
		}
		const existing = unique.get(skill.importName);
		if (existing && existing.packagePath !== skill.packagePath) {
			warnings.push({
				importName: skill.importName,
				packagePath: skill.packagePath,
				message: `Python import "${skill.importName}" is claimed by multiple skills; skipping this package.`,
			});
			continue;
		}
		unique.set(skill.importName, skill);
	}
	return [...unique.values()];
}

/**
 * Ensure editable Python skills are installed in the isolated skill venv.
 * Reinstalls only when a skill's pyproject.toml hash changes. Failures are
 * isolated per skill so one bad package never prevents other skills loading.
 */
export async function ensurePythonSkillVenv(
	skills: readonly PythonSkillMetadata[],
	options: PythonSkillBootstrapOptions = {},
): Promise<PythonSkillBootstrapResult> {
	const venvPath = options.venvPath ?? OMP_SKILL_VENV_DIR;
	const pythonPath = pythonSkillVenvPythonPath(venvPath);
	const manifestPath = path.join(venvPath, SKILL_BOOTSTRAP_MANIFEST_FILE);
	const warnings: PythonSkillBootstrapWarning[] = [];
	const uniqueSkills = uniqueSkillMetadata(skills, warnings);
	if (uniqueSkills.length === 0) {
		return { venvPath, manifestPath, pythonPath, installedSkills: [], manifest: [], warnings };
	}

	const packageResults = await Promise.allSettled(uniqueSkills.map(skill => inspectPythonSkillPackage(skill)));
	const packages: PythonSkillPackageInfo[] = [];
	for (let index = 0; index < packageResults.length; index += 1) {
		const result = packageResults[index];
		const skill = uniqueSkills[index];
		if (!skill) continue;
		if (result.status === "fulfilled") {
			packages.push(result.value);
			if (result.value.parseError) {
				warnings.push({
					importName: skill.importName,
					packagePath: skill.packagePath,
					message: `Could not inspect PEP 621 metadata: ${result.value.parseError}`,
				});
			}
		} else {
			warnings.push({
				importName: skill.importName,
				packagePath: skill.packagePath,
				message: `Could not read pyproject.toml: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			});
		}
	}
	if (packages.length === 0) {
		return { venvPath, manifestPath, pythonPath, installedSkills: [], manifest: [], warnings };
	}

	try {
		await ensureDedicatedVenv(venvPath, pythonPath, options);
	} catch (error) {
		warnings.push({
			message: `Could not prepare the dedicated Python skill environment: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { venvPath, manifestPath, pythonPath, installedSkills: [], manifest: [], warnings };
	}

	const previousManifest = await readManifest(manifestPath);
	const previousByImport = new Map(previousManifest.skills.map(entry => [entry.importName, entry]));
	const installedSkills: PythonSkillMetadata[] = [];
	const nextManifestEntries: SkillManifestEntry[] = [];
	const orderedPackages = orderBySiblingDependencies(packages, warnings);
	const uvPath = Bun.which("uv");
	if (!uvPath) {
		warnings.push({ message: "uv is required to install Python skills." });
		return { venvPath, manifestPath, pythonPath, installedSkills, manifest: nextManifestEntries, warnings };
	}

	for (const info of orderedPackages) {
		const previousEntry = previousByImport.get(info.skill.importName);
		if (isCurrentManifestEntry(previousEntry, info)) {
			installedSkills.push(info.skill);
			nextManifestEntries.push(manifestEntry(info));
			continue;
		}

		options.onProgress?.(`Installing Python skill ${info.skill.importName}`);
		try {
			const result = await runUv(
				uvPath,
				["pip", "install", "--python", pythonPath, "--editable", info.skill.packagePath],
				info.skill.packagePath,
				options.signal,
			);
			if (result.exitCode !== 0) {
				warnings.push({
					importName: info.skill.importName,
					packagePath: info.skill.packagePath,
					message: `Could not install Python skill: ${commandError(result)}`,
				});
				continue;
			}
			installedSkills.push(info.skill);
			nextManifestEntries.push(manifestEntry(info));
		} catch (error) {
			warnings.push({
				importName: info.skill.importName,
				packagePath: info.skill.packagePath,
				message: `Could not install Python skill: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const manifest: SkillBootstrapManifest = {
		version: SKILL_BOOTSTRAP_VERSION,
		skills: nextManifestEntries,
	};
	try {
		await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, { createPath: true });
	} catch (error) {
		warnings.push({
			message: `Could not write Python skill bootstrap manifest: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	return {
		venvPath,
		manifestPath,
		pythonPath,
		installedSkills,
		manifest: nextManifestEntries,
		warnings,
	};
}
