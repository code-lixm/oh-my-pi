/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { $which, APP_NAME, getProjectDir, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { Settings, settings } from "../config/settings";
import { tSettingsUi } from "../i18n/settings-locale";
import { theme } from "../modes/theme/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { detectRecorder, ensureRecorder } from "../stt/recorder";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(tSettingsUi("Usage: {command}", { command: `${APP_NAME} setup <component>` })));
		console.error(tSettingsUi("Valid components: {components}", { components: VALID_COMPONENTS.join(", ") }));
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(tSettingsUi("Unknown component: {component}", { component })));
		console.error(tSettingsUi("Valid components: {components}", { components: VALID_COMPONENTS.join(", ") }));
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(): Promise<PythonCheckResult> {
	const result: PythonCheckResult = {
		available: false,
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	const pythonPath = systemPythonPath ?? (hasManagedEnv ? managedPath : undefined);
	if (!pythonPath) {
		return result;
	}
	const probe = await $`${pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow();
	result.pythonPath = pythonPath;
	result.available = probe.exitCode === 0;
	result.usingManagedEnv = pythonPath === managedPath;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	await Settings.loadReadOnly({ cwd: getProjectDir() });
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const check = await checkPythonSetup();

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} ${tSettingsUi("Python not found")}`));
		console.error(chalk.dim(tSettingsUi("Install Python 3.8+ and ensure it's in your PATH")));
		process.exit(1);
	}

	console.log(chalk.dim(tSettingsUi("Python: {path}", { path: check.pythonPath })));
	const managedEnvPath = check.managedEnvPath;
	if (check.usingManagedEnv && managedEnvPath) {
		console.log(chalk.dim(tSettingsUi("Using managed environment: {path}", { path: managedEnvPath })));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} ${tSettingsUi("Python execution is ready")}`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} ${tSettingsUi("Python interpreter reported failure")}`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	displayStatus(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "Recorder",
			isReady: async () => detectRecorder() !== null,
			status: async () => {
				const recorder = detectRecorder();
				return recorder ? `${recorder.tool} (${recorder.bin})` : "none — ffmpeg will be downloaded";
			},
			displayStatus: async () => {
				const recorder = detectRecorder();
				return recorder ? `${recorder.tool} (${recorder.bin})` : tSettingsUi("none — ffmpeg will be downloaded");
			},
			ensure: async onProgress => {
				await ensureRecorder(onProgress);
			},
		},
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : `${key} — not downloaded`;
			},
			displayStatus: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : tSettingsUi("{key} — not downloaded", { key });
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					tSettingsUi("Speech-to-Text model"),
					[...STT_MODEL_OPTIONS],
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({
						stage: tSettingsUi("Downloading {label} model", { label: progress.label }),
						percent: progress.percent,
					}),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : `${key} — model/runtime not installed`;
			},
			displayStatus: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : tSettingsUi("{key} — model/runtime not installed", { key });
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					tSettingsUi("Text-to-Speech model"),
					[...TTS_LOCAL_MODEL_OPTIONS],
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error(tSettingsUi("Failed to download the local text-to-speech model."));
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold(tSettingsUi("Speech dependencies:")));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green(tSettingsUi("[ok]")) : chalk.yellow(tSettingsUi("[missing]"));
			console.log(`  ${mark} ${component.name}: ${await component.displayStatus()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${tSettingsUi("{name} ready", { name: component.name })}`));
			continue;
		}
		console.log(chalk.dim(tSettingsUi("Preparing {name}...", { name: component.name })));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg =
				err instanceof Error ? err.message : tSettingsUi("Failed to set up {name}", { name: component.name });
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} ${tSettingsUi("Speech is ready")}`));
	console.log(
		chalk.dim(
			tSettingsUi(
				"Enable speech-to-text via stt.enabled, then hold Space to talk (or bind app.stt.toggle); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
			),
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	const components = [
		`  python    ${tSettingsUi("Verify a Python 3 interpreter is reachable for code execution")}`,
		`  speech    ${tSettingsUi("Pick + download the speech-to-text and text-to-speech models and an audio recorder")}`,
	].join("\n");
	const options = [
		`  -c, --check   ${tSettingsUi("Check if dependencies are installed without installing")}`,
		`  --json        ${tSettingsUi("Output status as JSON")}`,
	].join("\n");
	const examples = [
		`  ${APP_NAME} setup                  ${tSettingsUi("Run the onboarding wizard")}`,
		`  ${APP_NAME} setup python           ${tSettingsUi("Check Python execution dependencies")}`,
		`  ${APP_NAME} setup speech           ${tSettingsUi("Set up speech (pick STT + TTS models, install a recorder)")}`,
		`  ${APP_NAME} setup speech --check   ${tSettingsUi("Check if speech dependencies are available")}`,
		`  ${APP_NAME} setup python --check   ${tSettingsUi("Check if Python execution is available")}`,
	].join("\n");
	console.log(
		`${chalk.bold(`${APP_NAME} setup`)} - ${tSettingsUi("Run onboarding or install dependencies for optional features")}

${chalk.bold(tSettingsUi("Usage:"))}
  ${APP_NAME} setup                     ${tSettingsUi("Run the onboarding wizard")}
  ${APP_NAME} setup <component> [options]

${chalk.bold(tSettingsUi("Components:"))}
${components}

${chalk.bold(tSettingsUi("Options:"))}
${options}

${chalk.bold(tSettingsUi("Examples:"))}
${examples}
`,
	);
}
