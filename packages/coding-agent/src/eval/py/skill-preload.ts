import * as path from "node:path";
import {
	type PythonSkillMetadata,
	toPythonImportName,
	validatePythonImportNameExact,
} from "../../extensibility/python-skills";

/** Only validated package identity crosses the kernel startup boundary. */
export interface PythonSkillPreloadMetadata extends Pick<PythonSkillMetadata, "importName" | "packagePath"> {
	/** Original skill name for actionable unavailable-skill diagnostics. */
	name?: string;
}

/** Narrow Python-specific startup data shared by executor and kernel rebuilds. */
export interface PythonSkillStartOptions {
	/** Verified executable in the dedicated skill venv; it takes precedence for skill-backed eval. */
	pythonPath?: string;
	/** Host-generated preload code. When omitted it is built from metadata. */
	preloadCode?: string;
	/** Trusted, validated package metadata; never raw discovered skills. */
	metadata?: readonly PythonSkillPreloadMetadata[];
	/** Opaque skill-state generation that isolates retained kernel namespaces after reload. */
	runtimeId?: string;
}

/** Prefer the verified skill-venv executable across every Python launch path. */
export function resolvePythonSkillInterpreter(
	pythonSkills: PythonSkillStartOptions | undefined,
	fallback: string | undefined,
): string | undefined {
	return pythonSkills?.pythonPath ?? fallback;
}

/** Input accepted by the low-level preload-code builder. */
export interface PythonSkillPreloadInput {
	/** Human-facing skill name, when available, used to verify the derived import. */
	name?: string;
	importName: string;
	/** Absolute package root; its `src/` directory is added to `sys.path`. */
	packagePath?: string;
}

const PYTHON_SKILL_PRELOAD_RUNTIME = `
import importlib as _omp_skill_importlib
import inspect as _omp_skill_inspect
import os as _omp_skill_os
import sys as _omp_skill_sys

def _omp_describe_python_skill_error(error):
    try:
        message = str(error)
    except BaseException:
        message = "<unprintable error>"
    return f"{type(error).__name__}: {message}"

class _UnavailableSkill:
    def __init__(self, skill_name, import_name, error):
        self.__omp_skill_name = skill_name
        self.__omp_import_name = import_name
        self.__omp_error = _omp_describe_python_skill_error(error)

    def __omp_diagnostic(self):
        return (
            f"Python skill '{self.__omp_skill_name}' "
            f"(import '{self.__omp_import_name}') is unavailable: {self.__omp_error}"
        )

    def __call__(self, *args, **kwargs):
        raise RuntimeError(self.__omp_diagnostic())

    def __getattr__(self, _name):
        raise RuntimeError(self.__omp_diagnostic())

class __OmpCallableSkillModule:
    def __init__(self, module, run):
        self.__omp_module = module
        self.__omp_run = run
        self.__name__ = getattr(module, "__name__", None)
        self.__doc__ = getattr(run, "__doc__", None)
        try:
            self.__signature__ = _omp_skill_inspect.signature(run)
        except (TypeError, ValueError):
            pass

    async def __call__(self, *args, **kwargs):
        result = self.__omp_run(*args, **kwargs)
        if _omp_skill_inspect.isawaitable(result):
            return await result
        return result

    async def run(self, *args, **kwargs):
        """Awaitable alias so both direct and run-based calls work."""
        result = self.__omp_run(*args, **kwargs)

        if _omp_skill_inspect.isawaitable(result):
            return await result
        return result

    def __getattr__(self, name):
        return getattr(self.__omp_module, name)

def _omp_add_python_skill_path(package_path):
    src_path = _omp_skill_os.path.join(package_path, "src")
    if src_path not in _omp_skill_sys.path:
        _omp_skill_sys.path.insert(0, src_path)

def _omp_load_python_skill(import_name):
    module = _omp_skill_importlib.import_module(import_name)
    try:
        run = getattr(module, "run", None)
    except BaseException:
        return module
    if not callable(run):
        return module
    try:
        return __OmpCallableSkillModule(module, run)
    except BaseException:
        return module

def _omp_preload_python_skill(skill_name, import_name, package_path):
    try:
        if package_path is not None:
            _omp_add_python_skill_path(package_path)
        globals()[import_name] = _omp_load_python_skill(import_name)
    except BaseException as error:
        globals()[import_name] = _UnavailableSkill(skill_name, import_name, error)
`;

function isValidPreloadInput(skill: PythonSkillPreloadInput): boolean {
	if (validatePythonImportNameExact(skill.importName) !== undefined) return false;
	if (skill.name !== undefined && toPythonImportName(skill.name) !== skill.importName) return false;
	return skill.packagePath === undefined || path.isAbsolute(skill.packagePath);
}

/**
 * Generate startup code for a persistent Python kernel. Every skill is
 * isolated: only import or initialization failures bind an `_UnavailableSkill`.
 * A usable import-only module remains available as its module object.
 */
export function buildSkillPreloadCode(skills: readonly PythonSkillPreloadInput[]): string {
	const imports = new Map<string, PythonSkillPreloadInput>();
	for (const skill of skills) {
		if (!isValidPreloadInput(skill) || imports.has(skill.importName)) continue;
		imports.set(skill.importName, skill);
	}
	if (imports.size === 0) return "";

	const bindings = [...imports.values()].map(skill => {
		const packagePath = skill.packagePath === undefined ? "None" : JSON.stringify(skill.packagePath);
		return `_omp_preload_python_skill(${JSON.stringify(skill.name ?? skill.importName)}, ${JSON.stringify(skill.importName)}, ${packagePath})`;
	});
	return `${PYTHON_SKILL_PRELOAD_RUNTIME}\n${bindings.join("\n")}`;
}
