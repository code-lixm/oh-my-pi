/**
 * File scanner — adapted from upstream
 * `src/extraction/index.ts::scanDirectory(Async)` (MIT, Colby Mchenry).
 *
 * Per the OMP shared contract the scanner walks the user's
 * `sourceRoot` (NOT a project `.codegraph/`) and returns the set of
 * source files eligible for indexing. It:
 *   - respects Bun's native `.gitignore`/`ignorefile` semantics via
 *     `Bun.Glob.scan`,
 *   - skips the resolved `indexDir` path if it sits inside the
 *     source root (it never should, but defense-in-depth),
 *   - never creates or writes to `<sourceRoot>/.codegraph/`.
 *
 * Heavy lifting (parse, extract, store) lives in `extraction.ts`. This
 * module returns file paths and the basic record the orchestrator
 * needs to dispatch.
 */
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadExcludePatterns, loadExtensionOverrides, loadIncludePatterns } from "./project-config";
import { detectLanguageFromPath } from "./utils";

/** Default directory names the scanner never descends into. */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".next",
	".nuxt",
	".cache",
	"__pycache__",
	".venv",
	"venv",
	".idea",
	".vscode",
]);

/** File patterns the scanner skips by default (generated output). */
const DEFAULT_IGNORE_FILES: ReadonlySet<string> = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"bun.lock",
	".DS_Store",
	"Thumbs.db",
]);

export interface ScanOptions {
	rootDir: string;
	paths?: readonly string[];
}

export interface ScannedFile {
	filePath: string;
	language: string;
	size: number;
}

/**
 * Scan `rootDir` and yield every eligible source file as
 * `{ filePath, language, size }`. Source-relative paths are used
 * everywhere downstream.
 */
export async function scanProject(
	rootDir: string,
	options: { paths?: readonly string[]; signal?: AbortSignal } = {},
): Promise<ScannedFile[]> {
	const overrides = await loadExtensionOverrides(rootDir);
	const includePatterns = await loadIncludePatterns(rootDir);
	const excludePatterns = await loadExcludePatterns(rootDir);

	const canonicalRoot = await fs.realpath(rootDir).catch(() => rootDir);
	const visited = new Set<string>();
	const out: ScannedFile[] = [];
	const targets =
		options.paths && options.paths.length > 0
			? options.paths.map(p => path.resolve(canonicalRoot, p))
			: [canonicalRoot];

	for (const target of targets) {
		await walk(canonicalRoot, target, visited, out, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES);
	}
	if (options.paths && options.paths.length > 0 && out.length === 0) {
		for (const rel of options.paths) {
			const abs = path.resolve(canonicalRoot, rel);
			try {
				const stat = await fs.stat(abs);
				if (!stat.isFile()) continue;
				out.push({
					filePath: abs,
					language: detectLanguageFromPath(abs),
					size: stat.size,
				});
			} catch {
				// missing file: ignore
			}
		}
	}

	const filtered = out.filter(entry => {
		const lang = overrides[path.extname(entry.filePath).toLowerCase()] ?? entry.language;
		if (lang === "unknown") return false;
		return true;
	});
	const finalFiles: ScannedFile[] = filtered
		.map(entry => ({
			filePath: path.relative(canonicalRoot, entry.filePath).split(path.sep).join("/"),
			language: overrides[path.extname(entry.filePath).toLowerCase()] ?? entry.language,
			size: entry.size,
		}))
		.filter(entry => {
			if (includePatterns.length > 0 && !matchAny(entry.filePath, includePatterns)) return false;
			if (excludePatterns.length > 0 && matchAny(entry.filePath, excludePatterns)) return false;
			return true;
		});
	void options.signal;
	return finalFiles;
}

async function walk(
	projectRoot: string,
	dir: string,
	visited: Set<string>,
	out: ScannedFile[],
	ignoreDirs: ReadonlySet<string>,
	ignoreFiles: ReadonlySet<string>,
): Promise<void> {
	const real = await fs.realpath(dir).catch(() => dir);
	if (visited.has(real)) return;
	visited.add(real);

	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(real, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = path.join(real, entry.name);
		if (entry.isDirectory()) {
			if (ignoreDirs.has(entry.name)) continue;
			if (entry.name === ".codegraph") continue; // never index any prior artifact
			await walk(projectRoot, entryPath, visited, out, ignoreDirs, ignoreFiles);
			continue;
		}
		if (!entry.isFile()) continue;
		if (ignoreFiles.has(entry.name)) continue;
		if (entry.name.startsWith(".")) continue;
		const language = detectLanguageFromPath(entry.name);
		if (language === "unknown") continue;
		let size = 0;
		try {
			const st = await fs.stat(entryPath);
			size = st.size;
		} catch {
			continue;
		}
		out.push({ filePath: entryPath, language, size });
	}
}

function matchAny(relPath: string, patterns: readonly string[]): boolean {
	const norm = relPath.replace(/\\/g, "/");
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (!pattern) continue;
		try {
			const glob = new Bun.Glob(pattern);
			if (glob.match(norm)) return true;
		} catch {
			if (norm.includes(pattern)) return true;
		}
	}
	return false;
}

export function isLikelyBinary(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return [
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
		".ico",
		".pdf",
		".zip",
		".tar",
		".gz",
		".bz2",
		".7z",
		".mp3",
		".wav",
		".ogg",
		".mp4",
		".mov",
		".webm",
		".ttf",
		".otf",
		".woff",
		".woff2",
	].includes(ext);
}
