import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProfileRootDir } from "@oh-my-pi/pi-utils/dirs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const INDEX_KEY_RE = /^[a-f0-9]{64}$/;
const STORAGE_LAYOUT_VERSION = "v1";

function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

async function tryChmod(targetPath: string, mode: number): Promise<void> {
	try {
		await fs.chmod(targetPath, mode);
	} catch {
		// Best-effort only (e.g. Windows).
	}
}

export function getCodeGraphStorageRoot(): string {
	return path.join(getProfileRootDir(undefined), "codegraph", STORAGE_LAYOUT_VERSION);
}

export function getCodeGraphIndexesRoot(): string {
	return path.join(getCodeGraphStorageRoot(), "indexes");
}

export function isCodeGraphIndexKey(value: string): boolean {
	return INDEX_KEY_RE.test(value);
}

export async function ensureSecureDir(dirPath: string): Promise<string> {
	const resolved = path.resolve(dirPath);
	await fs.mkdir(resolved, { recursive: true, mode: DIR_MODE });
	await tryChmod(resolved, DIR_MODE);
	return resolved;
}

export async function ensureCodeGraphIndexDir(key: string): Promise<string> {
	if (!isCodeGraphIndexKey(key)) {
		throw new Error(`Invalid CodeGraph index key: ${JSON.stringify(key)}`);
	}
	await ensureSecureDir(getCodeGraphIndexesRoot());
	return ensureSecureDir(path.join(getCodeGraphIndexesRoot(), key));
}

export async function readTextFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
}

export async function writeTextFileAtomically(filePath: string, content: string): Promise<void> {
	const parentDir = await ensureSecureDir(path.dirname(filePath));
	const tempPath = path.join(parentDir, `${path.basename(filePath)}.${process.pid}.${Bun.randomUUIDv7()}.tmp`);
	let renamed = false;
	try {
		await fs.writeFile(tempPath, content, { mode: FILE_MODE });
		await tryChmod(tempPath, FILE_MODE);
		await fs.rename(tempPath, filePath);
		renamed = true;
		await tryChmod(filePath, FILE_MODE);
	} finally {
		if (!renamed) {
			try {
				await fs.rm(tempPath, { force: true });
			} catch {
				// Best-effort cleanup only.
			}
		}
	}
}

export async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

export async function removeDirectoryIfExists(dirPath: string, options: { dryRun?: boolean } = {}): Promise<boolean> {
	const existed = await pathExists(dirPath);
	if (!existed) return false;
	if (options.dryRun === true) return false;
	await fs.rm(dirPath, { recursive: true, force: true });
	return true;
}

export async function listDirectoryEntries(dirPath: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dirPath, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
}
