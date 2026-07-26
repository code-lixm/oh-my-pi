/**
 * Project-scoped configuration — adapted from upstream
 * `src/project-config.ts` (MIT, Copyright (c) 2026 Colby Mchenry).
 *
 * OMP porting notes:
 *  - Reads ONLY `codegraph.json` from `sourceRoot`. It does not write or
 *    probe any project directory beyond that file.
 *  - `.gitignore` parsing is intentionally NOT included here — the
 *    contract asks only that the project-level config is honored.
 *    Adding full gitignore support can come in a later iteration.
 *  - The `Ignore` library is replaced with a minimal in-memory matcher
 *    that handles the subset of patterns the upstream config used
 *    (`include` / `includeIgnored` / `exclude` whitelists). Anything
 *    richer delegates back to Bun's native glob.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";

export const PROJECT_CONFIG_FILENAME = "codegraph.json";

export interface ProjectConfig {
	/** Map extension (e.g. `.vue`) → language override. */
	extensions?: Record<string, string>;
	/** Patterns to include even when ignored by `.gitignore`. */
	includeIgnored?: string[];
	/** Patterns to exclude from the index entirely. */
	exclude?: string[];
	/** Patterns to include in the index (positive whitelist). */
	include?: string[];
}

interface CacheEntry {
	mtimeMs: number;
	value: ProjectConfig | null;
}

const cache = new Map<string, CacheEntry>();

interface NormalizedConfig {
	extensions: Record<string, string>;
	includeIgnored: string[];
	exclude: string[];
	include: string[];
}

const EMPTY_NORMALIZED: NormalizedConfig = {
	extensions: {},
	includeIgnored: [],
	exclude: [],
	include: [],
};

function normalizeExtKey(raw: string): string | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function extractExtensions(parsed: unknown, file: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!parsed || typeof parsed !== "object") return out;
	const raw = (parsed as { extensions?: unknown }).extensions;
	if (!raw || typeof raw !== "object") return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const ext = normalizeExtKey(k);
		if (!ext || typeof v !== "string") {
			logger.warn("CodeGraph: ignoring bad extension mapping", { path: file, extension: k });
			continue;
		}
		out[ext] = v;
	}
	return out;
}

function extractStringList(parsed: unknown, field: "includeIgnored" | "exclude" | "include", file: string): string[] {
	if (!parsed || typeof parsed !== "object") return [];
	const raw = (parsed as Record<string, unknown>)[field];
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		logger.warn("CodeGraph: ignoring non-array config field", { path: file, field });
		return [];
	}
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
	}
	return out;
}

async function parseConfig(file: string): Promise<NormalizedConfig> {
	let content: string;
	try {
		content = await fs.readFile(file, "utf8");
	} catch {
		return EMPTY_NORMALIZED;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		logger.warn("CodeGraph: failed to parse project config", { path: file, error: String(err) });
		return EMPTY_NORMALIZED;
	}
	return {
		extensions: extractExtensions(parsed, file),
		includeIgnored: extractStringList(parsed, "includeIgnored", file),
		exclude: extractStringList(parsed, "exclude", file),
		include: extractStringList(parsed, "include", file),
	};
}

async function loadNormalized(rootDir: string): Promise<NormalizedConfig> {
	const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);
	let mtimeMs = 0;
	try {
		const st = await fs.stat(file);
		mtimeMs = st.mtimeMs;
	} catch {
		return EMPTY_NORMALIZED;
	}
	const hit = cache.get(rootDir);
	if (hit && hit.mtimeMs === mtimeMs) {
		return hit.value === null ? EMPTY_NORMALIZED : (hit.value as unknown as NormalizedConfig);
	}
	const parsed = await parseConfig(file);
	cache.set(rootDir, { mtimeMs, value: parsed as unknown as ProjectConfig });
	return parsed;
}

/** Load extension overrides (`.ext` → language) — empty when missing. */
export async function loadExtensionOverrides(rootDir: string): Promise<Record<string, string>> {
	const n = await loadNormalized(rootDir);
	return n.extensions;
}

export async function loadIncludeIgnoredPatterns(rootDir: string): Promise<string[]> {
	const n = await loadNormalized(rootDir);
	return n.includeIgnored;
}

export async function loadExcludePatterns(rootDir: string): Promise<string[]> {
	const n = await loadNormalized(rootDir);
	return n.exclude;
}

export async function loadIncludePatterns(rootDir: string): Promise<string[]> {
	const n = await loadNormalized(rootDir);
	return n.include;
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting in a test). */
export function clearProjectConfigCache(): void {
	cache.clear();
}
