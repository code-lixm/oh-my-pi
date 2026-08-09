import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { writeSyncLocalFileAtomically } from "./profile";
import { SYNC_BOOTSTRAP_BUNDLE_VERSION, type SyncPendingAdoption, type SyncProfile } from "./types";

const PENDING_ADOPTION_FILE = "sync-pending-adoption.json";

export function getPendingAdoptionPath(agentDir: string): string {
	return path.join(agentDir, PENDING_ADOPTION_FILE);
}

export async function loadPendingAdoption(agentDir: string): Promise<SyncPendingAdoption | null> {
	try {
		const value: unknown = await Bun.file(getPendingAdoptionPath(agentDir)).json();
		return parsePendingAdoption(value);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export async function savePendingAdoption(agentDir: string, profile: SyncProfile): Promise<SyncPendingAdoption> {
	const pending: SyncPendingAdoption = {
		format: "omp-sync-pending-adoption",
		formatVersion: SYNC_BOOTSTRAP_BUNDLE_VERSION,
		createdAt: new Date().toISOString(),
		bucket: profile.bucket,
		prefix: profile.prefix,
		autoPush: profile.autoPush === true,
	};
	const filePath = getPendingAdoptionPath(agentDir);
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await withFileLock(filePath, async () =>
		writeSyncLocalFileAtomically(filePath, `${JSON.stringify(pending, null, 2)}\n`),
	);
	return pending;
}

export async function removePendingAdoption(agentDir: string): Promise<void> {
	const filePath = getPendingAdoptionPath(agentDir);
	await withFileLock(filePath, async () => {
		await fs.rm(filePath, { force: true });
	});
}

function parsePendingAdoption(value: unknown): SyncPendingAdoption {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Pending sync adoption marker must be an object");
	}
	const record = value as Record<string, unknown>;
	assertExactKeys(record, ["format", "formatVersion", "createdAt", "bucket", "prefix", "autoPush"]);
	if (record.format !== "omp-sync-pending-adoption") throw new Error("Unsupported pending sync adoption format");
	if (record.formatVersion !== SYNC_BOOTSTRAP_BUNDLE_VERSION) {
		throw new Error(`Unsupported pending sync adoption version: ${String(record.formatVersion)}`);
	}
	if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
		throw new Error("Pending sync adoption createdAt must be an ISO timestamp");
	}
	if (typeof record.bucket !== "string" || record.bucket.length === 0) {
		throw new Error("Pending sync adoption bucket is required");
	}
	if (typeof record.prefix !== "string") throw new Error("Pending sync adoption prefix must be a string");
	if (typeof record.autoPush !== "boolean") throw new Error("Pending sync adoption autoPush must be a boolean");
	return {
		format: "omp-sync-pending-adoption",
		formatVersion: SYNC_BOOTSTRAP_BUNDLE_VERSION,
		createdAt: record.createdAt,
		bucket: record.bucket,
		prefix: record.prefix,
		autoPush: record.autoPush,
	};
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = Object.keys(record).find(key => !allowed.includes(key));
	if (unknown !== undefined) throw new Error(`Pending sync adoption marker contains unsupported field ${unknown}`);
}
