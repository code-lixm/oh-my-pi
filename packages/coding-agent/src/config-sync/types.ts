import type { AuthCredential, AuthStorageData } from "@oh-my-pi/pi-ai";

export const CONFIG_BUNDLE_VERSION = 1 as const;
export const CONFIG_SYNC_VERSION = 1 as const;

export interface ConfigFileEntry {
	/** Path relative to the active user agent directory. */
	path: string;
	/** Base64-encoded file bytes. */
	content: string;
	/** Original POSIX permission bits when available. */
	mode?: number;
}

export interface ConfigSnapshot {
	formatVersion: typeof CONFIG_BUNDLE_VERSION;
	createdAt: string;
	files: ConfigFileEntry[];
	/** Durable API-key and OAuth credentials only; no usage/session/history rows. */
	auth: AuthStorageData;
}

export interface ConfigBundleEncryption {
	algorithm: "AES-256-GCM";
	kdf: "PBKDF2-SHA-256";
	iterations: number;
	salt: string;
	iv: string;
}

export interface EncryptedConfigBundle {
	format: "omp-config-bundle";
	formatVersion: typeof CONFIG_BUNDLE_VERSION;
	encryption: ConfigBundleEncryption;
	ciphertext: string;
}

export interface SyncProfile {
	formatVersion: typeof CONFIG_SYNC_VERSION;
	endpoint?: string;
	bucket: string;
	region?: string;
	prefix: string;
	virtualHostedStyle?: boolean;
	passphraseEnv: string;
	accessKeyIdEnv?: string;
	secretAccessKeyEnv?: string;
	sessionTokenEnv?: string;
	autoPush?: boolean;
	retention?: {
		revisions?: number;
		days?: number;
		inactiveWriterDays?: number;
	};
}

export interface SyncState {
	formatVersion: typeof CONFIG_SYNC_VERSION;
	writerId: string;
	sequence: number;
	lastPublicationId?: string;
	lastRevisionId?: string;
	lastPayloadHash?: string;
}

export interface ConfigRevision {
	format: "omp-config-revision";
	formatVersion: typeof CONFIG_SYNC_VERSION;
	revisionId: string;
	parentRevisionIds: string[];
	payloadHash: string;
	bundle: EncryptedConfigBundle;
}

export interface PublicationParent {
	publicationId: string;
	revisionId: string;
}

export interface ConfigPublication {
	format: "omp-config-publication";
	formatVersion: typeof CONFIG_SYNC_VERSION;
	epochId: string;
	publicationId: string;
	writerId: string;
	sequence: number;
	revisionId: string;
	parents: PublicationParent[];
}

export interface ConfigConflictValue {
	files?: ConfigFileEntry[];
	auth?: Record<string, AuthCredential[]>;
}

export interface ConfigConflictEntry {
	kind: "file" | "auth";
	key: string;
	base: ConfigFileEntry | AuthCredential[] | null;
	local: ConfigFileEntry | AuthCredential[] | null;
	remote: ConfigFileEntry | AuthCredential[] | null;
}

export interface ConfigConflictDocument {
	format: "omp-config-conflict";
	formatVersion: typeof CONFIG_SYNC_VERSION;
	createdAt: string;
	baseRevisionId?: string;
	remoteRevisionIds: string[];
	base: ConfigSnapshot;
	local: ConfigSnapshot;
	remote: ConfigSnapshot;
	conflicts: ConfigConflictEntry[];
}

export interface MergeResult {
	merged?: ConfigSnapshot;
	conflicts: ConfigConflictEntry[];
}
