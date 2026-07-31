import { S3Client } from "bun";
import { hashStableJson, stableJson } from "./crypto";
import { parseSyncProfile } from "./profile";
import {
	CONFIG_SYNC_VERSION,
	type ConfigPublication,
	type ConfigRevision,
	type EncryptedConfigBundle,
	type PublicationParent,
	type SyncProfile,
} from "./types";

const REVISION_PREFIX = "revisions/";
const PUBLICATION_PREFIX = "publications/";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface ConfigSyncS3Client {
	file(path: string): { text(): Promise<string> };
	write(path: string, data: string, options?: { type?: string }): Promise<number>;
	list(input?: { prefix?: string; continuationToken?: string }): Promise<{
		contents?: Array<{ key: string }>;
		isTruncated?: boolean;
		nextContinuationToken?: string;
	}>;
	delete(path: string): Promise<void>;
}

export interface S3ConfigSyncStoreOptions {
	client?: ConfigSyncS3Client;
}

export interface ConfigRevisionInput {
	parentRevisionIds: readonly string[];
	payloadHash: string;
	bundle: EncryptedConfigBundle;
}

export interface ConfigPublicationInput {
	epochId: string;
	writerId: string;
	sequence: number;
	revisionId: string;
	parents: readonly PublicationParent[];
}

/** The identity field is excluded because it is the hash of this complete envelope. */
export interface ConfigRevisionEnvelope {
	format: "omp-config-revision";
	formatVersion: typeof CONFIG_SYNC_VERSION;
	parentRevisionIds: string[];
	payloadHash: string;
	bundle: EncryptedConfigBundle;
}

/** The identity field is excluded because it is the hash of this complete envelope. */
export interface ConfigPublicationEnvelope {
	format: "omp-config-publication";
	formatVersion: typeof CONFIG_SYNC_VERSION;
	epochId: string;
	writerId: string;
	sequence: number;
	revisionId: string;
	parents: PublicationParent[];
}

export function revisionEnvelope(revision: ConfigRevision): ConfigRevisionEnvelope {
	return {
		format: revision.format,
		formatVersion: revision.formatVersion,
		parentRevisionIds: revision.parentRevisionIds,
		payloadHash: revision.payloadHash,
		bundle: revision.bundle,
	};
}

export function publicationEnvelope(publication: ConfigPublication): ConfigPublicationEnvelope {
	return {
		format: publication.format,
		formatVersion: publication.formatVersion,
		epochId: publication.epochId,
		writerId: publication.writerId,
		sequence: publication.sequence,
		revisionId: publication.revisionId,
		parents: publication.parents,
	};
}

export function createConfigRevision(input: ConfigRevisionInput): ConfigRevision {
	const parentRevisionIds = canonicalIdList(input.parentRevisionIds, "revision parent");
	assertSha256(input.payloadHash, "payload hash");
	assertEncryptedBundle(input.bundle);
	const envelope: ConfigRevisionEnvelope = {
		format: "omp-config-revision",
		formatVersion: CONFIG_SYNC_VERSION,
		parentRevisionIds,
		payloadHash: input.payloadHash,
		bundle: input.bundle,
	};
	return {
		...envelope,
		revisionId: hashStableJson(envelope),
	};
}

export function createConfigPublication(input: ConfigPublicationInput): ConfigPublication {
	assertNonEmptyString(input.epochId, "epoch ID");
	assertNonEmptyString(input.writerId, "writer ID");
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
		throw new Error("Publication sequence must be a non-negative safe integer");
	}
	assertSha256(input.revisionId, "revision ID");
	const parents = canonicalPublicationParents(input.parents);
	const envelope: ConfigPublicationEnvelope = {
		format: "omp-config-publication",
		formatVersion: CONFIG_SYNC_VERSION,
		epochId: input.epochId,
		writerId: input.writerId,
		sequence: input.sequence,
		revisionId: input.revisionId,
		parents,
	};
	return {
		...envelope,
		publicationId: hashStableJson(envelope),
	};
}

/** Returns a human-readable validation error instead of throwing for remote data. */
export function validateConfigRevision(revision: ConfigRevision): string | null {
	if (revision.format !== "omp-config-revision") return "revision format is invalid";
	if (revision.formatVersion !== CONFIG_SYNC_VERSION) return "revision format version is invalid";
	if (!isSha256(revision.revisionId)) return "revision ID is not a SHA-256 hex digest";
	if (!isCanonicalIdList(revision.parentRevisionIds)) return "revision parent IDs are not canonical";
	if (!isSha256(revision.payloadHash)) return "revision payload hash is not a SHA-256 hex digest";
	if (!isEncryptedBundle(revision.bundle)) return "revision bundle is invalid";
	if (hashStableJson(revision.bundle) !== revision.payloadHash)
		return "revision payload hash does not match its bundle";
	if (hashStableJson(revisionEnvelope(revision)) !== revision.revisionId) {
		return "revision ID does not match its canonical envelope";
	}
	return null;
}

/** Returns a human-readable validation error instead of throwing for remote data. */
export function validateConfigPublication(publication: ConfigPublication): string | null {
	if (publication.format !== "omp-config-publication") return "publication format is invalid";
	if (publication.formatVersion !== CONFIG_SYNC_VERSION) return "publication format version is invalid";
	if (!isSha256(publication.publicationId)) return "publication ID is not a SHA-256 hex digest";
	if (!isNonEmptyString(publication.epochId)) return "publication epoch ID is invalid";
	if (!isNonEmptyString(publication.writerId)) return "publication writer ID is invalid";
	if (!Number.isSafeInteger(publication.sequence) || publication.sequence < 0) {
		return "publication sequence is invalid";
	}
	if (!isSha256(publication.revisionId)) return "publication revision ID is not a SHA-256 hex digest";
	if (!areCanonicalPublicationParents(publication.parents)) return "publication parents are not canonical";
	if (hashStableJson(publicationEnvelope(publication)) !== publication.publicationId) {
		return "publication ID does not match its canonical envelope";
	}
	return null;
}

export class S3ConfigSyncStore {
	readonly profile: SyncProfile;
	readonly #client: ConfigSyncS3Client;
	readonly #prefix: string;

	constructor(profile: SyncProfile, options: S3ConfigSyncStoreOptions = {}) {
		this.profile = parseSyncProfile(profile);
		this.#prefix = normalizePrefix(this.profile.prefix);
		this.#client = options.client ?? createS3Client(this.profile);
	}

	async list(relativePrefix = ""): Promise<string[]> {
		const listPrefix = this.#toListPrefix(relativePrefix);
		const keys: string[] = [];
		const seenTokens = new Set<string>();
		let continuationToken: string | undefined;

		for (;;) {
			const page = await this.#client.list({
				prefix: listPrefix === "" ? undefined : listPrefix,
				continuationToken,
			});
			for (const object of page.contents ?? []) {
				if (!object.key.startsWith(listPrefix)) continue;
				const relative = object.key.slice(this.#prefix === "" ? 0 : this.#prefix.length + 1);
				if (!isSafeRelativeKey(relative)) continue;
				keys.push(relative);
			}
			if (!page.isTruncated) break;
			const next = page.nextContinuationToken;
			if (!next || seenTokens.has(next)) {
				throw new Error("S3 list response has an invalid continuation token");
			}
			seenTokens.add(next);
			continuationToken = next;
		}

		return [...new Set(keys)].sort(compareStrings);
	}

	async get(relativeKey: string): Promise<string | null> {
		try {
			return await this.#client.file(this.#toKey(relativeKey)).text();
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	}

	async put(relativeKey: string, content: string): Promise<void> {
		await this.#client.write(this.#toKey(relativeKey), content, { type: "application/json" });
	}

	async delete(relativeKey: string): Promise<void> {
		await this.#client.delete(this.#toKey(relativeKey));
	}

	async putImmutable(relativeKey: string, content: string): Promise<boolean> {
		const existing = await this.get(relativeKey);
		if (existing !== null) {
			if (existing !== content) throw new Error(`Refusing to overwrite immutable config sync object ${relativeKey}`);
			return false;
		}
		await this.put(relativeKey, content);
		return true;
	}

	revisionKey(revisionId: string): string {
		assertSha256(revisionId, "revision ID");
		return `${REVISION_PREFIX}${revisionId}.json`;
	}

	publicationKey(publicationId: string): string {
		assertSha256(publicationId, "publication ID");
		return `${PUBLICATION_PREFIX}${publicationId}.json`;
	}

	async getRevision(revisionId: string): Promise<ConfigRevision | null> {
		const key = this.revisionKey(revisionId);
		const content = await this.get(key);
		if (content === null) return null;
		return decodeStoredRevision(content, key);
	}

	async getPublication(publicationId: string): Promise<ConfigPublication | null> {
		const key = this.publicationKey(publicationId);
		const content = await this.get(key);
		if (content === null) return null;
		return decodeStoredPublication(content, key);
	}

	async listRevisions(): Promise<ConfigRevision[]> {
		const keys = await this.list(REVISION_PREFIX);
		return Promise.all(
			keys.map(async key => {
				const content = await this.get(key);
				if (content === null) throw new Error(`Revision disappeared while listing: ${key}`);
				return decodeStoredRevision(content, key);
			}),
		);
	}

	async listPublications(): Promise<ConfigPublication[]> {
		const keys = await this.list(PUBLICATION_PREFIX);
		return Promise.all(
			keys.map(async key => {
				const content = await this.get(key);
				if (content === null) throw new Error(`Publication disappeared while listing: ${key}`);
				return decodeStoredPublication(content, key);
			}),
		);
	}

	async putRevision(revision: ConfigRevision): Promise<boolean> {
		const validationError = validateConfigRevision(revision);
		if (validationError !== null) throw new Error(`Invalid config revision: ${validationError}`);
		for (const parentRevisionId of revision.parentRevisionIds) {
			const parent = await this.getRevision(parentRevisionId);
			if (parent === null) throw new Error(`Missing revision parent ${parentRevisionId}`);
		}
		return this.putImmutable(this.revisionKey(revision.revisionId), stableJson(revision));
	}

	async putPublication(publication: ConfigPublication): Promise<boolean> {
		const validationError = validateConfigPublication(publication);
		if (validationError !== null) throw new Error(`Invalid config publication: ${validationError}`);
		const revision = await this.getRevision(publication.revisionId);
		if (revision === null) throw new Error(`Publication revision is missing: ${publication.revisionId}`);
		if (
			!sameIdSet(
				revision.parentRevisionIds,
				publication.parents.map(parent => parent.revisionId),
			)
		) {
			throw new Error("Publication parents do not exactly match revision parent IDs");
		}
		for (const parentReference of publication.parents) {
			const parent = await this.getPublication(parentReference.publicationId);
			if (parent === null) throw new Error(`Missing publication parent ${parentReference.publicationId}`);
			if (parent.revisionId !== parentReference.revisionId) {
				throw new Error(`Publication parent ${parentReference.publicationId} has a different revision ID`);
			}
		}
		return this.putImmutable(this.publicationKey(publication.publicationId), stableJson(publication));
	}

	#toKey(relativeKey: string): string {
		assertSafeRelativeKey(relativeKey);
		const key = this.#prefix === "" ? relativeKey : `${this.#prefix}/${relativeKey}`;
		if (this.#prefix !== "" && !key.startsWith(`${this.#prefix}/`)) {
			throw new Error("Config sync key escapes its configured prefix");
		}
		return key;
	}

	#toListPrefix(relativePrefix: string): string {
		if (relativePrefix === "") return this.#prefix === "" ? "" : `${this.#prefix}/`;
		const withoutTrailingSlash = relativePrefix.endsWith("/") ? relativePrefix.slice(0, -1) : relativePrefix;
		assertSafeRelativeKey(withoutTrailingSlash);
		const relative = `${withoutTrailingSlash}/`;
		return this.#prefix === "" ? relative : `${this.#prefix}/${relative}`;
	}
}

function createS3Client(profile: SyncProfile): ConfigSyncS3Client {
	const options: {
		bucket: string;
		endpoint?: string;
		region?: string;
		virtualHostedStyle?: boolean;
		accessKeyId?: string;
		secretAccessKey?: string;
		sessionToken?: string;
	} = { bucket: profile.bucket };
	if (profile.endpoint !== undefined) options.endpoint = profile.endpoint;
	if (profile.region !== undefined) options.region = profile.region;
	if (profile.virtualHostedStyle !== undefined) options.virtualHostedStyle = profile.virtualHostedStyle;
	if (profile.accessKeyIdEnv !== undefined) options.accessKeyId = requireCredentialEnv(profile.accessKeyIdEnv);
	if (profile.secretAccessKeyEnv !== undefined)
		options.secretAccessKey = requireCredentialEnv(profile.secretAccessKeyEnv);
	if (profile.sessionTokenEnv !== undefined) options.sessionToken = requireCredentialEnv(profile.sessionTokenEnv);
	return new S3Client(options);
}

function requireCredentialEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Config sync credential environment variable ${name} is not set`);
	return value;
}

function decodeStoredRevision(content: string, key: string): ConfigRevision {
	const value = parseJson(content, key);
	const revision = decodeConfigRevision(value);
	if (revision === null) throw new Error(`Invalid revision object at ${key}`);
	const validationError = validateConfigRevision(revision);
	if (validationError !== null) throw new Error(`Invalid revision object at ${key}: ${validationError}`);
	if (key !== `${REVISION_PREFIX}${revision.revisionId}.json`) {
		throw new Error(`Revision object key does not match its ID at ${key}`);
	}
	return revision;
}

function decodeStoredPublication(content: string, key: string): ConfigPublication {
	const value = parseJson(content, key);
	const publication = decodeConfigPublication(value);
	if (publication === null) throw new Error(`Invalid publication object at ${key}`);
	const validationError = validateConfigPublication(publication);
	if (validationError !== null) throw new Error(`Invalid publication object at ${key}: ${validationError}`);
	if (key !== `${PUBLICATION_PREFIX}${publication.publicationId}.json`) {
		throw new Error(`Publication object key does not match its ID at ${key}`);
	}
	return publication;
}

function parseJson(content: string, key: string): unknown {
	try {
		return JSON.parse(content) as unknown;
	} catch (error) {
		throw new Error(`Invalid JSON at ${key}`, { cause: error });
	}
}

export function decodeConfigRevision(value: unknown): ConfigRevision | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["bundle", "format", "formatVersion", "parentRevisionIds", "payloadHash", "revisionId"])
	) {
		return null;
	}
	const parentRevisionIds = asStringArray(value.parentRevisionIds);
	const bundle = decodeEncryptedBundle(value.bundle);
	if (
		value.format !== "omp-config-revision" ||
		value.formatVersion !== CONFIG_SYNC_VERSION ||
		typeof value.revisionId !== "string" ||
		parentRevisionIds === null ||
		typeof value.payloadHash !== "string" ||
		bundle === null
	) {
		return null;
	}
	return {
		format: value.format,
		formatVersion: value.formatVersion,
		revisionId: value.revisionId,
		parentRevisionIds,
		payloadHash: value.payloadHash,
		bundle,
	};
}

export function decodeConfigPublication(value: unknown): ConfigPublication | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"epochId",
			"format",
			"formatVersion",
			"parents",
			"publicationId",
			"revisionId",
			"sequence",
			"writerId",
		])
	) {
		return null;
	}
	const sequence = value.sequence;
	const parents = decodePublicationParents(value.parents);
	if (
		value.format !== "omp-config-publication" ||
		value.formatVersion !== CONFIG_SYNC_VERSION ||
		typeof value.epochId !== "string" ||
		typeof value.publicationId !== "string" ||
		typeof value.writerId !== "string" ||
		typeof sequence !== "number" ||
		!Number.isSafeInteger(sequence) ||
		typeof value.revisionId !== "string" ||
		parents === null
	) {
		return null;
	}
	return {
		format: value.format,
		formatVersion: value.formatVersion,
		epochId: value.epochId,
		publicationId: value.publicationId,
		writerId: value.writerId,
		sequence,
		revisionId: value.revisionId,
		parents,
	};
}

function decodeEncryptedBundle(value: unknown): EncryptedConfigBundle | null {
	if (!isRecord(value) || !hasExactKeys(value, ["ciphertext", "encryption", "format", "formatVersion"])) return null;
	if (
		!isRecord(value.encryption) ||
		!hasExactKeys(value.encryption, ["algorithm", "iterations", "iv", "kdf", "salt"])
	) {
		return null;
	}
	const iterations = value.encryption.iterations;
	if (
		value.format !== "omp-config-bundle" ||
		value.formatVersion !== 1 ||
		value.encryption.algorithm !== "AES-256-GCM" ||
		value.encryption.kdf !== "PBKDF2-SHA-256" ||
		typeof iterations !== "number" ||
		!Number.isSafeInteger(iterations) ||
		iterations < 1 ||
		typeof value.encryption.salt !== "string" ||
		typeof value.encryption.iv !== "string" ||
		typeof value.ciphertext !== "string"
	) {
		return null;
	}
	return {
		format: value.format,
		formatVersion: value.formatVersion,
		encryption: {
			algorithm: value.encryption.algorithm,
			kdf: value.encryption.kdf,
			iterations,
			salt: value.encryption.salt,
			iv: value.encryption.iv,
		},
		ciphertext: value.ciphertext,
	};
}

function decodePublicationParents(value: unknown): PublicationParent[] | null {
	if (!Array.isArray(value)) return null;
	const parents: PublicationParent[] = [];
	for (const parent of value) {
		if (!isRecord(parent) || !hasExactKeys(parent, ["publicationId", "revisionId"])) return null;
		if (typeof parent.publicationId !== "string" || typeof parent.revisionId !== "string") return null;
		parents.push({ publicationId: parent.publicationId, revisionId: parent.revisionId });
	}
	return parents;
}

function assertEncryptedBundle(bundle: EncryptedConfigBundle): void {
	if (!isEncryptedBundle(bundle)) throw new Error("Encrypted config bundle is invalid");
}

function isEncryptedBundle(bundle: EncryptedConfigBundle): boolean {
	return decodeEncryptedBundle(bundle) !== null;
}

function canonicalIdList(ids: readonly string[], label: string): string[] {
	const sorted = [...ids].sort(compareStrings);
	for (let index = 0; index < sorted.length; index += 1) {
		assertSha256(sorted[index], `${label} ID`);
		if (index > 0 && sorted[index] === sorted[index - 1]) {
			throw new Error(`Duplicate ${label} ID ${sorted[index]}`);
		}
	}
	return sorted;
}

function isCanonicalIdList(ids: readonly string[]): boolean {
	let previous: string | undefined;
	for (const id of ids) {
		if (!isSha256(id) || (previous !== undefined && compareStrings(previous, id) >= 0)) return false;
		previous = id;
	}
	return true;
}

function canonicalPublicationParents(parents: readonly PublicationParent[]): PublicationParent[] {
	const canonical = parents.map(parent => {
		assertSha256(parent.publicationId, "parent publication ID");
		assertSha256(parent.revisionId, "parent revision ID");
		return { publicationId: parent.publicationId, revisionId: parent.revisionId };
	});
	canonical.sort((left, right) => compareStrings(left.publicationId, right.publicationId));
	for (let index = 0; index < canonical.length; index += 1) {
		const current = canonical[index];
		const previous = canonical[index - 1];
		if (previous !== undefined && previous.publicationId === current.publicationId) {
			throw new Error(`Duplicate parent publication ID ${current.publicationId}`);
		}
	}
	return canonical;
}

function areCanonicalPublicationParents(parents: readonly PublicationParent[]): boolean {
	let previousPublicationId: string | undefined;
	for (const parent of parents) {
		if (!isSha256(parent.publicationId) || !isSha256(parent.revisionId)) return false;
		if (previousPublicationId !== undefined && compareStrings(previousPublicationId, parent.publicationId) >= 0)
			return false;
		previousPublicationId = parent.publicationId;
	}
	return true;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	for (const id of rightSet) {
		if (!leftSet.has(id)) return false;
	}
	return true;
}

function normalizePrefix(prefix: string): string {
	if (prefix === "") return "";
	if (prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\u0000")) {
		throw new Error("Sync profile prefix must be a relative S3 prefix");
	}
	const withoutTrailingSlash = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	if (withoutTrailingSlash === "") return "";
	assertSafeRelativeKey(withoutTrailingSlash);
	return withoutTrailingSlash;
}

function assertSafeRelativeKey(key: string): void {
	if (!isSafeRelativeKey(key)) throw new Error(`Unsafe config sync relative key: ${key}`);
}

function isSafeRelativeKey(key: string): boolean {
	if (key === "" || key.startsWith("/") || key.includes("\\") || key.includes("\u0000")) return false;
	for (const segment of key.split("/")) {
		if (segment === "" || segment === "." || segment === "..") return false;
	}
	return true;
}

function isNotFoundError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	const status = error.status;
	const code = error.code;
	if (status === 404 || code === "NoSuchKey" || code === "NotFound") return true;
	return typeof error.message === "string" && /(?:no such key|not found|status 404)/i.test(error.message);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(record).sort(compareStrings);
	if (actual.length !== expected.length) return false;
	const sortedExpected = [...expected].sort(compareStrings);
	return actual.every((key, index) => key === sortedExpected[index]);
}

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) return null;
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function assertNonEmptyString(value: string, label: string): void {
	if (!isNonEmptyString(value)) throw new Error(`${label} must be a non-empty string`);
}

function isSha256(value: string): boolean {
	return SHA256_HEX_PATTERN.test(value);
}

function assertSha256(value: string, label: string): void {
	if (!isSha256(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
