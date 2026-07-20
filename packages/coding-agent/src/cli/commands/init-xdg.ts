import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tSettingsUi } from "../../i18n/settings-locale";

const APP_NAME = "omp";

export async function initXdg(): Promise<void> {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		console.error(tSettingsUi("XDG directory setup is only supported on Linux and macOS."));
		process.exit(1);
	}

	const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
	const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state");
	const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");

	const dirs = [path.join(dataHome, APP_NAME), path.join(stateHome, APP_NAME), path.join(cacheHome, APP_NAME)];

	for (const dir of dirs) {
		await fs.mkdir(dir, { recursive: true });
		console.log(tSettingsUi("Created {path}", { path: dir.replace(os.homedir(), "~") }));
	}

	console.log(`\n${tSettingsUi("XDG directories initialized.")}`);
	console.log(tSettingsUi("Ensure XDG_DATA_HOME, XDG_STATE_HOME, and XDG_CACHE_HOME"));
	console.log(tSettingsUi("are set in your shell profile for omp to use them."));
}
