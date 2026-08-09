import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
	ConfigBundleEncryption,
	ConfigSnapshot,
	EncryptedConfigBundle,
	EncryptedSyncBootstrapBundle,
	SyncBootstrapPayload,
} from "./types";
import { CONFIG_BUNDLE_VERSION, SYNC_BOOTSTRAP_BUNDLE_VERSION } from "./types";

const AES_GCM_ALGORITHM = "AES-GCM";
const AES_KEY_BITS = 256;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_MIN_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 5_000_000;

/** Calibrated to the current OWASP PBKDF2-HMAC-SHA-256 guidance. */
export const CONFIG_BUNDLE_PBKDF2_ITERATIONS = 600_000;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Serialize JSON-compatible values with object keys in lexical order.
 *
 * Configuration snapshots contain only JSON data. Rejecting values outside that
 * domain avoids silently changing the payload while deriving its content hash.
 */
export function stableJson(value: unknown): string {
	return stringifyStable(value, new Set<object>());
}

/** SHA-256 digest encoded as lower-case hexadecimal. */
export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON followed by {@link sha256Hex}. */
export function hashStableJson(value: unknown): string {
	return sha256Hex(stableJson(value));
}

/** Encrypt one configuration snapshot into the portable bundle envelope. */
export async function encryptConfigSnapshot(
	snapshot: ConfigSnapshot,
	passphrase: string,
): Promise<EncryptedConfigBundle> {
	assertConfigSnapshot(snapshot);
	const encrypted = await encryptJsonValue(snapshot, passphrase);
	return {
		format: "omp-config-bundle",
		formatVersion: CONFIG_BUNDLE_VERSION,
		...encrypted,
	};
}

/** Decrypt and validate a portable configuration bundle. */
export async function decryptConfigBundle(bundle: EncryptedConfigBundle, passphrase: string): Promise<ConfigSnapshot> {
	assertEncryptedConfigBundle(bundle);
	const parsed = await decryptJsonValue(bundle.encryption, bundle.ciphertext, passphrase, "config bundle");
	assertConfigSnapshot(parsed);
	return parsed;
}
/** Encrypt the S3 bootstrap payload without including the repository passphrase. */
export async function encryptSyncBootstrapPayload(
	payload: SyncBootstrapPayload,
	passphrase: string,
): Promise<EncryptedSyncBootstrapBundle> {
	const encrypted = await encryptJsonValue(payload, passphrase);
	return {
		format: "omp-sync-bootstrap-bundle",
		formatVersion: SYNC_BOOTSTRAP_BUNDLE_VERSION,
		...encrypted,
	};
}

export async function decryptSyncBootstrapPayload(bundle: unknown, passphrase: string): Promise<unknown> {
	assertEncryptedSyncBootstrapBundle(bundle);
	return decryptJsonValue(bundle.encryption, bundle.ciphertext, passphrase, "sync bootstrap bundle");
}

export function assertEncryptedSyncBootstrapBundle(value: unknown): asserts value is EncryptedSyncBootstrapBundle {
	if (!isRecord(value)) throw new Error("Encrypted sync bootstrap bundle must be an object");
	if (value.format !== "omp-sync-bootstrap-bundle") throw new Error("Unsupported sync bootstrap bundle format");
	if (value.formatVersion !== SYNC_BOOTSTRAP_BUNDLE_VERSION) {
		throw new Error(`Unsupported sync bootstrap bundle version: ${String(value.formatVersion)}`);
	}
	assertBundleEncryption(value.encryption, "Sync bootstrap bundle");
	if (typeof value.ciphertext !== "string") {
		throw new Error("Sync bootstrap bundle ciphertext must be a base64 string");
	}
}

/** Reject malformed bundle metadata before expensive PBKDF2 work begins. */
export function assertEncryptedConfigBundle(value: unknown): asserts value is EncryptedConfigBundle {
	if (!isRecord(value)) throw new Error("Encrypted config bundle must be an object");
	if (value.format !== "omp-config-bundle") throw new Error("Unsupported config bundle format");
	if (value.formatVersion !== CONFIG_BUNDLE_VERSION) {
		throw new Error(`Unsupported config bundle version: ${String(value.formatVersion)}`);
	}
	assertBundleEncryption(value.encryption, "Config bundle");
	if (typeof value.ciphertext !== "string") throw new Error("Config bundle ciphertext must be a base64 string");
}

/** Validate the JSON payload shape carried inside an authenticated bundle. */
export function assertConfigSnapshot(value: unknown): asserts value is ConfigSnapshot {
	if (!isRecord(value)) throw new Error("Config snapshot must be an object");
	if (value.formatVersion !== CONFIG_BUNDLE_VERSION) {
		throw new Error(`Unsupported config snapshot version: ${String(value.formatVersion)}`);
	}
	if (typeof value.createdAt !== "string") throw new Error("Config snapshot createdAt must be a string");
	if (!Array.isArray(value.files)) throw new Error("Config snapshot files must be an array");
	if (!isRecord(value.auth)) throw new Error("Config snapshot auth must be an object");

	const paths = new Set<string>();
	for (const file of value.files) {
		if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
			throw new Error("Config snapshot contains an invalid file entry");
		}
		if (paths.has(file.path)) throw new Error(`Config snapshot contains duplicate file path: ${file.path}`);
		paths.add(file.path);
		if (
			file.mode !== undefined &&
			(typeof file.mode !== "number" || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
		) {
			throw new Error(`Config snapshot contains an invalid mode for ${file.path}`);
		}
	}

	for (const [provider, credentialEntry] of Object.entries(value.auth)) {
		if (provider.length === 0) throw new Error("Config snapshot contains an empty auth provider name");
		if (Array.isArray(credentialEntry)) {
			for (const credential of credentialEntry) assertAuthCredential(credential, provider);
		} else {
			assertAuthCredential(credentialEntry, provider);
		}
	}
}
function assertBundleEncryption(value: unknown, label: string): asserts value is ConfigBundleEncryption {
	if (!isRecord(value)) throw new Error(`${label} encryption metadata must be an object`);
	if (value.algorithm !== "AES-256-GCM" || value.kdf !== "PBKDF2-SHA-256") {
		throw new Error(`Unsupported ${label.toLowerCase()} encryption algorithm`);
	}
	if (
		typeof value.iterations !== "number" ||
		!Number.isSafeInteger(value.iterations) ||
		value.iterations < PBKDF2_MIN_ITERATIONS ||
		value.iterations > PBKDF2_MAX_ITERATIONS
	) {
		throw new Error(`${label} PBKDF2 iteration count is outside the accepted range`);
	}
	if (typeof value.salt !== "string" || typeof value.iv !== "string") {
		throw new Error(`${label} encryption values must be base64 strings`);
	}
}

async function encryptJsonValue(
	value: unknown,
	passphrase: string,
): Promise<{ encryption: ConfigBundleEncryption; ciphertext: string }> {
	const passphraseBytes = encodePassphrase(passphrase);
	const salt = new Uint8Array(PBKDF2_SALT_BYTES);
	const iv = new Uint8Array(GCM_IV_BYTES);
	crypto.getRandomValues(salt);
	crypto.getRandomValues(iv);
	const encryption: ConfigBundleEncryption = {
		algorithm: "AES-256-GCM",
		kdf: "PBKDF2-SHA-256",
		iterations: CONFIG_BUNDLE_PBKDF2_ITERATIONS,
		salt: encodeBase64(salt),
		iv: encodeBase64(iv),
	};
	const key = await deriveKey(passphraseBytes, salt, encryption.iterations);
	const plaintext = TEXT_ENCODER.encode(stableJson(value));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_GCM_ALGORITHM, iv }, key, plaintext));
	return { encryption, ciphertext: encodeBase64(ciphertext) };
}

async function decryptJsonValue(
	encryption: ConfigBundleEncryption,
	ciphertextValue: string,
	passphrase: string,
	description: string,
): Promise<unknown> {
	const passphraseBytes = encodePassphrase(passphrase);
	const salt = decodeBase64(encryption.salt, "PBKDF2 salt");
	const iv = decodeBase64(encryption.iv, "AES-GCM IV");
	const ciphertext = decodeBase64(ciphertextValue, "ciphertext");
	if (salt.byteLength !== PBKDF2_SALT_BYTES) {
		throw new Error(`Invalid PBKDF2 salt length: expected ${PBKDF2_SALT_BYTES} bytes`);
	}
	if (iv.byteLength !== GCM_IV_BYTES) {
		throw new Error(`Invalid AES-GCM IV length: expected ${GCM_IV_BYTES} bytes`);
	}
	if (ciphertext.byteLength <= GCM_TAG_BYTES) {
		throw new Error(`Encrypted ${description} ciphertext is too short`);
	}

	const key = await deriveKey(passphraseBytes, salt, encryption.iterations);
	let plaintext: Uint8Array;
	try {
		plaintext = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: AES_GCM_ALGORITHM, iv: asStrictBufferSource(iv) },
				key,
				asStrictBufferSource(ciphertext),
			),
		);
	} catch {
		throw new Error(`Unable to decrypt ${description}: invalid passphrase or authenticated ciphertext`);
	}

	try {
		return JSON.parse(TEXT_DECODER.decode(plaintext));
	} catch {
		throw new Error(`Decrypted ${description} does not contain valid JSON`);
	}
}

function stringifyStable(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new Error("Stable JSON cannot serialize non-finite numbers");
			return JSON.stringify(value);
		case "object":
			break;
		default:
			throw new Error(`Stable JSON cannot serialize values of type ${typeof value}`);
	}

	if (ancestors.has(value)) throw new Error("Stable JSON cannot serialize circular structures");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map(item => stringifyStable(item, ancestors)).join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Stable JSON only accepts plain objects and arrays");
		}
		const record = value as Record<string, unknown>;
		const properties = Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stringifyStable(record[key], ancestors)}`);
		return `{${properties.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

function encodePassphrase(passphrase: string): Uint8Array {
	if (typeof passphrase !== "string" || passphrase.length === 0) {
		throw new Error("A non-empty config bundle passphrase is required");
	}
	return TEXT_ENCODER.encode(passphrase);
}

async function deriveKey(passphrase: Uint8Array, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", asStrictBufferSource(passphrase), "PBKDF2", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: asStrictBufferSource(salt),
			iterations,
			hash: "SHA-256",
		},
		material,
		{ name: AES_GCM_ALGORITHM, length: AES_KEY_BITS },
		false,
		["encrypt", "decrypt"],
	);
}

function encodeBase64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string, label: string): Uint8Array {
	if (value.length === 0 || !BASE64_PATTERN.test(value)) {
		throw new Error(`Invalid base64 ${label}`);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw new Error(`Invalid base64 ${label}`);
	const result = new Uint8Array(decoded.byteLength);
	result.set(decoded);
	return result;
}

function assertAuthCredential(value: unknown, provider: string): void {
	if (!isRecord(value)) throw new Error(`Config snapshot auth entry for ${provider} must be an object`);
	if (value.type === "api_key") {
		if (typeof value.key !== "string") throw new Error(`Config snapshot API key for ${provider} is invalid`);
		if (value.source !== undefined && value.source !== "login") {
			throw new Error(`Config snapshot API key source for ${provider} is invalid`);
		}
		return;
	}
	if (value.type !== "oauth") throw new Error(`Config snapshot credential type for ${provider} is invalid`);
	if (typeof value.refresh !== "string" || typeof value.access !== "string" || !isFiniteNumber(value.expires)) {
		throw new Error(`Config snapshot OAuth credential for ${provider} is invalid`);
	}
	for (const key of ["enterpriseUrl", "projectId", "email", "accountId", "apiEndpoint", "orgId", "orgName"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw new Error(`Config snapshot OAuth ${key} for ${provider} is invalid`);
		}
	}
	if (value.authorizedAt !== undefined && !isFiniteNumber(value.authorizedAt)) {
		throw new Error(`Config snapshot OAuth authorizedAt for ${provider} is invalid`);
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStrictBufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
	if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
		return value as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	return copy;
}
