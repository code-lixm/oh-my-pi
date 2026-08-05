import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { CONFIG_SYNC_VERSION, type SyncProfile, type SyncState } from "./types";

export const DEFAULT_SYNC_PASSPHRASE_ENV = "OMP_CONFIG_SYNC_PASSPHRASE";

export function getSyncProfilePath(agentDir: string): string {
	return path.join(agentDir, "sync.yml");
}

export function getSyncStatePath(agentDir: string): string {
	return path.join(agentDir, "sync-state.json");
}

export function getSyncConflictPath(agentDir: string): string {
	return path.join(agentDir, "sync-conflict.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

export function parseSyncProfile(value: unknown): SyncProfile {
	if (!isRecord(value)) throw new Error("Sync profile must be a mapping");
	assertExactKeys(
		value,
		[
			"formatVersion",
			"endpoint",
			"bucket",
			"region",
			"prefix",
			"virtualHostedStyle",
			"passphraseEnv",
			"accessKeyIdEnv",
			"secretAccessKeyEnv",
			"sessionTokenEnv",
			"autoPush",
			"retention",
		],
		"Sync profile",
	);
	if (value.formatVersion !== undefined && value.formatVersion !== CONFIG_SYNC_VERSION) {
		throw new Error(`Unsupported sync profile version: ${String(value.formatVersion)}`);
	}
	if (value.virtualHostedStyle !== undefined && typeof value.virtualHostedStyle !== "boolean") {
		throw new Error("Sync profile virtualHostedStyle must be a boolean");
	}
	if (value.autoPush !== undefined && typeof value.autoPush !== "boolean") {
		throw new Error("Sync profile autoPush must be a boolean");
	}
	const bucket = value.bucket;
	const prefix = value.prefix;
	if (typeof bucket !== "string" || bucket.trim().length === 0) throw new Error("Sync profile bucket is required");
	if (typeof prefix !== "string" || prefix.trim().length === 0) throw new Error("Sync profile prefix is required");
	const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
	if (normalizedPrefix.length === 0) throw new Error("Sync profile prefix must contain a non-slash character");
	const retention = value.retention;
	if (retention !== undefined && !isRecord(retention)) throw new Error("Sync profile retention must be a mapping");
	if (isRecord(retention)) {
		assertExactKeys(retention, ["revisions", "days", "inactiveWriterDays"], "Sync profile retention");
	}
	const numeric = (field: string): number | undefined => {
		const raw = retention?.[field];
		if (raw === undefined) return undefined;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
			throw new Error(`Sync profile retention.${field} must be a non-negative integer`);
		}
		return raw;
	};
	const passphraseEnv =
		optionalString(value.passphraseEnv, "Sync profile passphraseEnv") ?? DEFAULT_SYNC_PASSPHRASE_ENV;
	if (!/^[A-Z_][A-Z0-9_]*$/.test(passphraseEnv))
		throw new Error("Sync profile passphraseEnv must be an environment variable name");
	const accessKeyIdEnv = optionalEnvName(value.accessKeyIdEnv, "Sync profile accessKeyIdEnv");
	const secretAccessKeyEnv = optionalEnvName(value.secretAccessKeyEnv, "Sync profile secretAccessKeyEnv");
	const sessionTokenEnv = optionalEnvName(value.sessionTokenEnv, "Sync profile sessionTokenEnv");
	return {
		formatVersion: CONFIG_SYNC_VERSION,
		bucket: bucket.trim(),
		prefix: normalizedPrefix,
		endpoint: optionalString(value.endpoint, "Sync profile endpoint"),
		region: optionalString(value.region, "Sync profile region"),
		virtualHostedStyle: value.virtualHostedStyle === true ? true : undefined,
		passphraseEnv,
		accessKeyIdEnv,
		secretAccessKeyEnv,
		sessionTokenEnv,
		autoPush: value.autoPush === true ? true : undefined,
		retention: retention
			? {
					revisions: numeric("revisions"),
					days: numeric("days"),
					inactiveWriterDays: numeric("inactiveWriterDays"),
				}
			: undefined,
	};
}

function optionalEnvName(value: unknown, name: string): string | undefined {
	const result = optionalString(value, name);
	if (result !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(result))
		throw new Error(`${name} must be an environment variable name`);
	return result;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(record).find(key => !allowed.includes(key));
	if (unknown !== undefined) throw new Error(`${label} contains unsupported field ${unknown}`);
}

export async function loadSyncProfile(agentDir: string): Promise<SyncProfile | null> {
	try {
		return parseSyncProfile(YAML.parse(await Bun.file(getSyncProfilePath(agentDir)).text()));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function saveSyncProfile(agentDir: string, profile: SyncProfile): Promise<void> {
	const normalized = parseSyncProfile(profile);
	const filePath = getSyncProfilePath(agentDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await withFileLock(filePath, async () => writeAtomically(filePath, YAML.stringify(normalized, null, 2)));
}

function parseSyncState(value: unknown): SyncState {
	if (!isRecord(value)) throw new Error("Sync state must be an object");
	if (typeof value.writerId !== "string" || value.writerId.length === 0)
		throw new Error("Sync state writerId is required");
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
		throw new Error("Sync state sequence must be a non-negative integer");
	}
	return {
		formatVersion: CONFIG_SYNC_VERSION,
		writerId: value.writerId,
		sequence: value.sequence,
		lastPublicationId: optionalString(value.lastPublicationId, "Sync state lastPublicationId"),
		lastRevisionId: optionalString(value.lastRevisionId, "Sync state lastRevisionId"),
		lastPayloadHash: optionalString(value.lastPayloadHash, "Sync state lastPayloadHash"),
	};
}

export async function loadSyncState(agentDir: string): Promise<SyncState> {
	try {
		return parseSyncState(await Bun.file(getSyncStatePath(agentDir)).json());
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return { formatVersion: CONFIG_SYNC_VERSION, writerId: randomUUID(), sequence: 0 };
	}
}

export async function saveSyncState(agentDir: string, state: SyncState): Promise<void> {
	const normalized = parseSyncState(state);
	const filePath = getSyncStatePath(agentDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await withFileLock(filePath, async () => writeAtomically(filePath, `${JSON.stringify(normalized, null, 2)}\n`));
}

export function requireSyncPassphrase(profile: SyncProfile): string {
	const passphrase = process.env[profile.passphraseEnv];
	if (!passphrase)
		throw new Error(`Set ${profile.passphraseEnv} before exporting, importing, or syncing configuration`);
	return passphrase;
}
