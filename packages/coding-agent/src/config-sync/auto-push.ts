import { onGlobalSettingsPersisted } from "../config/settings-persistence";

type ConfigSyncAutoPushRunner = (agentDir: string) => void;

let runner: ConfigSyncAutoPushRunner | undefined;
let registered = false;

/** Install the runtime queue after profile-sensitive modules are safe to load. */
export function installConfigSyncAutoPushRunner(next: ConfigSyncAutoPushRunner): void {
	runner = next;
}

/** Register a deferred push after global YAML persistence. */
export function registerConfigSyncAutoPush(): void {
	if (registered) return;
	registered = true;
	onGlobalSettingsPersisted(agentDir => {
		queueMicrotask(() => runner?.(agentDir));
	});
}
