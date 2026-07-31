import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredential, AuthStorage, AuthStorageData } from "@oh-my-pi/pi-ai";
import { isEnoent, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { withFileLock } from "../config/file-lock";
import { ModelsConfigFile } from "../config/models-config";
import { Settings } from "../config/settings";
import { validateServerConfig } from "../mcp/config";
import type { MCPConfigFile } from "../mcp/types";
import { assertConfigSnapshot, decryptConfigBundle, encryptConfigSnapshot, hashStableJson } from "./crypto";
import { parseSyncProfile } from "./profile";
import { CONFIG_BUNDLE_VERSION, type ConfigFileEntry, type ConfigSnapshot, type EncryptedConfigBundle } from "./types";

const SINGLE_FILES = ["mcp.json", "RULES.md", "sync.yml"] as const;
const CONFIG_CANDIDATES = [...MAIN_CONFIG_FILENAMES] as const;
const MODEL_CANDIDATES = ["models.yml", "models.yaml"] as const;
const DIRECTORY_RULES = {
	themes: (relative: string) => !relative.includes("/") && relative.endsWith(".json"),
	agents: (relative: string) => !relative.includes("/") && relative.endsWith(".md"),
	skills: (_relative: string) => true,
} satisfies Record<string, (relative: string) => boolean>;

export interface ApplyConfigSnapshotOptions {
	replace?: boolean;
}

export interface ImportEncryptedBundleOptions extends ApplyConfigSnapshotOptions {
	dryRun?: boolean;
}

export interface ConfigBundleSummary {
	files: string[];
	authProviders: string[];
	payloadHash: string;
}

export async function collectConfigSnapshot(agentDir: string, authStorage: AuthStorage): Promise<ConfigSnapshot> {
	const files: ConfigFileEntry[] = [];
	const selectedConfig = await firstExisting(agentDir, CONFIG_CANDIDATES);
	if (selectedConfig) files.push(await readEntry(agentDir, selectedConfig));
	const selectedModels = await firstExisting(agentDir, MODEL_CANDIDATES);
	if (selectedModels) files.push(await readEntry(agentDir, selectedModels));
	for (const relativePath of SINGLE_FILES) {
		if (!(await regularFileExists(path.join(agentDir, relativePath)))) continue;
		const entry = await readEntry(agentDir, relativePath);
		if (relativePath === "sync.yml") parseSyncProfile(YAML.parse(decodeEntry(entry).toString("utf8")));
		files.push(entry);
	}
	for (const [directory, accepts] of Object.entries(DIRECTORY_RULES)) {
		files.push(...(await collectDirectory(agentDir, directory, accepts)));
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	await authStorage.reload();
	return {
		formatVersion: CONFIG_BUNDLE_VERSION,
		createdAt: new Date().toISOString(),
		files,
		auth: structuredClone(authStorage.getAll()),
	};
}

export async function exportEncryptedBundle(
	agentDir: string,
	authStorage: AuthStorage,
	passphrase: string,
): Promise<{ bundle: EncryptedConfigBundle; snapshot: ConfigSnapshot }> {
	const snapshot = await collectConfigSnapshot(agentDir, authStorage);
	return { bundle: await encryptConfigSnapshot(snapshot, passphrase), snapshot };
}

export async function importEncryptedBundle(
	agentDir: string,
	authStorage: AuthStorage,
	bundle: EncryptedConfigBundle,
	passphrase: string,
	options: ImportEncryptedBundleOptions = {},
): Promise<{ snapshot: ConfigSnapshot; summary: ConfigBundleSummary }> {
	const snapshot = await decryptConfigBundle(bundle, passphrase);
	await validateConfigSnapshot(snapshot);
	const summary = summarizeConfigSnapshot(snapshot);
	if (!options.dryRun) await applyConfigSnapshot(agentDir, authStorage, snapshot, options);
	return { snapshot, summary };
}

export function summarizeConfigSnapshot(snapshot: ConfigSnapshot): ConfigBundleSummary {
	return {
		files: snapshot.files.map(entry => entry.path).sort(),
		authProviders: Object.keys(snapshot.auth).sort(),
		payloadHash: hashStableJson({ files: snapshot.files, auth: snapshot.auth }),
	};
}

export async function validateConfigSnapshot(snapshot: ConfigSnapshot): Promise<void> {
	assertConfigSnapshot(snapshot);
	const seen = new Set<string>();
	for (const entry of snapshot.files) {
		assertAllowedRelativePath(entry.path);
		if (seen.has(entry.path)) throw new Error(`Duplicate config bundle path: ${entry.path}`);
		seen.add(entry.path);
		decodeEntry(entry);
	}
	for (const candidates of [CONFIG_CANDIDATES, MODEL_CANDIDATES]) {
		const count = candidates.filter(candidate => seen.has(candidate)).length;
		if (count > 1) throw new Error(`Config bundle contains competing files: ${candidates.join(", ")}`);
	}

	const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-bundle-"));
	try {
		for (const entry of snapshot.files) await writeEntry(stagingDir, entry);
		if (CONFIG_CANDIDATES.some(candidate => seen.has(candidate))) {
			await Settings.loadReadOnly({ agentDir: stagingDir, cwd: stagingDir });
		}
		const modelsPath = MODEL_CANDIDATES.find(candidate => seen.has(candidate));
		if (modelsPath) {
			const result = await ModelsConfigFile.relocate(path.join(stagingDir, modelsPath)).tryLoadAsync();
			if (result.status === "error") throw result.error;
		}
		const mcpEntry = snapshot.files.find(entry => entry.path === "mcp.json");
		if (mcpEntry) validateMcpConfig(JSON.parse(decodeEntry(mcpEntry).toString("utf8")) as MCPConfigFile);
		for (const entry of snapshot.files) {
			if (entry.path.startsWith("themes/")) JSON.parse(decodeEntry(entry).toString("utf8"));
			if (entry.path === "sync.yml") parseSyncProfile(YAML.parse(decodeEntry(entry).toString("utf8")));
		}
	} finally {
		await fs.rm(stagingDir, { recursive: true, force: true });
	}
}

export async function applyConfigSnapshot(
	agentDir: string,
	authStorage: AuthStorage,
	snapshot: ConfigSnapshot,
	options: ApplyConfigSnapshotOptions = {},
): Promise<void> {
	await validateConfigSnapshot(snapshot);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const lockPath = path.join(agentDir, ".config-sync-import");
	await withFileLock(lockPath, async () => {
		const incoming = new Map(snapshot.files.map(entry => [entry.path, entry]));
		const existing = options.replace ? await listExistingAllowedFiles(agentDir) : [];
		const touched = new Set([...incoming.keys(), ...existing.filter(relative => !incoming.has(relative))]);
		const backups = await captureFiles(agentDir, touched);
		await authStorage.reload();
		const previousAuth = structuredClone(authStorage.getAll());
		try {
			for (const entry of snapshot.files) await writeEntry(agentDir, entry);
			if (options.replace) {
				for (const relativePath of existing) {
					if (!incoming.has(relativePath)) await removeAllowedFile(agentDir, relativePath);
				}
			}
			await applyAuth(authStorage, snapshot.auth, options.replace === true);
		} catch (error) {
			await restoreFiles(agentDir, touched, backups);
			await replaceAllAuth(authStorage, previousAuth).catch(() => undefined);
			throw error;
		}
	});
}

async function collectDirectory(
	agentDir: string,
	directory: string,
	accepts: (relative: string) => boolean,
): Promise<ConfigFileEntry[]> {
	const root = path.join(agentDir, directory);
	const rootStat = await fs.lstat(root).catch(error => {
		if (isEnoent(error)) return null;
		throw error;
	});
	if (rootStat === null) return [];
	if (rootStat.isSymbolicLink()) throw new Error(`Refusing to export symlinked config directory: ${directory}`);
	if (!rootStat.isDirectory()) throw new Error(`Config resource is not a directory: ${directory}`);
	const entries: ConfigFileEntry[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		for (const child of await fs.readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, child.name);
			const relativeInside = path.relative(root, absolute).split(path.sep).join("/");
			if (child.isSymbolicLink())
				throw new Error(`Refusing to export symlinked config resource: ${directory}/${relativeInside}`);
			if (child.isDirectory()) {
				if (directory !== "skills") throw new Error(`Nested directories are not supported under ${directory}`);
				pending.push(absolute);
				continue;
			}
			if (!child.isFile() || !accepts(relativeInside)) continue;
			entries.push(await readEntry(agentDir, `${directory}/${relativeInside}`));
		}
	}
	return entries;
}

async function firstExisting(agentDir: string, candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await regularFileExists(path.join(agentDir, candidate))) return candidate;
	}
	return undefined;
}

async function regularFileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to export symlinked config resource: ${filePath}`);
		if (!stat.isFile()) throw new Error(`Config resource is not a regular file: ${filePath}`);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readEntry(agentDir: string, relativePath: string): Promise<ConfigFileEntry> {
	assertAllowedRelativePath(relativePath);
	const absolute = path.join(agentDir, ...relativePath.split("/"));
	const stat = await fs.lstat(absolute);
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new Error(`Config resource is not a regular file: ${relativePath}`);
	return { path: relativePath, content: (await fs.readFile(absolute)).toString("base64"), mode: stat.mode & 0o777 };
}

function decodeEntry(entry: ConfigFileEntry): Buffer {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)) {
		throw new Error(`Config resource is not valid base64: ${entry.path}`);
	}
	return Buffer.from(entry.content, "base64");
}

function assertAllowedRelativePath(relativePath: string): void {
	if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\")) {
		throw new Error(`Unsafe config bundle path: ${relativePath}`);
	}
	const segments = relativePath.split("/");
	if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`Unsafe config bundle path: ${relativePath}`);
	}
	if (CONFIG_CANDIDATES.includes(relativePath as (typeof CONFIG_CANDIDATES)[number])) return;
	if (MODEL_CANDIDATES.includes(relativePath as (typeof MODEL_CANDIDATES)[number])) return;
	if ((SINGLE_FILES as readonly string[]).includes(relativePath)) return;
	const [root, ...rest] = segments;
	const accepts = DIRECTORY_RULES[root as keyof typeof DIRECTORY_RULES];
	if (!accepts || rest.length === 0 || !accepts(rest.join("/")))
		throw new Error(`Unsupported config bundle path: ${relativePath}`);
}

async function writeEntry(agentDir: string, entry: ConfigFileEntry): Promise<void> {
	assertAllowedRelativePath(entry.path);
	const target = path.join(agentDir, ...entry.path.split("/"));
	await assertSafeParent(agentDir, path.dirname(target));
	try {
		const existing = await fs.lstat(target);
		if (existing.isSymbolicLink()) throw new Error(`Refusing to overwrite symlinked config resource: ${entry.path}`);
		if (!existing.isFile()) throw new Error(`Config resource target is not a regular file: ${entry.path}`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, decodeEntry(entry), { mode: entry.mode ?? 0o600 });
		await fs.rename(tempPath, target);
		await fs.chmod(target, entry.mode ?? 0o600);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function assertSafeParent(agentDir: string, parent: string): Promise<void> {
	const relative = path.relative(agentDir, parent);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Config resource escapes agent directory: ${parent}`);
	let current = agentDir;
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe config resource parent: ${current}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			await fs.mkdir(current, { mode: 0o700 });
		}
	}
}

function validateMcpConfig(config: MCPConfigFile): void {
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("mcp.json must contain an object");
	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		const errors = validateServerConfig(name, server);
		if (errors.length > 0) throw new Error(`Invalid MCP server ${name}: ${errors.join("; ")}`);
	}
}

async function listExistingAllowedFiles(agentDir: string): Promise<string[]> {
	const snapshot: ConfigFileEntry[] = [];
	const selectedConfig = await firstExisting(agentDir, CONFIG_CANDIDATES);
	if (selectedConfig) snapshot.push(await readEntry(agentDir, selectedConfig));
	for (const candidate of CONFIG_CANDIDATES) {
		if (candidate !== selectedConfig && (await regularFileExists(path.join(agentDir, candidate))))
			snapshot.push(await readEntry(agentDir, candidate));
	}
	for (const candidate of MODEL_CANDIDATES)
		if (await regularFileExists(path.join(agentDir, candidate))) snapshot.push(await readEntry(agentDir, candidate));
	for (const relativePath of SINGLE_FILES)
		if (await regularFileExists(path.join(agentDir, relativePath)))
			snapshot.push(await readEntry(agentDir, relativePath));
	for (const [directory, accepts] of Object.entries(DIRECTORY_RULES)) {
		snapshot.push(...(await collectDirectory(agentDir, directory, accepts)));
	}
	return snapshot.map(entry => entry.path);
}

async function captureFiles(agentDir: string, relativePaths: Iterable<string>): Promise<Map<string, ConfigFileEntry>> {
	const backups = new Map<string, ConfigFileEntry>();
	for (const relativePath of relativePaths) {
		if (await regularFileExists(path.join(agentDir, ...relativePath.split("/"))))
			backups.set(relativePath, await readEntry(agentDir, relativePath));
	}
	return backups;
}

async function restoreFiles(
	agentDir: string,
	relativePaths: Iterable<string>,
	backups: ReadonlyMap<string, ConfigFileEntry>,
): Promise<void> {
	for (const relativePath of relativePaths) {
		const backup = backups.get(relativePath);
		if (backup) await writeEntry(agentDir, backup);
		else await removeAllowedFile(agentDir, relativePath);
	}
}

async function removeAllowedFile(agentDir: string, relativePath: string): Promise<void> {
	assertAllowedRelativePath(relativePath);
	const target = path.join(agentDir, ...relativePath.split("/"));
	try {
		const stat = await fs.lstat(target);
		if (stat.isSymbolicLink() || !stat.isFile())
			throw new Error(`Refusing to remove unsafe config resource: ${relativePath}`);
		await fs.rm(target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function applyAuth(authStorage: AuthStorage, incoming: AuthStorageData, replace: boolean): Promise<void> {
	const current = authStorage.getAll();
	if (replace)
		for (const provider of Object.keys(current)) if (!(provider in incoming)) await authStorage.remove(provider);
	for (const [provider, entry] of Object.entries(incoming)) {
		if (replace) await authStorage.remove(provider);
		for (const credential of normalizeAuthEntry(entry))
			authStorage.upsertCredential(provider, structuredClone(credential));
	}
}

async function replaceAllAuth(authStorage: AuthStorage, auth: AuthStorageData): Promise<void> {
	for (const provider of Object.keys(authStorage.getAll())) await authStorage.remove(provider);
	for (const [provider, entry] of Object.entries(auth)) {
		for (const credential of normalizeAuthEntry(entry))
			authStorage.upsertCredential(provider, structuredClone(credential));
	}
}

function normalizeAuthEntry(entry: AuthCredential | AuthCredential[]): AuthCredential[] {
	return Array.isArray(entry) ? entry : [entry];
}
