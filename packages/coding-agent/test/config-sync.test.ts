import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { applyConfigSnapshot, exportEncryptedBundle, importEncryptedBundle } from "../src/config-sync/bundle";
import { decryptConfigBundle, encryptConfigSnapshot, hashStableJson, stableJson } from "../src/config-sync/crypto";
import { mergeSnapshots } from "../src/config-sync/merge";
import { loadSyncProfile, parseSyncProfile } from "../src/config-sync/profile";
import { loadRemoteGraph, publishSnapshot } from "../src/config-sync/protocol";
import {
	type ConfigSyncS3Client,
	createConfigPublication,
	createConfigRevision,
	S3ConfigSyncStore,
} from "../src/config-sync/store";
import {
	CONFIG_BUNDLE_VERSION,
	type ConfigFileEntry,
	type ConfigSnapshot,
	type EncryptedConfigBundle,
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
	it("rejects malformed sync YAML rather than accepting a partial profile", async () => {
		const tempDir = TempDir.createSync("@pi-config-sync-profile-");
		try {
			await Bun.write(tempDir.join("sync.yml"), "bucket: [unterminated\nprefix: config-sync\n");
			await expect(loadSyncProfile(tempDir.path())).rejects.toThrow();
		} finally {
			tempDir.removeSync();
		}
	});

	it("rejects a passphrase environment name that cannot be resolved safely", () => {
		expect(() =>
			parseSyncProfile({ bucket: "config-sync-test-bucket", prefix: "config-sync", passphraseEnv: "not-valid" }),
		).toThrow("Sync profile passphraseEnv must be an environment variable name");
	});
});
