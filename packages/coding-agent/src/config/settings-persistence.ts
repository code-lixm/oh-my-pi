type GlobalSettingsPersistedListener = (agentDir: string) => void;

const globalSettingsPersistedListeners = new Set<GlobalSettingsPersistedListener>();

/** Subscribe to successful global config persistence. */
export function onGlobalSettingsPersisted(listener: GlobalSettingsPersistedListener): () => void {
	globalSettingsPersistedListeners.add(listener);
	return () => {
		globalSettingsPersistedListeners.delete(listener);
	};
}

/** Notify persistence listeners without letting one failure abort the save. */
export function fireGlobalSettingsPersisted(agentDir: string, onError: (error: unknown) => void): void {
	for (const listener of [...globalSettingsPersistedListeners]) {
		try {
			listener(agentDir);
		} catch (error) {
			onError(error);
		}
	}
}
