import * as fs from "node:fs";
import * as path from "node:path";
import { FileFinder, type FileFinderApi, type InitOptions, type Result } from "@ff-labs/fff-bun";
import { logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export const FFF_SCAN_TIMEOUT_MS = 15_000;
export const FFF_MAX_AUX_FINDERS = 3;
const FFF_AUX_IDLE_TTL_MS = 5 * 60 * 1000;

export interface FffFinderStatic {
	create(options: InitOptions): Result<FileFinderApi>;
}

export interface FffFinderManagerOptions {
	finderStatic?: FffFinderStatic;
	frecencyDbPath?: string;
	historyDbPath?: string;
	enableFsRootScanning?: boolean;
	enableHomeDirScanning?: boolean;
}

interface FinderEntry {
	root: string;
	finder: FileFinderApi;
	lastUsed: number;
}

/** Workspace index shared by grep/find/multi_grep callers holding a manager lease. */
export class FffFinderManager {
	readonly #finderStatic: FffFinderStatic;
	readonly #frecencyDbPath: string | undefined;
	readonly #historyDbPath: string | undefined;
	readonly #enableFsRootScanning: boolean;
	readonly #enableHomeDirScanning: boolean;
	#main: FinderEntry | undefined;
	#mainPending: { root: string; promise: Promise<FinderEntry> } | undefined;
	#aux: FinderEntry[] = [];
	#auxPending = new Map<string, Promise<FinderEntry>>();
	#disposed = false;

	constructor(options: FffFinderManagerOptions = {}) {
		this.#finderStatic = options.finderStatic ?? FileFinder;
		this.#frecencyDbPath = options.frecencyDbPath;
		this.#historyDbPath = options.historyDbPath;
		this.#enableFsRootScanning = options.enableFsRootScanning ?? false;
		this.#enableHomeDirScanning = options.enableHomeDirScanning ?? false;
	}

	async acquireWorkspace(root: string): Promise<{ finder: FileFinderApi; root: string }> {
		this.#assertAlive();
		const normalizedRoot = path.resolve(root);
		if (this.#main && !this.#main.finder.isDestroyed && this.#main.root === normalizedRoot) {
			this.#main.lastUsed = Date.now();
			return this.#main;
		}
		if (this.#mainPending) {
			if (this.#mainPending.root === normalizedRoot) return this.#mainPending.promise;
			await this.#mainPending.promise;
			return this.acquireWorkspace(normalizedRoot);
		}

		const promise = this.#create(normalizedRoot, true).finally(() => {
			this.#mainPending = undefined;
		});
		this.#mainPending = { root: normalizedRoot, promise };
		return promise;
	}

	async acquireAux(root: string): Promise<{ finder: FileFinderApi; root: string }> {
		this.#assertAlive();
		this.#sweepIdle();
		const normalizedRoot = path.resolve(root);
		const covering = this.#aux
			.filter(entry => !entry.finder.isDestroyed && rootCovers(entry.root, normalizedRoot))
			.sort((left, right) => right.root.length - left.root.length)[0];
		if (covering) {
			covering.lastUsed = Date.now();
			return covering;
		}

		const pending = this.#auxPending.get(normalizedRoot);
		if (pending) return pending;

		const creation = this.#create(normalizedRoot, false).finally(() => {
			this.#auxPending.delete(normalizedRoot);
		});
		this.#auxPending.set(normalizedRoot, creation);
		return creation;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#destroy(this.#main);
		for (const entry of this.#aux) this.#destroy(entry);
		this.#main = undefined;
		this.#aux = [];
		this.#mainPending = undefined;
		this.#auxPending.clear();
	}

	get auxSize(): number {
		this.#sweepIdle();
		return this.#aux.length;
	}

	async #create(root: string, main: boolean): Promise<FinderEntry> {
		if (main) {
			this.#destroy(this.#main);
			this.#main = undefined;
		} else if (this.#aux.length >= FFF_MAX_AUX_FINDERS) {
			const oldest = this.#aux.reduce((current, entry) => (entry.lastUsed < current.lastUsed ? entry : current));
			this.#destroy(oldest);
			this.#aux = this.#aux.filter(entry => entry !== oldest);
		}

		const createOptions: InitOptions = {
			basePath: root,
			...(main && this.#frecencyDbPath ? { frecencyDbPath: this.#frecencyDbPath } : {}),
			...(main && this.#historyDbPath ? { historyDbPath: this.#historyDbPath } : {}),
			aiMode: true,
			enableFsRootScanning: this.#enableFsRootScanning,
			enableHomeDirScanning: this.#enableHomeDirScanning,
		};
		let created = this.#finderStatic.create(createOptions);
		if (
			!created.ok &&
			main &&
			(this.#frecencyDbPath || this.#historyDbPath) &&
			created.error.includes("MDB_READERS_FULL")
		) {
			logger.warn("FFF durable ranking databases unavailable; retrying without them", {
				root,
				error: created.error,
			});
			created = this.#finderStatic.create({
				basePath: root,
				aiMode: true,
				enableFsRootScanning: this.#enableFsRootScanning,
				enableHomeDirScanning: this.#enableHomeDirScanning,
			});
		}
		if (!created.ok) throw new Error(`Failed to create FFF index for ${root}: ${created.error}`);
		const finder = created.value;
		const ready = await finder.waitForScan(FFF_SCAN_TIMEOUT_MS);
		if (!ready.ok) {
			finder.destroy();
			throw new Error(`Failed to scan FFF index for ${root}: ${ready.error}`);
		}
		if (!ready.value) {
			logger.warn("FFF initial scan did not finish before timeout", { root, timeoutMs: FFF_SCAN_TIMEOUT_MS });
		}
		if (this.#disposed) {
			finder.destroy();
			throw new Error("FFF finder manager disposed during initialization");
		}
		const entry = { root, finder, lastUsed: Date.now() };
		if (main) {
			this.#main = entry;
		} else {
			this.#aux.push(entry);
			while (this.#aux.length > FFF_MAX_AUX_FINDERS) {
				const oldest = this.#aux.reduce((current, candidate) =>
					candidate.lastUsed < current.lastUsed ? candidate : current,
				);
				this.#destroy(oldest);
				this.#aux = this.#aux.filter(candidate => candidate !== oldest);
			}
		}
		return entry;
	}

	#sweepIdle(now = Date.now()): void {
		const kept: FinderEntry[] = [];
		for (const entry of this.#aux) {
			if (entry.finder.isDestroyed || now - entry.lastUsed > FFF_AUX_IDLE_TTL_MS) this.#destroy(entry);
			else kept.push(entry);
		}
		this.#aux = kept;
	}

	#destroy(entry: FinderEntry | undefined): void {
		if (entry && !entry.finder.isDestroyed) entry.finder.destroy();
	}

	#assertAlive(): void {
		if (this.#disposed) throw new Error("FFF finder manager has been disposed");
	}
}

export interface ResolvedFffScope {
	finder: FileFinderApi;
	root: string;
	pathConstraint?: string;
	displayPath: string;
	kind: "workspace" | "aux";
}

export type FffScopeIdentity = Omit<ResolvedFffScope, "finder">;

/** Route workspace-relative constraints to the main index and external paths to a bounded aux index. */
export async function resolveFffScope(
	manager: FffFinderManager,
	cwd: string,
	pathConstraint: string | undefined,
): Promise<ResolvedFffScope> {
	const routed = routeFffPathConstraint(pathConstraint, cwd);
	if (!routed) {
		const workspace = await manager.acquireWorkspace(cwd);
		return {
			...workspace,
			pathConstraint,
			displayPath: pathConstraint ?? ".",
			kind: "workspace",
		};
	}
	const aux = await manager.acquireAux(routed.root);
	const rebase = path.relative(aux.root, routed.root).replaceAll(path.sep, "/");
	const suffix = [rebase, routed.suffix].filter(Boolean).join("/");
	return { ...aux, pathConstraint: suffix || undefined, displayPath: pathConstraint ?? routed.root, kind: "aux" };
}

/** Restore the same logical index/scope bound to a pagination cursor. */
export async function resumeFffScope(manager: FffFinderManager, identity: FffScopeIdentity): Promise<ResolvedFffScope> {
	if (identity.kind === "workspace") {
		const workspace = await manager.acquireWorkspace(identity.root);
		return { ...identity, ...workspace };
	}
	const aux = await manager.acquireAux(identity.root);
	const rebase = path.relative(aux.root, identity.root).replaceAll(path.sep, "/");
	const pathConstraint = [rebase, identity.pathConstraint].filter(Boolean).join("/") || undefined;
	return { ...identity, ...aux, pathConstraint };
}

export function routeFffPathConstraint(
	pathConstraint: string | undefined,
	cwd: string,
): { root: string; suffix: string } | null {
	if (!pathConstraint) return null;
	let candidate = pathConstraint.trim();
	if (!candidate) return null;
	if (candidate === "~" || candidate.startsWith("~/"))
		candidate = path.join(process.env.HOME ?? "~", candidate.slice(1));
	if (/\s/.test(candidate)) {
		const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
		return resolveAuxRoot(absolute);
	}
	if (!path.isAbsolute(candidate)) {
		if (candidate !== ".." && !candidate.startsWith(`..${path.sep}`) && !candidate.startsWith("../")) return null;
		candidate = path.resolve(cwd, candidate);
	}
	const relative = path.relative(cwd, candidate);
	if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return null;
	return resolveAuxRoot(candidate);
}

export function resolveAuxRoot(value: string): { root: string; suffix: string } | null {
	const normalized = path.normalize(value.trim());
	if (!path.isAbsolute(normalized)) return null;
	const segments = normalized.split(path.sep);
	const globIndex = segments.findIndex(segment => /[*?[{]/.test(segment));
	const boundary = globIndex === -1 ? segments.length : globIndex;
	for (let index = boundary; index > 0; index--) {
		const candidate = segments.slice(0, index).join(path.sep) || path.sep;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(candidate);
		} catch {
			continue;
		}
		if (stat.isFile()) {
			return {
				root: segments.slice(0, index - 1).join(path.sep) || path.sep,
				suffix: segments.slice(index - 1).join("/"),
			};
		}
		return { root: candidate, suffix: segments.slice(index).join("/") };
	}
	return null;
}

function rootCovers(root: string, target: string): boolean {
	if (root === target) return true;
	return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

interface FffManagerLease {
	manager: FffFinderManager;
	sharedKey?: string;
}

interface SharedFffManager {
	manager: FffFinderManager;
	references: number;
}

const sessionManagers = new WeakMap<object, FffManagerLease>();
const sharedManagers = new Map<string, SharedFffManager>();

function canonicalFffRoot(value: string): string {
	return resolveEquivalentPath(path.resolve(value));
}

function fffWorkspaceId(root: string): string {
	return Bun.SHA256.hash(root.replaceAll("\\", "/"), "hex");
}

/** Return the durable FFF data directory isolated to one canonical workspace. */
export function getFffWorkspaceDataDir(agentDir: string, cwd: string): string {
	return path.join(canonicalFffRoot(agentDir), "fff", fffWorkspaceId(canonicalFffRoot(cwd)));
}

/** Create a standalone manager with the same durable workspace stores as session-backed search tools. */
export function createFffFinderManager(
	agentDir: string,
	cwd: string,
	options: FffFinderManagerOptions = {},
): FffFinderManager {
	const dataDir = getFffWorkspaceDataDir(agentDir, cwd);
	return new FffFinderManager({
		frecencyDbPath: path.join(dataDir, "frecency"),
		historyDbPath: path.join(dataDir, "queries"),
		...options,
	});
}

function releaseSessionManager(session: ToolSession): void {
	const lease = sessionManagers.get(session);
	if (!lease) return;
	sessionManagers.delete(session);
	if (!lease.sharedKey) {
		lease.manager.dispose();
		return;
	}
	const shared = sharedManagers.get(lease.sharedKey);
	if (!shared || shared.manager !== lease.manager) return;
	shared.references--;
	if (shared.references > 0) return;
	sharedManagers.delete(lease.sharedKey);
	shared.manager.dispose();
}

/** Return the workspace-shared manager leased by one ToolSession. */
export function getSessionFffFinderManager(session: ToolSession): FffFinderManager {
	const existing = sessionManagers.get(session);
	if (existing) return existing.manager;
	const agentDir = canonicalFffRoot(session.settings.getAgentDir());
	const workspaceRoot = canonicalFffRoot(session.cwd);
	const sharedKey = `${agentDir}\0${workspaceRoot}`;
	let shared = sharedManagers.get(sharedKey);
	if (!shared) {
		shared = {
			manager: createFffFinderManager(agentDir, workspaceRoot),
			references: 0,
		};
		sharedManagers.set(sharedKey, shared);
	}
	shared.references++;
	sessionManagers.set(session, { manager: shared.manager, sharedKey });
	session.registerDisposeCallback?.(() => releaseSessionManager(session));
	return shared.manager;
}

/** Test/embedding seam for supplying a deterministic SDK implementation. */
export function setSessionFffFinderManager(session: ToolSession, manager: FffFinderManager): void {
	releaseSessionManager(session);
	sessionManagers.set(session, { manager });
}

/** Release this session's manager lease and destroy the index after the final owner exits. */
export function disposeSessionFffFinderManager(session: ToolSession): void {
	releaseSessionManager(session);
}
