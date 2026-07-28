/** Runtime adapter for the validated location metadata contract. */
import { EXTRACTION_VERSION } from "./extraction";
import type { CodeGraphIndexLocation, CodeGraphLocationMetadata } from "./location";
import {
	getCodeGraphIndexLocationStatus,
	readCodeGraphLocationMetadata,
	writeCodeGraphLocationMetadata,
} from "./location";

export const EXTRACTION_SCHEMA_VERSION = 1;
export const RUNTIME_SCHEMA_VERSION = 1;

export type CodeGraphMetadata = CodeGraphLocationMetadata;

type MetadataPatch = {
	identity?: CodeGraphIndexLocation["identity"];
	extractionVersion?: string;
	indexSchemaVersion?: string | number | null;
	nativeContractVersion?: string | null;
	lastSyncedAt?: number | string | null;
	lastUsedAt?: number | string | null;
};

function timestampString(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	return new Date(value).toISOString();
}

export async function readMetadata(location: CodeGraphIndexLocation): Promise<CodeGraphMetadata | null> {
	return readCodeGraphLocationMetadata(location);
}

export function defaultMetadata(location: CodeGraphIndexLocation): CodeGraphMetadata {
	return {
		schemaVersion: 2,
		identity: location.identity,
		extractionVersion: EXTRACTION_VERSION,
		indexSchemaVersion: RUNTIME_SCHEMA_VERSION,
		nativeContractVersion: null,
		lastSyncedAt: null,
		lastUsedAt: null,
	};
}

export async function writeMetadata(
	location: CodeGraphIndexLocation,
	patch: MetadataPatch,
): Promise<CodeGraphMetadata> {
	const previous = (await readMetadata(location)) ?? defaultMetadata(location);
	const nativeContractVersion = Object.hasOwn(patch, "nativeContractVersion")
		? (patch.nativeContractVersion ?? null)
		: previous.nativeContractVersion;
	return writeCodeGraphLocationMetadata(location, {
		extractionVersion: patch.extractionVersion ?? previous.extractionVersion ?? EXTRACTION_VERSION,
		indexSchemaVersion: patch.indexSchemaVersion ?? previous.indexSchemaVersion ?? RUNTIME_SCHEMA_VERSION,
		nativeContractVersion,
		lastSyncedAt: timestampString(patch.lastSyncedAt) ?? previous.lastSyncedAt ?? new Date(0).toISOString(),
	});
}

export async function metadataIsStale(
	location: CodeGraphIndexLocation,
	nativeContractVersion?: string | null,
): Promise<boolean> {
	const status = await getCodeGraphIndexLocationStatus(location);
	if (!status.exists) return false;
	const metadata = status.metadata;
	if (!status.verified || !metadata) return true;
	if (metadata.extractionVersion !== EXTRACTION_VERSION) return true;
	if (metadata.indexSchemaVersion !== RUNTIME_SCHEMA_VERSION) return true;
	if (nativeContractVersion && metadata.nativeContractVersion !== nativeContractVersion) return true;
	return false;
}
