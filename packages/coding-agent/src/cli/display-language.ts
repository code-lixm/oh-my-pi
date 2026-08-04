import * as path from "node:path";
import { getAgentDir, getConfigDirName, getProjectDir, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { YAML } from "bun";

type DisplayLanguage = "en" | "zh-CN";

function configuredLanguage(value: unknown): DisplayLanguage | undefined {
	return value === "en" || value === "zh-CN" ? value : undefined;
}

async function readLanguage(filePath: string, required = false): Promise<DisplayLanguage | undefined> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (error) {
		if (!required && isEnoent(error)) return undefined;
		throw new Error(
			isEnoent(error)
				? `Config overlay not found: ${filePath}`
				: `Failed to read config ${filePath}: ${String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse config ${filePath}: ${String(error)}`);
	}
	if (parsed === null || parsed === undefined) return undefined;
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Config must be a YAML mapping: ${filePath}`);
	}
	return configuredLanguage((parsed as Record<string, unknown>).displayLanguage);
}

/**
 * Read only the setting needed by CLI help without importing Settings, discovery,
 * theme, or the native addon graph. Full Settings loading remains the command
 * runtime's responsibility.
 */
export async function loadDisplayLanguage(cwd = getProjectDir()): Promise<DisplayLanguage> {
	let language: DisplayLanguage = "en";
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const configured = await readLanguage(path.join(getAgentDir(), filename));
		if (configured) {
			language = configured;
			break;
		}
	}
	for (const filename of MAIN_CONFIG_FILENAMES) {
		language = (await readLanguage(path.join(cwd, getConfigDirName(), filename))) ?? language;
	}
	const configFiles = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
	for (const file of configFiles) {
		language = (await readLanguage(path.resolve(cwd, file), true)) ?? language;
	}
	return language;
}
