import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runSyncCommand } from "../src/cli/sync-cli";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { getPendingAdoptionPath, loadPendingAdoption, savePendingAdoption } from "../src/config-sync/adoption";
import { exportSyncBootstrap, importSyncBootstrap } from "../src/config-sync/bootstrap";
import {
	applyConfigSnapshot,
	collectConfigSnapshot,
	exportEncryptedBundle,
	importEncryptedBundle,
} from "../src/config-sync/bundle";
import { decryptConfigBundle, encryptConfigSnapshot, hashStableJson, stableJson } from "../src/config-sync/crypto";
import {
	getLocalSyncPassphrasePath,
	readLocalSyncPassphrase,
	removeLocalSyncPassphrase,
	writeLocalSyncPassphrase,
} from "../src/config-sync/local-secret";
import { mergeSnapshots } from "../src/config-sync/merge";
import {
	getSyncStatePath,
	isSyncProfileEnabled,
	loadSyncProfile,
	loadSyncState,
	parseSyncProfile,
	requireSyncPassphrase,
	saveSyncProfile,
	saveSyncState,
} from "../src/config-sync/profile";
import { loadRemoteGraph, publishSnapshot } from "../src/config-sync/protocol";
import { synchronizeConfiguration } from "../src/config-sync/service";
import {
	type ConfigSyncS3Client,
	createConfigPublication,
	createConfigRevision,
	S3ConfigSyncStore,
} from "../src/config-sync/store";
import {
	CONFIG_BUNDLE_VERSION,
	CONFIG_SYNC_VERSION,
	type ConfigConflictDocument,
	type ConfigFileEntry,
	type ConfigSnapshot,
	type EncryptedConfigBundle,
	SYNC_BOOTSTRAP_BUNDLE_VERSION,
	type SyncProfile,
} from "../src/config-sync/types";
import { type AuthCredential, AuthStorage } from "../src/session/auth-storage";

class MemoryConfigSyncS3Client implements ConfigSyncS3Client {
	readonly #objects = new Map<string, string>();

	file(key: string): { text(): Promise<string> } {
		return {
			text: async () => {
				const content = this.#objects.get(key);
				if (content === undefined) throw Object.assign(new Error(`No such key: ${key}`), { status: 404 });
				return content;
			},
		};
	}

	async write(key: string, content: string): Promise<number> {
		this.#objects.set(key, content);
		return content.length;
	}

	async list(input?: { prefix?: string }): Promise<{ contents: Array<{ key: string }>; isTruncated: boolean }> {
		const prefix = input?.prefix ?? "";
		return {
			contents: [...this.#objects.keys()]
				.filter(key => key.startsWith(prefix))
				.sort()
				.map(key => ({ key })),
			isTruncated: false,
		};
	}

	async delete(key: string): Promise<void> {
		this.#objects.delete(key);
	}
}

function configFile(relativePath: string, content: string | Uint8Array): ConfigFileEntry {
	return { path: relativePath, content: Buffer.from(content).toString("base64"), mode: 0o600 };
}

function apiKey(key: string): AuthCredential {
	return { type: "api_key", key, source: "login" };
}

function configSnapshot(files: ConfigFileEntry[], auth: ConfigSnapshot["auth"]): ConfigSnapshot {
	return {
		formatVersion: CONFIG_BUNDLE_VERSION,
		createdAt: "2026-07-31T00:00:00.000Z",
		files,
		auth,
	};
}

function createStore(): S3ConfigSyncStore {
	return new S3ConfigSyncStore(
		parseSyncProfile({
			bucket: "config-sync-test-bucket",
			prefix: "config-sync-tests",
			passphraseEnv: "CONFIG_SYNC_TEST_PASSPHRASE",
		}),
		{ client: new MemoryConfigSyncS3Client() },
	);
}

function protocolBundle(ciphertext: string): EncryptedConfigBundle {
	return {
		format: "omp-config-bundle",
		formatVersion: CONFIG_BUNDLE_VERSION,
		encryption: {
			algorithm: "AES-256-GCM",
			kdf: "PBKDF2-SHA-256",
			iterations: 1,
			salt: "protocol-salt",
			iv: "protocol-iv",
		},
		ciphertext,
	};
}

describe("config sync encrypted publication", () => {
	it("preserves allowlisted file bytes and stored credentials through encrypted S3 publication", async () => {
		const tempDir = TempDir.createSync("@pi-config-sync-publication-");
		let sourceAuth: AuthStorage | undefined;
		let targetAuth: AuthStorage | undefined;
		try {
			const sourceDir = tempDir.join("source");
			const targetDir = tempDir.join("target");
			const binarySkill = new Uint8Array([0, 255, 0, 66, 10]);
			await fs.mkdir(path.join(sourceDir, "themes"), { recursive: true });
			await fs.mkdir(path.join(sourceDir, "skills"), { recursive: true });
			await Promise.all([
				fs.writeFile(path.join(sourceDir, "RULES.md"), "source rules\n"),
				fs.writeFile(path.join(sourceDir, "themes", "solarized.json"), '{"background":"#002b36"}\n'),
				fs.writeFile(path.join(sourceDir, "skills", "binary.dat"), binarySkill),
				fs.writeFile(path.join(sourceDir, "not-synced.txt"), "must stay local\n"),
			]);

			sourceAuth = await AuthStorage.create(tempDir.join("source-auth.db"));
			sourceAuth.upsertCredential("source-provider", apiKey("source-key"));
			const exported = await exportEncryptedBundle(sourceDir, sourceAuth, "publication passphrase");
			expect(exported.snapshot.files.map(entry => entry.path)).toEqual([
				"RULES.md",
				"skills/binary.dat",
				"themes/solarized.json",
			]);
			expect(exported.snapshot.auth).toEqual({ "source-provider": apiKey("source-key") });

			const store = createStore();
			const published = await publishSnapshot(store, {
				bundle: exported.bundle,
				parents: [],
				writerId: "source-writer",
				sequence: 7,
				epochId: "publication-test",
			});
			const graph = await loadRemoteGraph(store);
			expect(graph.quarantined).toEqual([]);
			expect(graph.tips.map(tip => tip.publicationId)).toEqual([published.publication.publicationId]);

			const remoteRevision = graph.revisions.get(published.revision.revisionId);
			if (!remoteRevision) throw new Error("Expected published revision in remote graph");
			targetAuth = await AuthStorage.create(tempDir.join("target-auth.db"));
			const imported = await importEncryptedBundle(
				targetDir,
				targetAuth,
				remoteRevision.bundle,
				"publication passphrase",
				{
					replace: true,
				},
			);

			expect(imported.snapshot).toEqual(exported.snapshot);
			expect(await fs.readFile(path.join(targetDir, "RULES.md"), "utf8")).toBe("source rules\n");
			expect(await fs.readFile(path.join(targetDir, "themes", "solarized.json"), "utf8")).toBe(
				'{"background":"#002b36"}\n',
			);
			expect(await fs.readFile(path.join(targetDir, "skills", "binary.dat"))).toEqual(Buffer.from(binarySkill));
			expect(await Bun.file(path.join(targetDir, "not-synced.txt")).exists()).toBe(false);
			expect(targetAuth.getAll()).toEqual({ "source-provider": apiKey("source-key") });
		} finally {
			sourceAuth?.close();
			targetAuth?.close();
			tempDir.removeSync();
		}
	});

	it("omits stale and malformed legacy sync.yml files from collected and exported snapshots", async () => {
		const tempDir = TempDir.createSync("@pi-config-sync-legacy-snapshot-");
		try {
			for (const scenario of [
				{
					name: "stale",
					content: "bucket: stale-sync-bucket\nprefix: stale\npassphraseEnv: STALE_SYNC_PASSPHRASE\n",
				},
				{ name: "malformed", content: "bucket: [unterminated\nprefix: stale\n" },
			] as const) {
				const sourceDir = tempDir.join(scenario.name);
				const authStorage = await AuthStorage.create(tempDir.join(`${scenario.name}-auth.db`));
				try {
					await fs.mkdir(sourceDir, { recursive: true });
					await Promise.all([
						fs.writeFile(
							path.join(sourceDir, "config.yml"),
							"sync:\n  enabled: true\n  bucket: canonical-sync-bucket\n  prefix: canonical\n  passphraseEnv: CANONICAL_SYNC_PASSPHRASE\n",
						),
						fs.writeFile(path.join(sourceDir, "RULES.md"), "canonical rules\n"),
						fs.writeFile(path.join(sourceDir, "sync.yml"), scenario.content),
					]);

					const collected = await collectConfigSnapshot(sourceDir, authStorage);
					const collectedPaths = collected.files.map(entry => entry.path);
					expect(collectedPaths).toContain("config.yml");
					expect(collectedPaths).toContain("RULES.md");
					expect(collectedPaths).not.toContain("sync.yml");

					const exported = await exportEncryptedBundle(sourceDir, authStorage, "legacy snapshot passphrase");
					expect(exported.snapshot.files.map(entry => entry.path)).toEqual(collectedPaths);
					expect(
						(await decryptConfigBundle(exported.bundle, "legacy snapshot passphrase")).files.map(
							entry => entry.path,
						),
					).toEqual(collectedPaths);
				} finally {
					authStorage.close();
				}
			}
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("config sync crypto", () => {
	it("round-trips snapshots and fails closed for wrong passphrases or authenticated ciphertext changes", async () => {
		const original = configSnapshot([configFile("RULES.md", "rules\n")], { provider: apiKey("api-key") });
		const bundle = await encryptConfigSnapshot(original, "correct passphrase");
		expect(await decryptConfigBundle(bundle, "correct passphrase")).toEqual(original);

		const tamperedBytes = Buffer.from(bundle.ciphertext, "base64");
		const lastByte = tamperedBytes.at(-1);
		if (lastByte === undefined) throw new Error("Expected authenticated ciphertext");
		tamperedBytes[tamperedBytes.length - 1] = lastByte ^ 1;
		const tamperedBundle = { ...bundle, ciphertext: tamperedBytes.toString("base64") };
		const expectedError = "Unable to decrypt config bundle: invalid passphrase or authenticated ciphertext";
		await expect(decryptConfigBundle(bundle, "wrong passphrase")).rejects.toThrow(expectedError);
		await expect(decryptConfigBundle(tamperedBundle, "correct passphrase")).rejects.toThrow(expectedError);
	});
});

describe("config sync publication DAG", () => {
	it("keeps reachable tips regardless of writer sequence and quarantines missing or cross-wired parents", async () => {
		const store = createStore();
		const rootBundle = protocolBundle("root-ciphertext");
		const lowSequenceBundle = protocolBundle("low-sequence-ciphertext");
		const siblingBundle = protocolBundle("sibling-ciphertext");
		const metadataBundle = protocolBundle("metadata-ciphertext");
		const root = await publishSnapshot(store, {
			bundle: rootBundle,
			parents: [],
			writerId: "writer-root",
			sequence: 41,
			epochId: "graph-test",
		});
		const lowSequenceTip = await publishSnapshot(store, {
			bundle: lowSequenceBundle,
			parents: [root.publication],
			writerId: "writer-low-sequence",
			sequence: 0,
			epochId: "graph-test",
		});
		const siblingTip = await publishSnapshot(store, {
			bundle: siblingBundle,
			parents: [root.publication],
			writerId: "writer-sibling",
			sequence: 3,
			epochId: "graph-test",
		});

		const missingParentRevision = createConfigRevision({
			parentRevisionIds: [root.revision.revisionId],
			payloadHash: hashStableJson(metadataBundle),
			bundle: metadataBundle,
		});
		await store.putRevision(missingParentRevision);
		const missingPublicationId = "f".repeat(64);
		const missingParentPublication = createConfigPublication({
			epochId: "graph-test",
			writerId: "writer-missing-parent",
			sequence: 4,
			revisionId: missingParentRevision.revisionId,
			parents: [{ publicationId: missingPublicationId, revisionId: root.revision.revisionId }],
		});
		await store.put(
			store.publicationKey(missingParentPublication.publicationId),
			stableJson(missingParentPublication),
		);

		const pseudoMergeRevision = createConfigRevision({
			parentRevisionIds: [lowSequenceTip.revision.revisionId, siblingTip.revision.revisionId],
			payloadHash: hashStableJson(metadataBundle),
			bundle: metadataBundle,
		});
		await store.putRevision(pseudoMergeRevision);
		const pseudoMergePublication = createConfigPublication({
			epochId: "graph-test",
			writerId: "writer-pseudo-merge",
			sequence: 5,
			revisionId: pseudoMergeRevision.revisionId,
			parents: [
				{
					publicationId: lowSequenceTip.publication.publicationId,
					revisionId: siblingTip.revision.revisionId,
				},
				{
					publicationId: siblingTip.publication.publicationId,
					revisionId: lowSequenceTip.revision.revisionId,
				},
			],
		});
		await store.put(store.publicationKey(pseudoMergePublication.publicationId), stableJson(pseudoMergePublication));

		const graph = await loadRemoteGraph(store);
		const expectedTips = [lowSequenceTip.publication, siblingTip.publication]
			.sort((left, right) => left.publicationId.localeCompare(right.publicationId))
			.map(tip => ({ publicationId: tip.publicationId, writerId: tip.writerId, sequence: tip.sequence }));
		expect(
			graph.tips.map(tip => ({ publicationId: tip.publicationId, writerId: tip.writerId, sequence: tip.sequence })),
		).toEqual(expectedTips);
		expect(graph.publications.has(missingParentPublication.publicationId)).toBe(false);
		expect(graph.publications.has(pseudoMergePublication.publicationId)).toBe(false);
		expect(graph.quarantined).toHaveLength(2);

		const quarantines = new Map(graph.quarantined.map(entry => [entry.key, entry.reason]));
		expect(quarantines.get(store.publicationKey(missingParentPublication.publicationId))).toBe(
			`missing or inconsistent publication parent ${missingPublicationId}`,
		);
		const pseudoMergeParent = pseudoMergePublication.parents[0];
		if (!pseudoMergeParent) throw new Error("Expected pseudo merge parent");
		expect(quarantines.get(store.publicationKey(pseudoMergePublication.publicationId))).toBe(
			`missing or inconsistent publication parent ${pseudoMergeParent.publicationId}`,
		);
	});
});

describe("config sync snapshot application", () => {
	for (const scenario of [
		{ replace: false, keepsLocalResources: true, name: "merge" },
		{ replace: true, keepsLocalResources: false, name: "replace" },
	] as const) {
		it(`${scenario.name}s incoming files and auth without crossing deletion boundaries`, async () => {
			const tempDir = TempDir.createSync(`@pi-config-sync-${scenario.name}-`);
			let authStorage: AuthStorage | undefined;
			try {
				const agentDir = tempDir.join("agent");
				await fs.mkdir(path.join(agentDir, "themes"), { recursive: true });
				await fs.writeFile(path.join(agentDir, "RULES.md"), "local rules\n");
				await fs.writeFile(path.join(agentDir, "themes", "local.json"), '{"local":true}\n');
				authStorage = await AuthStorage.create(tempDir.join("auth.db"));
				authStorage.upsertCredential("local-provider", apiKey("local-key"));

				await applyConfigSnapshot(
					agentDir,
					authStorage,
					configSnapshot([configFile("RULES.md", "remote rules\n")], { "remote-provider": apiKey("remote-key") }),
					{ replace: scenario.replace },
				);

				expect(await fs.readFile(path.join(agentDir, "RULES.md"), "utf8")).toBe("remote rules\n");
				expect(await Bun.file(path.join(agentDir, "themes", "local.json")).exists()).toBe(
					scenario.keepsLocalResources,
				);
				if (scenario.keepsLocalResources) {
					expect(await fs.readFile(path.join(agentDir, "themes", "local.json"), "utf8")).toBe('{"local":true}\n');
				}
				expect(authStorage.getAll()).toEqual(
					scenario.keepsLocalResources
						? { "local-provider": apiKey("local-key"), "remote-provider": apiKey("remote-key") }
						: { "remote-provider": apiKey("remote-key") },
				);
			} finally {
				authStorage?.close();
				tempDir.removeSync();
			}
		});
	}
});

describe("config sync snapshot merge", () => {
	it("combines independent file and auth changes without fabricating a conflict", () => {
		const base = configSnapshot([configFile("RULES.md", "base rules\n")], { provider: apiKey("base-key") });
		const local = configSnapshot([configFile("RULES.md", "local rules\n")], { provider: apiKey("base-key") });
		const remote = configSnapshot([configFile("RULES.md", "base rules\n")], { provider: apiKey("remote-key") });

		expect(mergeSnapshots(base, local, remote, { createdAt: "2026-07-31T00:00:01.000Z" })).toEqual({
			merged: {
				...configSnapshot([configFile("RULES.md", "local rules\n")], { provider: [apiKey("remote-key")] }),
				createdAt: "2026-07-31T00:00:01.000Z",
			},
			conflicts: [],
		});
	});
});

describe("config sync profile parsing", () => {
	it("falls back to malformed legacy sync YAML when config.yml has no sync settings", async () => {
		const tempDir = TempDir.createSync("@pi-config-sync-profile-");
		try {
			const settings = await Settings.init({ agentDir: tempDir.path(), cwd: tempDir.path() });
			settings.set("autocompleteMaxVisible", 17);
			await settings.flush();
			resetSettingsForTest();

			await Bun.write(tempDir.join("sync.yml"), "bucket: [unterminated\nprefix: config-sync\n");
			await expect(loadSyncProfile(tempDir.path())).rejects.toThrow();
		} finally {
			resetSettingsForTest();
			tempDir.removeSync();
		}
	});

	it("rejects a passphrase environment name that cannot be resolved safely", () => {
		expect(() =>
			parseSyncProfile({ bucket: "config-sync-test-bucket", prefix: "config-sync", passphraseEnv: "not-valid" }),
		).toThrow("Sync profile passphraseEnv must be an environment variable name");
	});
});

describe("config sync local encryption key", () => {
	const PASSPHRASE_ENV = "OMP_CONFIG_SYNC_LOCAL_KEY_TEST";
	let tempDir: TempDir | undefined;
	let previousPassphraseEnv: string | undefined;

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-config-sync-local-key-");
		previousPassphraseEnv = process.env[PASSPHRASE_ENV];
		delete process.env[PASSPHRASE_ENV];
	});

	afterEach(() => {
		if (previousPassphraseEnv === undefined) delete process.env[PASSPHRASE_ENV];
		else process.env[PASSPHRASE_ENV] = previousPassphraseEnv;
		resetSettingsForTest();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	function agentDir(): string {
		if (!tempDir) throw new Error("Missing temporary local sync key directory");
		return tempDir.join("agent");
	}

	function tempPath(relativePath: string): string {
		if (!tempDir) throw new Error("Missing temporary local sync key directory");
		return tempDir.join(relativePath);
	}

	function profile(): SyncProfile {
		return parseSyncProfile({
			bucket: "local-key-sync-bucket",
			prefix: "local-key-sync",
			passphraseEnv: PASSPHRASE_ENV,
		});
	}

	it("stores the encryption key only in a private local file and clears it", async () => {
		const localKey = "local-key-must-never-enter-config";
		const localKeyPath = getLocalSyncPassphrasePath(agentDir());
		const configPath = path.join(agentDir(), "config.yml");
		await fs.mkdir(agentDir(), { recursive: true });
		await fs.writeFile(configPath, "sync:\n  bucket: local-key-sync-bucket\n");

		writeLocalSyncPassphrase(agentDir(), localKey);

		expect(readLocalSyncPassphrase(agentDir())).toBe(localKey);
		expect(await fs.readFile(configPath, "utf8")).toBe("sync:\n  bucket: local-key-sync-bucket\n");
		if (process.platform !== "win32") {
			expect((await fs.stat(localKeyPath)).mode & 0o777).toBe(0o600);
		}

		writeLocalSyncPassphrase(agentDir(), "");

		expect(readLocalSyncPassphrase(agentDir())).toBeUndefined();
		expect(await Bun.file(localKeyPath).exists()).toBe(false);
	});

	it("prefers a local encryption key, then falls back to the configured environment variable", () => {
		const syncProfile = profile();
		process.env[PASSPHRASE_ENV] = "environment-fallback-key";
		writeLocalSyncPassphrase(agentDir(), "device-local-key");

		expect(requireSyncPassphrase(agentDir(), syncProfile)).toBe("device-local-key");

		removeLocalSyncPassphrase(agentDir());

		expect(requireSyncPassphrase(agentDir(), syncProfile)).toBe("environment-fallback-key");

		delete process.env[PASSPHRASE_ENV];

		expect(() => requireSyncPassphrase(agentDir(), syncProfile)).toThrow(PASSPHRASE_ENV);
	});

	it("keeps the local encryption key file and its plaintext out of snapshots and encrypted exports", async () => {
		const localKey = "local-key-must-not-appear-in-sync-snapshots";
		const localKeyPath = getLocalSyncPassphrasePath(agentDir());
		const localKeyRelativePath = path.relative(agentDir(), localKeyPath);
		const authStorage = await AuthStorage.create(tempPath("auth.db"));
		try {
			writeLocalSyncPassphrase(agentDir(), localKey);
			await fs.writeFile(path.join(agentDir(), "RULES.md"), "syncable rules\n");

			const collected = await collectConfigSnapshot(agentDir(), authStorage);
			expect(collected.files.map(entry => entry.path)).not.toContain(localKeyRelativePath);
			expect(JSON.stringify(collected)).not.toContain(localKey);

			const exported = await exportEncryptedBundle(agentDir(), authStorage, "bundle encryption passphrase");
			const decrypted = await decryptConfigBundle(exported.bundle, "bundle encryption passphrase");
			for (const snapshot of [exported.snapshot, decrypted]) {
				expect(snapshot.files.map(entry => entry.path)).not.toContain(localKeyRelativePath);
				expect(JSON.stringify(snapshot)).not.toContain(localKey);
			}
			expect(JSON.stringify(exported.bundle)).not.toContain(localKey);
		} finally {
			authStorage.close();
		}
	});
});

describe("config sync Settings profile source", () => {
	let tempDir: TempDir | undefined;

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-config-sync-settings-profile-");
	});

	afterEach(() => {
		resetSettingsForTest();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	function agentDir(): string {
		if (!tempDir) throw new Error("Missing temporary config sync profile directory");
		return tempDir.path();
	}

	function completeS3Profile(): SyncProfile {
		return {
			formatVersion: CONFIG_SYNC_VERSION,
			endpoint: "https://s3.config-sync.test",
			bucket: "settings-sync-bucket",
			region: "us-east-1",
			prefix: "settings/snapshots",
			virtualHostedStyle: true,
			passphraseEnv: "OMP_SYNC_PASSPHRASE",
			accessKeyIdEnv: "OMP_SYNC_ACCESS_KEY_ID",
			secretAccessKeyEnv: "OMP_SYNC_SECRET_ACCESS_KEY",
			sessionTokenEnv: "OMP_SYNC_SESSION_TOKEN",
			autoPush: true,
			retention: { revisions: 15, days: 45, inactiveWriterDays: 120 },
		};
	}

	async function persistSyncSettings(profile: SyncProfile): Promise<void> {
		const settings = await Settings.init({ agentDir: agentDir(), cwd: agentDir() });
		settings.set("sync.enabled", true);
		settings.set("sync.endpoint", profile.endpoint);
		settings.set("sync.bucket", profile.bucket);
		settings.set("sync.region", profile.region);
		settings.set("sync.prefix", profile.prefix);
		settings.set("sync.virtualHostedStyle", profile.virtualHostedStyle === true);
		settings.set("sync.passphraseEnv", profile.passphraseEnv);
		settings.set("sync.accessKeyIdEnv", profile.accessKeyIdEnv);
		settings.set("sync.secretAccessKeyEnv", profile.secretAccessKeyEnv);
		settings.set("sync.sessionTokenEnv", profile.sessionTokenEnv);
		settings.set("sync.autoPush", profile.autoPush === true);
		settings.set("sync.retention.revisions", profile.retention?.revisions);
		settings.set("sync.retention.days", profile.retention?.days);
		settings.set("sync.retention.inactiveWriterDays", profile.retention?.inactiveWriterDays);
		await settings.flush();
	}

	it("loads a complete S3 profile persisted through Settings config.yml", async () => {
		const profile = completeS3Profile();
		await persistSyncSettings(profile);
		resetSettingsForTest();

		await expect(loadSyncProfile(agentDir())).resolves.toEqual(profile);
	});

	it("lets an explicitly disabled Settings profile override a legacy sync.yml", async () => {
		const settings = await Settings.init({ agentDir: agentDir(), cwd: agentDir() });
		settings.set("sync.enabled", false);
		await settings.flush();
		await Bun.write(
			path.join(agentDir(), "sync.yml"),
			"bucket: legacy-sync-bucket\nprefix: legacy-settings\npassphraseEnv: LEGACY_SYNC_PASSPHRASE\n",
		);
		resetSettingsForTest();

		await expect(loadSyncProfile(agentDir())).resolves.toBeNull();
	});

	it("treats enabled Settings profiles without an S3 bucket as unconfigured", async () => {
		for (const { agentDirName, bucket } of [
			{ agentDirName: "missing-bucket" },
			{ agentDirName: "empty-bucket", bucket: "" },
		]) {
			const caseAgentDir = path.join(agentDir(), agentDirName);
			const settings = await Settings.init({ agentDir: caseAgentDir, cwd: caseAgentDir });
			settings.set("sync.enabled", true);
			if (bucket !== undefined) settings.set("sync.bucket", bucket);
			await settings.flush();
			resetSettingsForTest();

			await expect(loadSyncProfile(caseAgentDir)).resolves.toBeNull();
		}
	});

	it("writes normalized profiles to config.yml and reloads them without sync.yml", async () => {
		const profile: SyncProfile = {
			...completeS3Profile(),
			bucket: " saved-sync-bucket ",
			prefix: "/saved/snapshots/",
		};
		const expected: SyncProfile = {
			...profile,
			bucket: "saved-sync-bucket",
			prefix: "saved/snapshots",
		};

		await saveSyncProfile(agentDir(), profile);

		expect(await Bun.file(path.join(agentDir(), "config.yml")).exists()).toBe(true);
		expect(await Bun.file(path.join(agentDir(), "sync.yml")).exists()).toBe(false);
		resetSettingsForTest();
		await expect(loadSyncProfile(agentDir())).resolves.toEqual(expected);
	});

	it("round-trips a minimal profile without inventing optional settings values", async () => {
		const profile: SyncProfile = {
			formatVersion: CONFIG_SYNC_VERSION,
			bucket: "minimal-sync-bucket",
			prefix: "minimal",
			passphraseEnv: "MINIMAL_SYNC_PASSPHRASE",
		};
		const expected: SyncProfile = {
			...profile,
			endpoint: undefined,
			region: undefined,
			virtualHostedStyle: undefined,
			accessKeyIdEnv: undefined,
			secretAccessKeyEnv: undefined,
			sessionTokenEnv: undefined,
			autoPush: undefined,
			retention: undefined,
		};

		await saveSyncProfile(agentDir(), profile);
		resetSettingsForTest();

		await expect(loadSyncProfile(agentDir())).resolves.toEqual(expected);
	});
	it.each([
		{
			name: "only sync.endpoint",
			configure: (settings: Settings) => settings.set("sync.endpoint", "https://local.config-sync.test"),
		},
		{
			name: "only sync.autoPush",
			configure: (settings: Settings) => settings.set("sync.autoPush", true),
		},
	] as const)("does not fall back to legacy sync.yml when $name is configured", async ({ configure }) => {
		const settings = await Settings.init({ agentDir: agentDir(), cwd: agentDir() });
		configure(settings);
		await settings.flush();
		await Bun.write(
			path.join(agentDir(), "sync.yml"),
			"bucket: legacy-sync-bucket\nprefix: legacy-settings\npassphraseEnv: LEGACY_SYNC_PASSPHRASE\n",
		);
		resetSettingsForTest();

		await expect(loadSyncProfile(agentDir())).resolves.toBeNull();
	});
});

describe("config sync bootstrap and adoption", () => {
	const REPOSITORY_PASSPHRASE_ENV = "OMP_CONFIG_SYNC_BOOTSTRAP_TEST_PASSPHRASE";
	const ACCESS_KEY_ENV = "OMP_CONFIG_SYNC_BOOTSTRAP_TEST_ACCESS_KEY";
	const SECRET_KEY_ENV = "OMP_CONFIG_SYNC_BOOTSTRAP_TEST_SECRET_KEY";
	const SESSION_TOKEN_ENV = "OMP_CONFIG_SYNC_BOOTSTRAP_TEST_SESSION_TOKEN";
	const REPOSITORY_PASSPHRASE = "repository-passphrase-must-not-leak";
	const ACCESS_KEY = "access-key-must-not-leak";
	const SECRET_KEY = "secret-key-must-not-leak";
	const SESSION_TOKEN = "session-token-must-not-leak";
	const TRANSPORT_PASSPHRASE = "bootstrap-transport-passphrase";
	const ENV_NAMES = [REPOSITORY_PASSPHRASE_ENV, ACCESS_KEY_ENV, SECRET_KEY_ENV, SESSION_TOKEN_ENV] as const;

	let tempDir: TempDir | undefined;
	const authStorages: AuthStorage[] = [];
	let previousEnvironment: Record<(typeof ENV_NAMES)[number], string | undefined> = {
		[REPOSITORY_PASSPHRASE_ENV]: undefined,
		[ACCESS_KEY_ENV]: undefined,
		[SECRET_KEY_ENV]: undefined,
		[SESSION_TOKEN_ENV]: undefined,
	};

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-config-sync-bootstrap-adoption-");
		previousEnvironment = {
			[REPOSITORY_PASSPHRASE_ENV]: process.env[REPOSITORY_PASSPHRASE_ENV],
			[ACCESS_KEY_ENV]: process.env[ACCESS_KEY_ENV],
			[SECRET_KEY_ENV]: process.env[SECRET_KEY_ENV],
			[SESSION_TOKEN_ENV]: process.env[SESSION_TOKEN_ENV],
		};
		for (const name of ENV_NAMES) delete process.env[name];
	});

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		resetSettingsForTest();
		for (const name of ENV_NAMES) {
			const previous = previousEnvironment[name];
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
		tempDir?.removeSync();
		tempDir = undefined;
	});

	function tempPath(relativePath: string): string {
		if (!tempDir) throw new Error("Missing bootstrap test temporary directory");
		return tempDir.join(relativePath);
	}

	function testProfile(autoPush = true): SyncProfile {
		return parseSyncProfile({
			formatVersion: CONFIG_SYNC_VERSION,
			endpoint: "https://s3.config-sync.test",
			bucket: "config-sync-bootstrap-test-bucket",
			region: "us-east-1",
			prefix: "config-sync-bootstrap-tests",
			virtualHostedStyle: true,
			passphraseEnv: REPOSITORY_PASSPHRASE_ENV,
			accessKeyIdEnv: ACCESS_KEY_ENV,
			secretAccessKeyEnv: SECRET_KEY_ENV,
			sessionTokenEnv: SESSION_TOKEN_ENV,
			autoPush,
		});
	}

	function setBootstrapEnvironment(): void {
		process.env[REPOSITORY_PASSPHRASE_ENV] = REPOSITORY_PASSPHRASE;
		process.env[ACCESS_KEY_ENV] = ACCESS_KEY;
		process.env[SECRET_KEY_ENV] = SECRET_KEY;
		process.env[SESSION_TOKEN_ENV] = SESSION_TOKEN;
	}

	function clearCredentialEnvironment(): void {
		delete process.env[ACCESS_KEY_ENV];
		delete process.env[SECRET_KEY_ENV];
		delete process.env[SESSION_TOKEN_ENV];
	}

	async function persistProfile(agentDir: string, profile: SyncProfile, enabled: boolean): Promise<void> {
		await saveSyncProfile(agentDir, profile, { enabled });
		resetSettingsForTest();
	}

	async function createAuthStorage(name: string): Promise<AuthStorage> {
		const authStorage = await AuthStorage.create(tempPath(name));
		authStorages.push(authStorage);
		return authStorage;
	}

	function createSharedMemoryStore(profile: SyncProfile): S3ConfigSyncStore {
		return new S3ConfigSyncStore(profile, { client: new MemoryConfigSyncS3Client() });
	}

	it("exports a standalone AES-GCM bootstrap bundle and rejects the wrong transport passphrase", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const sourceDir = tempPath("source");
		const bootstrapPath = tempPath("bootstrap.json");
		await persistProfile(sourceDir, profile, true);

		const summary = await exportSyncBootstrap(sourceDir, bootstrapPath, TRANSPORT_PASSPHRASE);
		expect(summary).toMatchObject({
			bucket: profile.bucket,
			prefix: profile.prefix,
			enabled: true,
			pendingAdoption: false,
		});

		const serialized = await fs.readFile(bootstrapPath, "utf8");
		const bundle = JSON.parse(serialized) as {
			format: string;
			formatVersion: number;
			encryption: { algorithm: string; kdf: string };
			ciphertext: string;
		};
		expect(bundle.format).toBe("omp-sync-bootstrap-bundle");
		expect(bundle.formatVersion).toBe(SYNC_BOOTSTRAP_BUNDLE_VERSION);
		expect(bundle.encryption.algorithm).toBe("AES-256-GCM");
		expect(bundle.encryption.kdf).toBe("PBKDF2-SHA-256");
		for (const secret of [ACCESS_KEY, SECRET_KEY, REPOSITORY_PASSPHRASE, SESSION_TOKEN]) {
			expect(serialized).not.toContain(secret);
		}

		await expect(
			importSyncBootstrap(tempPath("wrong-passphrase-target"), bootstrapPath, "wrong transport passphrase", true),
		).rejects.toThrow("Unable to decrypt sync bootstrap bundle: invalid passphrase or authenticated ciphertext");
	});

	it("keeps bootstrap dry-runs side-effect free and imports credentials into a private .env", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const sourceDir = tempPath("source");
		const targetDir = tempPath("target");
		const bootstrapPath = tempPath("bootstrap.json");
		await persistProfile(sourceDir, profile, true);
		await exportSyncBootstrap(sourceDir, bootstrapPath, TRANSPORT_PASSPHRASE);
		clearCredentialEnvironment();

		const dryRun = await importSyncBootstrap(targetDir, bootstrapPath, TRANSPORT_PASSPHRASE, true);
		expect(dryRun).toMatchObject({ enabled: false, pendingAdoption: true });
		expect(await Bun.file(path.join(targetDir, "config.yml")).exists()).toBe(false);
		expect(await Bun.file(path.join(targetDir, ".env")).exists()).toBe(false);
		expect(await Bun.file(getPendingAdoptionPath(targetDir)).exists()).toBe(false);
		expect(await loadPendingAdoption(targetDir)).toBeNull();
		expect(process.env[ACCESS_KEY_ENV]).toBeUndefined();
		expect(process.env[SECRET_KEY_ENV]).toBeUndefined();
		expect(process.env[SESSION_TOKEN_ENV]).toBeUndefined();

		await importSyncBootstrap(targetDir, bootstrapPath, TRANSPORT_PASSPHRASE, false);
		const importedSettings = await Settings.loadReadOnly({ agentDir: targetDir, cwd: targetDir });
		expect(importedSettings.get("sync.autoPush")).toBe(false);
		resetSettingsForTest();
		expect(await isSyncProfileEnabled(targetDir)).toBe(false);
		const pending = await loadPendingAdoption(targetDir);
		expect(pending?.bucket).toBe(profile.bucket);
		expect(pending?.prefix).toBe(profile.prefix);
		expect(pending?.autoPush).toBe(true);

		const envPath = path.join(targetDir, ".env");
		const envText = await fs.readFile(envPath, "utf8");
		expect(envText).toContain(`${ACCESS_KEY_ENV}=${ACCESS_KEY}`);
		expect(envText).toContain(`${SECRET_KEY_ENV}=${SECRET_KEY}`);
		expect(envText).toContain(`${SESSION_TOKEN_ENV}=${SESSION_TOKEN}`);
		expect(process.env[ACCESS_KEY_ENV]).toBe(ACCESS_KEY);
		expect(process.env[SECRET_KEY_ENV]).toBe(SECRET_KEY);
		expect(process.env[SESSION_TOKEN_ENV]).toBe(SESSION_TOKEN);
		if (process.platform !== "win32") expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);

		const configText = await fs.readFile(path.join(targetDir, "config.yml"), "utf8");
		expect(configText).not.toContain(ACCESS_KEY);
		expect(configText).not.toContain(SECRET_KEY);
		expect(configText).not.toContain(REPOSITORY_PASSPHRASE);
	});

	it("rejects lineage-less pushes, previews pulls without mutation, and adopts a remote snapshot", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const store = createSharedMemoryStore(profile);
		const remoteSnapshot = configSnapshot([configFile("RULES.md", "remote rules\n")], {});
		const remote = await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(remoteSnapshot, REPOSITORY_PASSPHRASE),
			parents: [],
			writerId: "remote-bootstrap-writer",
			sequence: 1,
			epochId: "bootstrap-adoption-test",
		});

		const newDeviceDir = tempPath("new-device");
		await persistProfile(newDeviceDir, profile, true);
		const newDeviceAuth = await createAuthStorage("new-device-auth.db");
		const dependencies = { createStore: () => store };
		await expect(
			synchronizeConfiguration(newDeviceDir, newDeviceAuth, { mode: "push" }, dependencies),
		).rejects.toThrow(
			"Remote configuration already exists without local lineage; run `omp sync pull --adopt` before pushing",
		);
		await expect(
			synchronizeConfiguration(newDeviceDir, newDeviceAuth, { mode: "pull" }, dependencies),
		).rejects.toThrow("Remote configuration requires explicit adoption; rerun with `omp sync pull --adopt`");

		const importedDir = tempPath("imported-device");
		await persistProfile(importedDir, { ...profile, autoPush: false }, false);
		await savePendingAdoption(importedDir, profile);
		resetSettingsForTest();
		const localRulesPath = path.join(importedDir, "RULES.md");
		await fs.writeFile(localRulesPath, "local rules must survive dry-run\n");
		const configPath = path.join(importedDir, "config.yml");
		const pendingPath = getPendingAdoptionPath(importedDir);
		const statePath = getSyncStatePath(importedDir);
		const configBefore = await fs.readFile(configPath, "utf8");
		const pendingBefore = await fs.readFile(pendingPath, "utf8");
		const importedAuth = await createAuthStorage("imported-device-auth.db");
		await expect(synchronizeConfiguration(importedDir, importedAuth, { mode: "pull" }, dependencies)).rejects.toThrow(
			"Configuration sync is disabled; run `omp sync pull --adopt` to adopt the remote configuration",
		);

		const preview = await synchronizeConfiguration(
			importedDir,
			importedAuth,
			{ mode: "pull", dryRun: true },
			dependencies,
		);
		expect(preview.status).toBe("adopted");
		expect(await fs.readFile(localRulesPath, "utf8")).toBe("local rules must survive dry-run\n");
		expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
		expect(await fs.readFile(pendingPath, "utf8")).toBe(pendingBefore);
		expect(await Bun.file(statePath).exists()).toBe(false);
		expect(await isSyncProfileEnabled(importedDir)).toBe(false);
		const dryRunSettings = await Settings.loadReadOnly({ agentDir: importedDir, cwd: importedDir });
		expect(dryRunSettings.get("sync.autoPush")).toBe(false);
		resetSettingsForTest();

		const adopted = await synchronizeConfiguration(
			importedDir,
			importedAuth,
			{ mode: "pull", adopt: true },
			dependencies,
		);
		expect(adopted.status).toBe("adopted");
		expect(await fs.readFile(localRulesPath, "utf8")).toBe("remote rules\n");
		expect(await loadPendingAdoption(importedDir)).toBeNull();
		expect(await Bun.file(pendingPath).exists()).toBe(false);
		expect(await isSyncProfileEnabled(importedDir)).toBe(true);
		expect((await loadSyncProfile(importedDir))?.autoPush).toBe(true);
		const state = await loadSyncState(importedDir);
		expect(state.lastRevisionId).toBe(remote.revision.revisionId);
		expect(state.lastPublicationId).toBe(remote.publication.publicationId);
		const mismatchedPublication = await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(
				configSnapshot([configFile("RULES.md", "mismatched remote rules\n")], {}),
				REPOSITORY_PASSPHRASE,
			),
			parents: [remote.publication],
			writerId: "mismatched-lineage-writer",
			sequence: 1,
			epochId: "bootstrap-adoption-mismatched-lineage",
		});
		for (const { directoryName, lastPublicationId } of [
			{ directoryName: "forged-revision-only", lastPublicationId: undefined },
			{
				directoryName: "forged-mismatched-publication",
				lastPublicationId: mismatchedPublication.publication.publicationId,
			},
		]) {
			const forgedDir = tempPath(directoryName);
			await persistProfile(forgedDir, profile, true);
			await fs.writeFile(
				getSyncStatePath(forgedDir),
				`${JSON.stringify({
					formatVersion: CONFIG_SYNC_VERSION,
					writerId: `forged-${directoryName}`,
					sequence: 0,
					lastRevisionId: remote.revision.revisionId,
					...(lastPublicationId === undefined ? {} : { lastPublicationId }),
				})}\n`,
			);
			const forgedAuth = await createAuthStorage(`${directoryName}-auth.db`);
			await expect(synchronizeConfiguration(forgedDir, forgedAuth, { mode: "push" }, dependencies)).rejects.toThrow(
				"Remote configuration already exists without local lineage; run `omp sync pull --adopt` before pushing",
			);
		}
	});

	it("merges an established device locally even when pull is invoked with --adopt", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const agentDir = tempPath("established-device");
		const store = createSharedMemoryStore(profile);
		const base = await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(
				configSnapshot([configFile("RULES.md", "base rules\n")], {}),
				REPOSITORY_PASSPHRASE,
			),
			parents: [],
			writerId: "established-base-writer",
			sequence: 1,
			epochId: "established-adoption-test",
		});

		await persistProfile(agentDir, profile, true);
		await saveSyncState(agentDir, {
			formatVersion: CONFIG_SYNC_VERSION,
			writerId: "established-local-writer",
			sequence: 1,
			lastPublicationId: base.publication.publicationId,
			lastRevisionId: base.revision.revisionId,
		});
		const localRulesPath = path.join(agentDir, "RULES.md");
		await fs.writeFile(localRulesPath, "local rules must survive adopt\n");

		await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(
				configSnapshot(
					[configFile("RULES.md", "base rules\n"), configFile("themes/solarized.json", '{"theme":"solarized"}\n')],
					{},
				),
				REPOSITORY_PASSPHRASE,
			),
			parents: [base.publication],
			writerId: "established-remote-writer",
			sequence: 1,
			epochId: "established-adoption-test",
		});

		const authStorage = await createAuthStorage("established-device-auth.db");
		const result = await synchronizeConfiguration(
			agentDir,
			authStorage,
			{ mode: "pull", adopt: true },
			{ createStore: () => store },
		);

		expect(result.status).toBe("published");
		if (!result.publicationId || !result.revisionId) throw new Error("Expected published adoption identifiers");
		const graph = await loadRemoteGraph(store);
		expect(graph.tips.map(tip => tip.publicationId)).toEqual([result.publicationId]);
		expect(await fs.readFile(localRulesPath, "utf8")).toBe("local rules must survive adopt\n");
		expect(await fs.readFile(path.join(agentDir, "themes", "solarized.json"), "utf8")).toBe(
			'{"theme":"solarized"}\n',
		);

		const state = await loadSyncState(agentDir);
		expect(state.sequence).toBe(2);
		expect(state.lastPublicationId).toBe(result.publicationId);
		expect(state.lastRevisionId).toBe(result.revisionId);
		expect(await loadPendingAdoption(agentDir)).toBeNull();
		expect(await Bun.file(getPendingAdoptionPath(agentDir)).exists()).toBe(false);
	});

	it("uses explicit adoption to unlock an imported profile when the remote is empty", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const agentDir = tempPath("empty-remote-device");
		await persistProfile(agentDir, profile, false);
		await savePendingAdoption(agentDir, profile);
		resetSettingsForTest();
		const authStorage = await createAuthStorage("empty-remote-auth.db");
		const store = createSharedMemoryStore(profile);

		const result = await synchronizeConfiguration(
			agentDir,
			authStorage,
			{ mode: "pull", adopt: true },
			{
				createStore: () => store,
			},
		);
		expect(result.status).toBe("empty-remote");
		expect(result.tips).toBe(0);
		expect(await loadPendingAdoption(agentDir)).toBeNull();
		expect(await isSyncProfileEnabled(agentDir)).toBe(true);
		expect((await loadSyncProfile(agentDir))?.autoPush).toBe(true);
	});

	it("returns only an auth conflict summary while retaining credentials in the private conflict document", async () => {
		setBootstrapEnvironment();
		const profile = testProfile(true);
		const agentDir = tempPath("auth-conflict-device");
		const provider = "auth-conflict-provider";
		const baseSecret = "auth-conflict-base-secret";
		const localSecret = "auth-conflict-local-secret";
		const remoteSecret = "auth-conflict-remote-secret";
		await persistProfile(agentDir, profile, true);
		const authStorage = await createAuthStorage("auth-conflict.db");
		authStorage.upsertCredential(provider, apiKey(baseSecret));
		const baseSnapshot = await collectConfigSnapshot(agentDir, authStorage);
		const store = createSharedMemoryStore(profile);
		const base = await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(baseSnapshot, REPOSITORY_PASSPHRASE),
			parents: [],
			writerId: "auth-conflict-base-writer",
			sequence: 1,
			epochId: "auth-conflict-test",
		});
		await authStorage.remove(provider);
		authStorage.upsertCredential(provider, apiKey(localSecret));
		await publishSnapshot(store, {
			bundle: await encryptConfigSnapshot(
				{ ...baseSnapshot, auth: { ...baseSnapshot.auth, [provider]: apiKey(remoteSecret) } },
				REPOSITORY_PASSPHRASE,
			),
			parents: [base.publication],
			writerId: "auth-conflict-remote-writer",
			sequence: 1,
		});
		await fs.writeFile(
			getSyncStatePath(agentDir),
			`${JSON.stringify({
				formatVersion: CONFIG_SYNC_VERSION,
				writerId: "auth-conflict-local-writer",
				sequence: 1,
				lastPublicationId: base.publication.publicationId,
				lastRevisionId: base.revision.revisionId,
			})}\n`,
		);

		const result = await synchronizeConfiguration(
			agentDir,
			authStorage,
			{ mode: "pull" },
			{ createStore: () => store },
		);
		expect(result.status).toBe("conflict");

		expect(result.conflicts).toEqual([{ kind: "auth", key: provider }]);
		const serializedResult = JSON.stringify(result);
		for (const secret of [baseSecret, localSecret, remoteSecret]) expect(serializedResult).not.toContain(secret);

		const conflictDocument = JSON.parse(
			await fs.readFile(path.join(agentDir, "sync-conflict.json"), "utf8"),
		) as ConfigConflictDocument;
		expect(conflictDocument).toMatchObject({
			base: { auth: { [provider]: apiKey(baseSecret) } },
			local: { auth: { [provider]: apiKey(localSecret) } },
			remote: { auth: { [provider]: apiKey(remoteSecret) } },
			conflicts: [
				{
					kind: "auth",
					key: provider,
					base: [apiKey(baseSecret)],
					local: [apiKey(localSecret)],
					remote: [apiKey(remoteSecret)],
				},
			],
		});
	});
});

describe("config sync conflict output", () => {
	it("redacts conflict snapshots and credentials from both default output modes", async () => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		let tempDir: TempDir | undefined;
		try {
			resetSettingsForTest();
			tempDir = TempDir.createSync("@pi-config-sync-conflict-output-");
			const agentDir = tempDir.path();
			const conflictPath = path.join(agentDir, "sync-conflict.json");
			const credentialSecrets = [
				"base-snapshot-api-key-unique",
				"base-snapshot-oauth-access-unique",
				"base-snapshot-oauth-refresh-unique",
				"local-snapshot-api-key-unique",
				"local-snapshot-oauth-access-unique",
				"local-snapshot-oauth-refresh-unique",
				"remote-snapshot-api-key-unique",
				"remote-snapshot-oauth-access-unique",
				"remote-snapshot-oauth-refresh-unique",
				"conflict-base-api-key-unique",
				"conflict-base-oauth-access-unique",
				"conflict-base-oauth-refresh-unique",
				"conflict-local-api-key-unique",
				"conflict-local-oauth-access-unique",
				"conflict-local-oauth-refresh-unique",
				"conflict-remote-api-key-unique",
				"conflict-remote-oauth-access-unique",
				"conflict-remote-oauth-refresh-unique",
			] as const;
			const oauth = (access: string, refresh: string): AuthCredential => ({
				type: "oauth",
				access,
				refresh,
				expires: 1_800_000_000_000,
			});
			const conflict: ConfigConflictDocument = {
				format: "omp-config-conflict",
				formatVersion: CONFIG_SYNC_VERSION,
				createdAt: "2026-08-09T00:00:00.000Z",
				baseRevisionId: "base-revision-id",
				remoteRevisionIds: ["remote-revision-id-a", "remote-revision-id-b"],
				base: configSnapshot([configFile("RULES.md", "base rules\n")], {
					"base-api-provider": apiKey(credentialSecrets[0]),
					"base-oauth-provider": oauth(credentialSecrets[1], credentialSecrets[2]),
				}),
				local: configSnapshot([configFile("RULES.md", "local rules\n")], {
					"local-api-provider": apiKey(credentialSecrets[3]),
					"local-oauth-provider": oauth(credentialSecrets[4], credentialSecrets[5]),
				}),
				remote: configSnapshot([configFile("RULES.md", "remote rules\n")], {
					"remote-api-provider": apiKey(credentialSecrets[6]),
					"remote-oauth-provider": oauth(credentialSecrets[7], credentialSecrets[8]),
				}),
				conflicts: [
					{
						kind: "file",
						key: "RULES.md",
						base: configFile("RULES.md", "base rules\n"),
						local: configFile("RULES.md", "local rules\n"),
						remote: configFile("RULES.md", "remote rules\n"),
					},
					{
						kind: "auth",
						key: "credential-provider",
						base: [apiKey(credentialSecrets[9]), oauth(credentialSecrets[10], credentialSecrets[11])],
						local: [apiKey(credentialSecrets[12]), oauth(credentialSecrets[13], credentialSecrets[14])],
						remote: [apiKey(credentialSecrets[15]), oauth(credentialSecrets[16], credentialSecrets[17])],
					},
				],
			};
			await fs.writeFile(conflictPath, `${JSON.stringify(conflict)}\n`);
			setAgentDir(agentDir);

			const expectedOutput = {
				path: conflictPath,
				conflict: {
					format: "omp-config-conflict",
					formatVersion: CONFIG_SYNC_VERSION,
					createdAt: "2026-08-09T00:00:00.000Z",
					baseRevisionId: "base-revision-id",
					remoteRevisionIds: ["remote-revision-id-a", "remote-revision-id-b"],
					conflicts: [
						{ kind: "file", key: "RULES.md" },
						{ kind: "auth", key: "credential-provider" },
					],
				},
			};
			for (const json of [true, false]) {
				logSpy.mockClear();
				await runSyncCommand({ action: "conflict", flags: json ? { json: true } : {} });
				const stdout = logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");

				expect(JSON.parse(stdout)).toEqual(expectedOutput);
				for (const snapshotField of ["base", "local", "remote"]) {
					expect(stdout).not.toContain(`"${snapshotField}":`);
				}
				for (const secret of credentialSecrets) expect(stdout).not.toContain(secret);
			}
		} finally {
			logSpy.mockRestore();
			resetSettingsForTest();
			if (originalAgentDir) setAgentDir(originalAgentDir);
			else {
				setAgentDir(fallbackAgentDir);
				delete process.env.PI_CODING_AGENT_DIR;
			}
			tempDir?.removeSync();
		}
	});
});
