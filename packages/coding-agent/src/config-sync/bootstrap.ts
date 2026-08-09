import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { savePendingAdoption } from "./adoption";
import { decryptSyncBootstrapPayload, encryptSyncBootstrapPayload } from "./crypto";
import { upsertLocalEnvironment } from "./local-env";
import { isSyncProfileEnabled, loadSyncProfile, parseSyncProfile, saveSyncProfile } from "./profile";
import {
	type EncryptedSyncBootstrapBundle,
	SYNC_BOOTSTRAP_BUNDLE_VERSION,
	type SyncBootstrapCredentials,
	type SyncBootstrapPayload,
	type SyncProfile,
} from "./types";

export const DEFAULT_SYNC_BOOTSTRAP_PASSPHRASE_ENV = "OMP_CONFIG_SYNC_BOOTSTRAP_PASSPHRASE";

export interface SyncBootstrapSummary {
	path?: string;
	bucket: string;
	prefix: string;
	endpoint?: string;
	credentialEnvNames: string[];
	enabled: boolean;
	pendingAdoption: boolean;
}

export async function exportSyncBootstrap(
	agentDir: string,
	filePath: string,
	passphrase: string,
): Promise<SyncBootstrapSummary> {
	const profile = await loadSyncProfile(agentDir, undefined, { allowDisabled: true });
	if (!profile) throw new Error("Configuration sync is not configured; run `omp sync init` first");
	const credentials = readProfileCredentials(profile);
	const payload: SyncBootstrapPayload = {
		formatVersion: SYNC_BOOTSTRAP_BUNDLE_VERSION,
		createdAt: new Date().toISOString(),
		profile: compactSyncProfile(profile),
		credentials,
	};
	const bundle = await encryptSyncBootstrapPayload(payload, passphrase);
	await writeBootstrapFile(filePath, bundle);
	return summarizeBootstrap(filePath, profile, await isSyncProfileEnabled(agentDir), false);
}

export async function importSyncBootstrap(
	agentDir: string,
	filePath: string,
	passphrase: string,
	dryRun: boolean,
): Promise<SyncBootstrapSummary> {
	const bundle: unknown = await Bun.file(filePath).json();
	const payload = parseSyncBootstrapPayload(await decryptSyncBootstrapPayload(bundle, passphrase));
	const profile = { ...payload.profile, autoPush: false } satisfies SyncProfile;
	if (dryRun) return summarizeBootstrap(undefined, profile, false, true);

	const credentials = new Map<string, string>();
	if (profile.accessKeyIdEnv && payload.credentials.accessKeyId !== undefined) {
		credentials.set(profile.accessKeyIdEnv, payload.credentials.accessKeyId);
	}
	if (profile.secretAccessKeyEnv && payload.credentials.secretAccessKey !== undefined) {
		credentials.set(profile.secretAccessKeyEnv, payload.credentials.secretAccessKey);
	}
	if (profile.sessionTokenEnv && payload.credentials.sessionToken !== undefined) {
		credentials.set(profile.sessionTokenEnv, payload.credentials.sessionToken);
	}
	await upsertLocalEnvironment(agentDir, credentials);
	await savePendingAdoption(agentDir, payload.profile);
	await saveSyncProfile(agentDir, profile, { enabled: false });
	return summarizeBootstrap(undefined, profile, false, true);
}

function readProfileCredentials(profile: SyncProfile): SyncBootstrapCredentials {
	const values: SyncBootstrapCredentials = {};
	getCredentialEnvNames(profile);
	if (profile.accessKeyIdEnv) values.accessKeyId = requireEnvironmentValue(profile.accessKeyIdEnv);
	if (profile.secretAccessKeyEnv) values.secretAccessKey = requireEnvironmentValue(profile.secretAccessKeyEnv);
	if (profile.sessionTokenEnv) values.sessionToken = requireEnvironmentValue(profile.sessionTokenEnv);
	return values;
}
function getCredentialEnvNames(profile: SyncProfile): string[] {
	const names = [profile.accessKeyIdEnv, profile.secretAccessKeyEnv, profile.sessionTokenEnv].filter(
		(name): name is string => name !== undefined,
	);
	if (new Set(names).size !== names.length) throw new Error("S3 credential environment variable names must be unique");
	if (names.includes(profile.passphraseEnv)) {
		throw new Error("The repository passphrase environment variable must not also store an S3 credential");
	}
	return names;
}
function compactSyncProfile(profile: SyncProfile): SyncProfile {
	const compact: SyncProfile = {
		formatVersion: profile.formatVersion,
		bucket: profile.bucket,
		prefix: profile.prefix,
		passphraseEnv: profile.passphraseEnv,
	};
	if (profile.endpoint !== undefined) compact.endpoint = profile.endpoint;
	if (profile.region !== undefined) compact.region = profile.region;
	if (profile.virtualHostedStyle !== undefined) compact.virtualHostedStyle = profile.virtualHostedStyle;
	if (profile.accessKeyIdEnv !== undefined) compact.accessKeyIdEnv = profile.accessKeyIdEnv;
	if (profile.secretAccessKeyEnv !== undefined) compact.secretAccessKeyEnv = profile.secretAccessKeyEnv;
	if (profile.sessionTokenEnv !== undefined) compact.sessionTokenEnv = profile.sessionTokenEnv;
	if (profile.autoPush !== undefined) compact.autoPush = profile.autoPush;
	const retention = profile.retention;
	if (retention) {
		const compactRetention: NonNullable<SyncProfile["retention"]> = {};
		if (retention.revisions !== undefined) compactRetention.revisions = retention.revisions;
		if (retention.days !== undefined) compactRetention.days = retention.days;
		if (retention.inactiveWriterDays !== undefined) {
			compactRetention.inactiveWriterDays = retention.inactiveWriterDays;
		}
		if (Object.keys(compactRetention).length > 0) compact.retention = compactRetention;
	}
	return compact;
}

function requireEnvironmentValue(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Configured S3 credential environment variable ${name} is not set`);
	return value;
}

function parseSyncBootstrapPayload(value: unknown): SyncBootstrapPayload {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Sync bootstrap payload must be an object");
	}
	const record = value as Record<string, unknown>;
	assertExactKeys(record, ["formatVersion", "createdAt", "profile", "credentials"]);
	if (record.formatVersion !== SYNC_BOOTSTRAP_BUNDLE_VERSION) {
		throw new Error(`Unsupported sync bootstrap payload version: ${String(record.formatVersion)}`);
	}
	if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
		throw new Error("Sync bootstrap payload createdAt must be an ISO timestamp");
	}
	const profile = parseSyncProfile(record.profile);
	getCredentialEnvNames(profile);
	if (record.credentials === null || typeof record.credentials !== "object" || Array.isArray(record.credentials)) {
		throw new Error("Sync bootstrap credentials must be an object");
	}
	const credentialsRecord = record.credentials as Record<string, unknown>;
	assertExactKeys(credentialsRecord, ["accessKeyId", "secretAccessKey", "sessionToken"]);
	const credentials: SyncBootstrapCredentials = {};
	for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"] as const) {
		const valueForKey = credentialsRecord[key];
		if (valueForKey !== undefined) {
			if (typeof valueForKey !== "string" || valueForKey.length === 0) {
				throw new Error(`Sync bootstrap credential ${key} must be a non-empty string`);
			}
			credentials[key] = valueForKey;
		}
	}
	if (profile.accessKeyIdEnv === undefined && credentials.accessKeyId !== undefined) {
		throw new Error("Bootstrap contains an access key without its environment variable name");
	}
	if (profile.accessKeyIdEnv !== undefined && credentials.accessKeyId === undefined) {
		throw new Error("Bootstrap is missing the configured access key");
	}
	if (profile.secretAccessKeyEnv === undefined && credentials.secretAccessKey !== undefined) {
		throw new Error("Bootstrap contains a secret key without its environment variable name");
	}
	if (profile.secretAccessKeyEnv !== undefined && credentials.secretAccessKey === undefined) {
		throw new Error("Bootstrap is missing the configured secret key");
	}
	if (profile.sessionTokenEnv === undefined && credentials.sessionToken !== undefined) {
		throw new Error("Bootstrap contains a session token without its environment variable name");
	}
	if (profile.sessionTokenEnv !== undefined && credentials.sessionToken === undefined) {
		throw new Error("Bootstrap is missing the configured session token");
	}
	return { formatVersion: SYNC_BOOTSTRAP_BUNDLE_VERSION, createdAt: record.createdAt, profile, credentials };
}

function summarizeBootstrap(
	filePath: string | undefined,
	profile: SyncProfile,
	enabled: boolean,
	pendingAdoption: boolean,
): SyncBootstrapSummary {
	return {
		path: filePath,
		bucket: profile.bucket,
		prefix: profile.prefix,
		endpoint: profile.endpoint,
		credentialEnvNames: getCredentialEnvNames(profile),
		enabled,
		pendingAdoption,
	};
}

async function writeBootstrapFile(filePath: string, bundle: EncryptedSyncBootstrapBundle): Promise<void> {
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlinked bootstrap file: ${filePath}`);
		if (!stat.isFile()) throw new Error(`Bootstrap path is not a regular file: ${filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await fs.rename(tempPath, filePath);
		await fs.chmod(filePath, 0o600).catch(() => undefined);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = Object.keys(record).find(key => !allowed.includes(key));
	if (unknown !== undefined) throw new Error(`Sync bootstrap payload contains unsupported field ${unknown}`);
}
