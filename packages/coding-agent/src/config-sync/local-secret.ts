import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

export const LOCAL_SYNC_PASSPHRASE_SETTING_PATH = "sync.localPassphrase" as const;

const LOCAL_SYNC_PASSPHRASE_FILE = "sync-passphrase";
const MAX_SYNC_PASSPHRASE_BYTES = 8 * 1024;

export function getLocalSyncPassphrasePath(agentDir: string): string {
	return path.join(agentDir, LOCAL_SYNC_PASSPHRASE_FILE);
}

/** Read the device-local encryption passphrase without consulting synced settings. */
export function readLocalSyncPassphrase(agentDir: string): string | undefined {
	try {
		const value = fs.readFileSync(getLocalSyncPassphrasePath(agentDir), "utf8");
		if (value.length === 0) return undefined;
		validatePassphrase(value);
		return value;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Atomically replace the device-local encryption passphrase; an empty value clears it. */
export function writeLocalSyncPassphrase(agentDir: string, value: string): void {
	if (value.length === 0) {
		removeLocalSyncPassphrase(agentDir);
		return;
	}
	validatePassphrase(value);
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const targetPath = getLocalSyncPassphrasePath(agentDir);
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(tempPath, "wx", 0o600);
		fs.writeFileSync(descriptor, value, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(tempPath, targetPath);
		try {
			fs.chmodSync(targetPath, 0o600);
		} catch {
			// Best effort on platforms without POSIX permission bits.
		}
	} catch (error) {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {}
		throw error;
	}
}

export function removeLocalSyncPassphrase(agentDir: string): void {
	try {
		fs.rmSync(getLocalSyncPassphrasePath(agentDir));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function validatePassphrase(value: string): void {
	if (value.includes("\0")) throw new Error("Local sync encryption key must not contain NUL bytes");
	if (Buffer.byteLength(value, "utf8") > MAX_SYNC_PASSPHRASE_BYTES) {
		throw new Error(`Local sync encryption key must not exceed ${MAX_SYNC_PASSPHRASE_BYTES} bytes`);
	}
}
