import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { installConfigSyncAutoPushRunner } from "./auto-push";
import { hasSettingsSyncProfile, loadSyncProfile } from "./profile";
import { synchronizeConfiguration } from "./service";

const queues = new Map<string, Promise<void>>();

/** Wire the heavy sync runtime only from post-profile command modules. */
export function initializeConfigSyncAutoPushRuntime(): void {
	installConfigSyncAutoPushRunner(queueConfigSyncAutoPush);
}
/** Queue a non-reentrant configuration push for one agent directory. */
export function queueConfigSyncAutoPush(agentDir: string): void {
	const previous = queues.get(agentDir) ?? Promise.resolve();
	const next = previous
		.then(() => runAutoPush(agentDir))
		.catch(error => {
			logger.warn("Automatic configuration sync failed", {
				agentDir,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	queues.set(agentDir, next);
	void next.finally(() => {
		if (queues.get(agentDir) === next) queues.delete(agentDir);
	});
}

async function runAutoPush(agentDir: string): Promise<void> {
	const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
	if (hasSettingsSyncProfile(settings)) {
		if (!settings.get("sync.enabled") || !settings.get("sync.autoPush")) return;
	}
	const profile = await loadSyncProfile(agentDir, settings);
	if (!profile?.autoPush) return;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
	const authStorage = new AuthStorage(store);
	try {
		await authStorage.reload();
		await synchronizeConfiguration(agentDir, authStorage, { mode: "push" });
	} finally {
		authStorage.close();
	}
}
