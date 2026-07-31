import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import { onGlobalSettingsPersisted } from "../config/settings";
import { loadSyncProfile } from "./profile";
import { synchronizeConfiguration } from "./service";

const queues = new Map<string, Promise<void>>();
let registered = false;

/** Register a non-reentrant background push after global YAML persistence. */
export function registerConfigSyncAutoPush(): void {
	if (registered) return;
	registered = true;
	onGlobalSettingsPersisted(agentDir => {
		queueMicrotask(() => {
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
		});
	});
}

async function runAutoPush(agentDir: string): Promise<void> {
	const profile = await loadSyncProfile(agentDir);
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
