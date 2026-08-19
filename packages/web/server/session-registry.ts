import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	listAllSessions,
	listSessionsFromDirs,
	type SessionInfo,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	computeCompatibleSessionDirs,
	resolveManagedSessionRoot,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { OmpBranchResultView } from "../shared/omp-view-model";
import type { WebSessionRecord } from "./domain";
import { RpcWebSession } from "./rpc-session";
import type { DurableStore } from "./store";

export interface SessionRegistryOptions {
	rootDirectory: string;
	cliPath?: string;
	command?: string[];
	sessionDir?: string;
	idleTtlMs?: number;
	maxActiveSessions?: number;
}

interface ActiveSession {
	promise: Promise<RpcWebSession>;
	lastAccessAt: number;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 8;

export class SessionRegistry {
	readonly store: DurableStore;
	readonly #options: SessionRegistryOptions;
	readonly #sessions = new Map<string, ActiveSession>();
	readonly #idleTtlMs: number;
	readonly #maxActiveSessions: number;
	#sweepTimer?: NodeJS.Timeout;
	#pruneChain = Promise.resolve();

	constructor(store: DurableStore, options: SessionRegistryOptions) {
		this.store = store;
		this.#options = options;
		this.#idleTtlMs = Math.max(1, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
		this.#maxActiveSessions = Math.max(1, options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS);
		this.#sweepTimer = setInterval(() => this.#queuePrune(), Math.min(this.#idleTtlMs, 60_000));
		this.#sweepTimer.unref();
	}

	project(directory = this.#options.rootDirectory) {
		const resolved = path.resolve(directory);
		return {
			id: `project_${Buffer.from(resolved).toString("base64url")}`,
			worktree: resolved,
			vcsDir: resolved,
			vcs: "git" as const,
			time: { created: 0, initialized: 0 },
		};
	}

	async projects() {
		await this.#syncCanonicalSessions();
		const directories = new Set([path.resolve(this.#options.rootDirectory)]);
		for (const session of this.store.listSessions()) {
			if (session.directory) directories.add(path.resolve(session.directory));
		}
		const existing = await Promise.all(
			[...directories].map(directory => this.validateDirectory(directory).catch(() => undefined)),
		);
		return existing
			.filter((directory): directory is string => directory !== undefined)
			.map(directory => this.project(directory));
	}

	async validateDirectory(directory?: string): Promise<string> {
		const resolved = path.resolve(directory ?? this.#options.rootDirectory);
		const stat = await fs.stat(resolved);
		if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
		return resolved;
	}

	async create(input: { directory?: string; title?: string; parentID?: string } = {}): Promise<RpcWebSession> {
		let parentSessionPath: string | undefined;
		if (input.parentID !== undefined) {
			const parent = this.store.getSession(input.parentID);
			if (!parent) throw new Error(`Parent session not found: ${input.parentID}`);
			if (!parent.sessionPath) throw new Error(`Parent session has no path: ${input.parentID}`);
			parentSessionPath = parent.sessionPath;
		}
		const directory = await this.validateDirectory(input.directory);
		const project = this.project(directory);
		const session = await RpcWebSession.start(this.store, {
			directory,
			projectID: project.id,
			title: input.title,
			parentID: input.parentID,
			parentSessionPath,
			cliPath: this.#options.cliPath,
			command: this.#options.command,
			sessionDir: this.#options.sessionDir,
		});
		this.#sessions.set(session.id, { promise: Promise.resolve(session), lastAccessAt: Date.now() });
		this.#queuePrune();
		return session;
	}

	getRecord(id: string): WebSessionRecord | undefined {
		return this.store.getSession(id);
	}

	async activate(id: string): Promise<RpcWebSession | undefined> {
		const active = this.#sessions.get(id);
		if (active) {
			active.lastAccessAt = Date.now();
			return active.promise;
		}
		const record = this.store.getSession(id);
		if (!record?.sessionPath) return undefined;
		const entry: ActiveSession = {
			promise: RpcWebSession.start(this.store, {
				directory: record.directory,
				projectID: record.projectID,
				title: record.title,
				parentID: record.parentID,
				sessionPath: record.sessionPath,
				cliPath: this.#options.cliPath,
				command: this.#options.command,
				sessionDir: this.#options.sessionDir,
			}),
			lastAccessAt: Date.now(),
		};
		this.#sessions.set(id, entry);
		try {
			const session = await entry.promise;
			if (session.id !== id) {
				this.#sessions.delete(id);
				this.#sessions.set(session.id, entry);
				this.store.deleteSession(id);
			}
			this.#queuePrune();
			return session;
		} catch (error) {
			if (this.#sessions.get(id) === entry) this.#sessions.delete(id);
			throw error;
		}
	}

	async rename(id: string, title: string): Promise<WebSessionRecord | undefined> {
		const session = await this.activate(id);
		if (!session) return undefined;
		await session.rename(title);
		return this.store.getSession(session.id);
	}

	async list(directory?: string): Promise<WebSessionRecord[]> {
		const resolved = directory ? path.resolve(directory) : undefined;
		await this.#syncCanonicalSessions(resolved);
		return this.store.listSessions(resolved);
	}

	async #listCanonicalSessions(directory?: string): Promise<SessionInfo[]> {
		const storage = new FileSessionStorage();
		const configured = this.#options.sessionDir;
		const managedRoot = configured ? resolveManagedSessionRoot(configured, this.#options.rootDirectory) : undefined;
		if (!directory) {
			if (configured && !managedRoot) return listSessionsFromDirs([configured], storage);
			return listAllSessions(storage, managedRoot);
		}
		const sessionDirs =
			configured && !managedRoot ? [configured] : computeCompatibleSessionDirs(directory, storage, managedRoot);
		return listSessionsFromDirs(sessionDirs, storage);
	}

	async #syncCanonicalSessions(directory?: string): Promise<void> {
		const sessions = await this.#listCanonicalSessions(directory);
		const idsByPath = new Map(sessions.map(session => [path.resolve(session.path), session.id]));
		for (const session of sessions) {
			const current = this.store.getSession(session.id);
			const sessionDirectory = session.cwd
				? path.resolve(session.cwd)
				: path.resolve(directory ?? this.#options.rootDirectory);
			this.store.upsertSession({
				id: session.id,
				projectID: this.project(sessionDirectory).id,
				directory: sessionDirectory,
				sessionPath: session.path,
				parentID: session.parentSessionPath
					? idsByPath.get(path.resolve(session.parentSessionPath))
					: current?.parentID,
				title: session.title || current?.title || session.firstMessage || "New session",
				model: current?.model,
				provider: current?.provider,
				createdAt: current?.createdAt ?? session.created.getTime(),
				updatedAt: Math.max(current?.updatedAt ?? 0, session.modified.getTime()),
			});
		}
	}

	async status(id: string): Promise<{ type: "busy" | "idle" } | undefined> {
		const active = this.#sessions.get(id);
		if (!active) return undefined;
		const session = await active.promise;
		const state = await session.client.getState();
		return { type: state.isStreaming ? "busy" : "idle" };
	}

	async statuses(directory?: string): Promise<Record<string, { type: "busy" | "idle" }>> {
		const resolved = directory ? path.resolve(directory) : undefined;
		const statuses = await Promise.all(
			[...this.#sessions.entries()].map(async ([id, active]) => {
				try {
					const session = await active.promise;
					if (resolved && session.directory !== resolved) return undefined;
					const state = await session.client.getState();
					return [session.id, { type: state.isStreaming ? "busy" : "idle" }] as const;
				} catch {
					if (this.#sessions.get(id) === active) this.#sessions.delete(id);
					return undefined;
				}
			}),
		);
		return Object.fromEntries(statuses.filter(item => item !== undefined));
	}

	async ensureDefault(directory?: string): Promise<RpcWebSession> {
		const resolved = await this.validateDirectory(directory);
		const existing = (await this.list(resolved))[0];
		if (existing) {
			const session = await this.activate(existing.id);
			if (session) return session;
		}
		return this.create({ directory: resolved });
	}

	async models(directory?: string): Promise<ModelInfo[]> {
		const session = await this.ensureDefault(directory);
		return session.client.getAvailableModels();
	}

	async commands(directory?: string) {
		const session = await this.ensureDefault(directory);
		return session.client.getAvailableCommands();
	}

	async loginProviders(directory?: string) {
		const session = await this.ensureDefault(directory);
		return session.client.getLoginProviders();
	}

	async branch(id: string, entryId: string): Promise<OmpBranchResultView | undefined> {
		const session = await this.activate(id);
		if (!session) return undefined;
		const active = this.#sessions.get(id);
		if (!active) throw new Error(`Active session disappeared: ${id}`);
		const result = await session.branch(entryId, (previous, next) => {
			const current = this.#sessions.get(previous.id);
			if (current !== active) throw new Error(`Active session changed while branching: ${previous.id}`);
			const collision = this.#sessions.get(next.id);
			if (collision && collision !== active) throw new Error(`Branch session is already active: ${next.id}`);
			this.store.upsertSession(next);
			this.store.deleteSession(previous.id);
			this.#sessions.delete(previous.id);
			this.#sessions.set(next.id, active);
		});
		this.#queuePrune();
		return result;
	}

	async remove(id: string): Promise<boolean> {
		const record = this.store.getSession(id);
		const active = this.#sessions.get(id);
		if (active) {
			const session = await active.promise;
			await session.close();
			this.#sessions.delete(id);
		}
		if (record?.sessionPath) await new FileSessionStorage().deleteSessionWithArtifacts(record.sessionPath);
		const deleted = this.store.deleteSession(id);
		if (deleted && record) {
			this.store.appendEvent(record.directory, { type: "session.deleted", properties: { sessionID: id } }, id);
		}
		return deleted;
	}

	async close(): Promise<void> {
		if (this.#sweepTimer) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = undefined;
		}
		await this.#pruneChain.catch(() => {});
		const sessions = await Promise.allSettled([...this.#sessions.values()].map(active => active.promise));
		await Promise.all(sessions.flatMap(result => (result.status === "fulfilled" ? [result.value.close()] : [])));
	}
	#queuePrune(): void {
		this.#pruneChain = this.#pruneChain
			.then(
				() => this.#pruneIdle(),
				() => this.#pruneIdle(),
			)
			.catch(() => {});
	}

	async #pruneIdle(): Promise<void> {
		const now = Date.now();
		const entries = [...this.#sessions.entries()].sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);
		for (const [id, active] of entries) {
			const observedAccess = active.lastAccessAt;
			const expired = now - observedAccess >= this.#idleTtlMs;
			const overCapacity = this.#sessions.size > this.#maxActiveSessions;
			if (!expired && !overCapacity) continue;
			let session: RpcWebSession;
			try {
				session = await active.promise;
				const state = await session.client.getState();
				if (state.isStreaming) continue;
			} catch {
				continue;
			}
			if (this.#sessions.get(id) !== active || active.lastAccessAt !== observedAccess) continue;
			await session.close();
			this.#sessions.delete(id);
		}
	}
}
