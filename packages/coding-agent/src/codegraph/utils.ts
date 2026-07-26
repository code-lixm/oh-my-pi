/**
 * OMP CodeGraph utilities — adapted from upstream `src/utils.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * Only the subset used by the OMP runtime is ported here. The
 * cross-process `FileLock`, path validation, and JSON helpers stay;
 * the `Ignore` matcher and `Mutex` are replaced with primitives
 * that don't depend on the upstream `ignore` package.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { FileLockUnavailableError } from "./errors";

/** Normalize a file path to forward slashes for portable comparisons. */
export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

/** Safe JSON parse with a typed fallback — never throws. */
export function safeJsonParse<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Cross-process file lock keyed by an injected `lockPath`. The lock
 * file lives in `indexDir` (per the OMP contract); no project-local
 * paths are ever created.
 *
 * Implements a single-PID guard: only the holder of the recorded PID
 * may release the lock. Stale PIDs (process gone) are reaped on
 * acquisition.
 */
const inProcessLockTails = new Map<string, Promise<void>>();

export class CodeGraphFileLock {
	readonly #lockPath: string;
	#acquired = false;
	#inProcessTail?: Promise<void>;
	#releaseInProcess?: () => void;

	constructor(lockPath: string) {
		this.#lockPath = lockPath;
	}

	async acquire(): Promise<void> {
		if (this.#acquired) return;
		const previous = inProcessLockTails.get(this.#lockPath);
		const gate = Promise.withResolvers<void>();
		this.#inProcessTail = gate.promise;
		this.#releaseInProcess = gate.resolve;
		inProcessLockTails.set(this.#lockPath, gate.promise);
		if (previous) await previous;

		try {
			const existing = readIfPresent(this.#lockPath);
			if (existing !== null) {
				const parsed = parseLockContent(existing);
				if (parsed !== null && parsed.pid !== process.pid && isPidAlive(parsed.pid)) {
					throw new FileLockUnavailableError(`lock ${this.#lockPath} held by pid ${parsed.pid}`);
				}
			}
		} catch (err) {
			if (err instanceof FileLockUnavailableError) {
				this.#releaseProcessGate();
				throw err;
			}
			// Treat unreadable lock files as absent — best-effort.
		}
		try {
			const tmp = `${this.#lockPath}.${process.pid}.tmp`;
			fs.mkdirSync(path.dirname(tmp), { recursive: true });
			fs.writeFileSync(tmp, lockContent(), "utf8");
			fs.renameSync(tmp, this.#lockPath);
			this.#acquired = true;
		} catch (err) {
			this.#releaseProcessGate();
			throw new FileLockUnavailableError(`failed to acquire lock ${this.#lockPath}: ${(err as Error).message}`);
		}
	}

	release(): void {
		if (this.#acquired) {
			try {
				fs.unlinkSync(this.#lockPath);
			} catch {
				// Best-effort; lock files are reaped on the next acquire.
			}
			this.#acquired = false;
		}
		this.#releaseProcessGate();
	}

	get isHeld(): boolean {
		return this.#acquired;
	}

	#releaseProcessGate(): void {
		this.#releaseInProcess?.();
		this.#releaseInProcess = undefined;
		if (this.#inProcessTail && inProcessLockTails.get(this.#lockPath) === this.#inProcessTail) {
			inProcessLockTails.delete(this.#lockPath);
		}
		this.#inProcessTail = undefined;
	}
}

/** Process items in batches; awaits each batch in parallel. */
export async function processInBatches<T, R>(
	items: readonly T[],
	batchSize: number,
	processor: (item: T, index: number) => Promise<R>,
	onBatchComplete?: (completed: number, total: number) => void,
): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += batchSize) {
		const slice = items.slice(i, i + batchSize);
		const results = await Promise.all(slice.map((item, j) => processor(item, i + j)));
		out.push(...results);
		onBatchComplete?.(out.length, items.length);
	}
	return out;
}

/** Detect language from a source path's extension. Cheap heuristic. */
const EXTENSION_LANG: ReadonlyMap<string, string> = new Map([
	[".ts", "typescript"],
	[".tsx", "tsx"],
	[".js", "javascript"],
	[".jsx", "jsx"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".go", "go"],
	[".rs", "rust"],
	[".java", "java"],
	[".kt", "kotlin"],
	[".swift", "swift"],
	[".cs", "csharp"],
	[".cpp", "cpp"],
	[".cc", "cpp"],
	[".cxx", "cpp"],
	[".c", "c"],
	[".h", "c"],
	[".hpp", "cpp"],
	[".rb", "ruby"],
	[".php", "php"],
	[".lua", "lua"],
	[".dart", "dart"],
	[".scala", "scala"],
	[".pas", "pascal"],
	[".pp", "pascal"],
	[".vue", "vue"],
	[".svelte", "svelte"],
	[".astro", "astro"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".html", "xml"],
	[".xml", "xml"],
	[".sol", "solidity"],
	[".nix", "nix"],
	[".r", "r"],
	[".tf", "terraform"],
	[".hcl", "terraform"],
	[".md", "yaml"], // config-leaf only
]);

export function detectLanguageFromPath(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const lang = EXTENSION_LANG.get(ext);
	return lang ?? "unknown";
}

// ------------------------------------------------------------------
// Tiny lock-file helpers — keep the adapter platform-agnostic without
// dragging in the upstream `proper-lockfile` dependency.
// ------------------------------------------------------------------

function lockContent(): string {
	return JSON.stringify({ pid: process.pid, at: Date.now() });
}

function parseLockContent(content: string): { pid: number; at: number } | null {
	try {
		const parsed = JSON.parse(content) as { pid?: unknown; at?: unknown };
		if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return null;
		return { pid: parsed.pid, at: parsed.at };
	} catch {
		return null;
	}
}

function isPidAlive(pid: number): boolean {
	if (process.platform === "win32") return true; // best-effort
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

function readIfPresent(file: string): string | null {
	try {
		// Bun-friendly synchronous read; `readFileSync` is acceptable
		// here because lock acquisition is itself a single blocking
		// operation in the upstream code path.
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

// ------------------------------------------------------------------
// File-reading helpers used by the runtime.
// ------------------------------------------------------------------

/** Async wrapper kept for parity with upstream APIs. */
export async function readSourceFile(filePath: string): Promise<string> {
	return fs.promises.readFile(filePath, "utf8");
}

/** Async stat helper used by sync paths. */
export async function statFile(filePath: string): Promise<{ size: number; mtimeMs: number }> {
	const st = await fs.promises.stat(filePath);
	return { size: st.size, mtimeMs: st.mtimeMs };
}

/** Best-effort mkdir with parents. */
export async function ensureDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
}
