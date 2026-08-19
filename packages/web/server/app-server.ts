import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	RpcMcpServerConfigInput,
	RpcPluginSelector,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-management-types";
import type {
	RpcSettingPath,
	RpcSettingsLocale,
	RpcSettingValue,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { VERSION, withFileLock } from "@oh-my-pi/pi-utils";
import type { Server } from "bun";
import { parsePatch } from "diff";
import {
	OMP_APPROVAL_MODES,
	OMP_THINKING_LEVELS,
	type OmpApprovalMode,
	type OmpThinkingLevel,
} from "../shared/omp-view-model";
import { OMP_WEB_CAPABILITIES, OMP_WEB_PRODUCT, OMP_WEB_PROTOCOL } from "../shared/omp-web-contract";
import type { WebSessionRecord } from "./domain";
import { ProjectFileService } from "./file-service";
import { ModelService } from "./model-service";
import { PtyService } from "./pty-service";
import type { PromptIdentity } from "./rpc-session";
import { SessionRegistry } from "./session-registry";
import { DurableStore } from "./store";

interface SocketData {
	ptyID: string;
}

export interface WebServerOptions {
	hostname: string;
	port: number;
	rootDirectory: string;
	staticDirectory: string;
	databaseFile: string;
	username?: string;
	password?: string;
	cliPath?: string;
	command?: string[];
	sessionDir?: string;
}

type JsonRecord = Record<string, unknown>;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(value, { status, headers });
}

function errorResponse(error: unknown, status = 500): Response {
	const message = error instanceof Error ? error.message : String(error);
	return json({ name: status === 404 ? "NotFoundError" : "UnknownError", data: { message } }, status);
}

function ompOperationError(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = /(?:not found|does not exist)/i.test(message)
		? 404
		: /(?:conflict|changed since preview|mutator|in progress|streaming|workspace lock)/i.test(message)
			? 409
			: 500;
	return errorResponse(message, status);
}

function rpcSettingsLocale(value: string | null): RpcSettingsLocale | undefined {
	return value === "en" || value === "zh-CN" ? value : undefined;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

async function body(request: Request): Promise<JsonRecord> {
	if (!request.body) return {};
	return record(await request.json());
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
	return Object.fromEntries(entries) as Record<string, string>;
}

function unsupportedFields(input: JsonRecord, allowed: readonly string[]): string[] {
	return Object.keys(input).filter(key => !allowed.includes(key));
}

function mcpConfigInput(value: unknown): RpcMcpServerConfigInput | undefined {
	const input = record(value);
	if (input.type === "stdio" && typeof input.command === "string" && input.command.trim()) {
		if (
			input.args !== undefined &&
			(!Array.isArray(input.args) || !input.args.every(item => typeof item === "string"))
		) {
			return undefined;
		}
		const env = stringRecord(input.env);
		if (input.env !== undefined && !env) return undefined;
		return {
			type: "stdio",
			command: input.command.trim(),
			args: Array.isArray(input.args) ? input.args.map(item => String(item)) : undefined,
			env,
		};
	}
	if ((input.type === "http" || input.type === "sse") && typeof input.url === "string" && input.url.trim()) {
		const headers = stringRecord(input.headers);
		if (input.headers !== undefined && !headers) return undefined;
		return { type: input.type, url: input.url.trim(), headers };
	}
	return undefined;
}

function pluginSelector(value: unknown): RpcPluginSelector | undefined {
	const input = record(value);
	if (typeof input.id !== "string" || (input.kind !== "npm" && input.kind !== "marketplace")) return undefined;
	if (input.scope !== "global" && input.scope !== "user" && input.scope !== "project") return undefined;
	return { id: input.id, kind: input.kind, scope: input.scope };
}

function match(pathname: string, pattern: RegExp): RegExpExecArray | undefined {
	return pattern.exec(pathname) ?? undefined;
}

function promptParts(input: JsonRecord): { text: string; images: ImageContent[]; identity?: PromptIdentity } {
	const parts = Array.isArray(input.parts) ? input.parts : [];
	const text: string[] = [];
	const images: ImageContent[] = [];
	let textPartID: string | undefined;
	const imagePartIDs: string[] = [];
	for (const item of parts) {
		const part = record(item);
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
			if (!textPartID && typeof part.id === "string") textPartID = part.id;
		}
		if (part.type !== "file" || typeof part.url !== "string") continue;
		const data = /^data:([^;]+);base64,(.+)$/s.exec(part.url);
		if (!data?.[1] || !data[2]) continue;
		images.push({ type: "image", mimeType: data[1], data: data[2] });
		if (typeof part.id === "string") imagePartIDs.push(part.id);
	}
	const messageID =
		typeof input.messageID === "string" ? input.messageID : typeof input.id === "string" ? input.id : undefined;
	return {
		text: text.join("\n"),
		images,
		identity: messageID ? { messageID, textPartID, imagePartIDs } : undefined,
	};
}

function modelSelection(value: unknown): { provider: string; modelID: string } | undefined {
	if (typeof value === "string") {
		const separator = value.indexOf("/");
		const provider = value.slice(0, separator).trim();
		const modelID = value.slice(separator + 1).trim();
		return separator > 0 && provider && modelID ? { provider, modelID } : undefined;
	}
	const input = record(value);
	const provider =
		typeof input.providerID === "string"
			? input.providerID.trim()
			: typeof input.provider === "string"
				? input.provider.trim()
				: "";
	const modelID =
		typeof input.modelID === "string" ? input.modelID.trim() : typeof input.id === "string" ? input.id.trim() : "";
	return provider && modelID ? { provider, modelID } : undefined;
}

function noContent(): Response {
	return new Response(null, { status: 204 });
}

function unsupportedRoute(request: Request): Response {
	return errorResponse(`Unsupported OMP Web API route: ${request.method} ${new URL(request.url).pathname}`, 501);
}

function isApiLike(pathname: string): boolean {
	return /^\/(?:api|global|path|project|vcs|experimental|config|provider|agent|command|mcp|lsp|session|question|permission|file|find|pty|event|tool|instance|auth|app|formatter|tui|workspace|model|integration|reference|health)(?:\/|$)/.test(
		pathname,
	);
}

interface WebServerStateLease {
	release(): Promise<void>;
}

async function acquireWebServerStateLease(databaseFile: string): Promise<WebServerStateLease> {
	await fs.mkdir(path.dirname(databaseFile), { recursive: true });
	const acquired = Promise.withResolvers<void>();
	const releaseSignal = Promise.withResolvers<void>();
	const holding = withFileLock(
		`${databaseFile}.server-owner`,
		async () => {
			acquired.resolve();
			await releaseSignal.promise;
		},
		{ retries: 1 },
	);
	void holding.catch(error => acquired.reject(error));
	try {
		await acquired.promise;
	} catch (error) {
		throw new Error(
			`OMP Web state is already owned by another server: ${databaseFile}. Stop it or use a different --db.`,
			{ cause: error },
		);
	}
	let released = false;
	return {
		async release() {
			if (released) return;
			released = true;
			releaseSignal.resolve();
			await holding;
		},
	};
}

export class OmpWebServer {
	readonly options: WebServerOptions;
	readonly store: DurableStore;
	readonly sessions: SessionRegistry;
	readonly files: ProjectFileService;
	readonly models: ModelService;
	readonly ptys: PtyService;
	#server?: Server<SocketData>;
	readonly #stateLease: WebServerStateLease;
	#stopped = false;

	static async create(options: WebServerOptions): Promise<OmpWebServer> {
		const stateLease = await acquireWebServerStateLease(options.databaseFile);
		try {
			const store = await DurableStore.open(options.databaseFile);
			return new OmpWebServer(options, store, stateLease);
		} catch (error) {
			await stateLease.release();
			throw error;
		}
	}

	private constructor(options: WebServerOptions, store: DurableStore, stateLease: WebServerStateLease) {
		this.options = options;
		this.store = store;
		this.#stateLease = stateLease;
		this.sessions = new SessionRegistry(store, {
			rootDirectory: options.rootDirectory,
			cliPath: options.cliPath,
			command: options.command,
			sessionDir: options.sessionDir,
		});
		this.files = new ProjectFileService(options.rootDirectory);
		this.models = new ModelService(this.sessions);
		this.ptys = new PtyService(store);
	}

	start(): Server<SocketData> {
		if (this.#stopped) throw new Error("OMP Web server has been stopped");
		if (this.#server) throw new Error("OMP Web server already started");
		this.#server = Bun.serve<SocketData>({
			hostname: this.options.hostname,
			port: this.options.port,
			idleTimeout: 30,
			fetch: (request, server) => this.#fetch(request, server),
			websocket: {
				open: socket => {
					if (!this.ptys.attach(socket)) socket.close(1008, "Unknown PTY");
				},
				message: (socket, message) => {
					const data = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
					this.ptys.write(socket.data.ptyID, data);
				},
				close: socket => this.ptys.detach(socket),
			},
		});
		return this.#server;
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		try {
			this.#server?.stop(true);
			this.#server = undefined;
			this.ptys.close();
			this.files.dispose();
			await this.sessions.close();
		} finally {
			await this.#stateLease.release();
		}
	}

	async #fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") return this.#cors(new Response(null, { status: 204 }));
		if (this.#requiresAuth(url.pathname) && !this.#authorized(request)) {
			return this.#cors(
				new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="OMP"' } }),
			);
		}
		try {
			const response = await this.#route(request, url, server);
			return response ? this.#cors(response) : undefined;
		} catch (error) {
			return this.#cors(errorResponse(error));
		}
	}

	async #route(request: Request, url: URL, server: Server<SocketData>): Promise<Response | undefined> {
		const rawPathname = url.pathname;
		const isOmpApi = rawPathname.startsWith("/api/omp/");
		const pathname = isOmpApi ? rawPathname.slice("/api/omp".length).replace(/\/$/, "") || "/" : rawPathname;
		const directory = url.searchParams.get("directory") ?? this.options.rootDirectory;

		if (rawPathname === "/api/health" && request.method === "GET") {
			return json({
				healthy: true,
				product: OMP_WEB_PRODUCT,
				pid: process.pid,
				version: VERSION,
				protocol: OMP_WEB_PROTOCOL,
				capabilities: OMP_WEB_CAPABILITIES,
			});
		}
		if (!isOmpApi) {
			if (isApiLike(rawPathname) || request.method !== "GET") return unsupportedRoute(request);
			return this.#static(
				rawPathname,
				rawPathname === "/" ||
					(path.extname(rawPathname) === "" && request.headers.get("accept")?.includes("text/html") === true),
			);
		}
		if (pathname === "/global/event" && request.method === "GET") return this.#events(request);

		if (pathname === "/path" && request.method === "GET") {
			return json({
				state: path.join(os.homedir(), ".omp"),
				config: path.join(os.homedir(), ".omp", "agent"),
				worktree: this.options.rootDirectory,
				directory,
				home: os.homedir(),
			});
		}
		if (pathname === "/experimental/session") {
			if (request.method !== "GET") return unsupportedRoute(request);
			return this.#sessionList(url);
		}
		if (pathname === "/experimental/resource" && request.method === "GET") return json({});
		if (pathname === "/global/dispose" || pathname === "/experimental/resource") {
			return unsupportedRoute(request);
		}
		if (pathname === "/global/config" && request.method !== "GET") return unsupportedRoute(request);
		if (pathname === "/reference") {
			return request.method === "GET" ? json({ data: [] }) : unsupportedRoute(request);
		}

		if (pathname === "/project" && request.method === "GET") {
			return json(await this.sessions.projects());
		}
		if (pathname === "/project/current" && request.method === "GET") {
			return json(this.sessions.project(directory));
		}
		if (pathname === "/vcs" && request.method === "GET") {
			return json({ branch: (await git.branch.current(directory)) ?? "" });
		}

		if (
			(pathname === "/config" || pathname === "/global/config") &&
			(request.method === "GET" || request.method === "PATCH")
		) {
			const session = await this.sessions.ensureDefault(directory);
			const config = async () => {
				const state = await session.client.getState();
				return {
					model: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
					agent: "build",
					autoupdate: false,
				};
			};
			if (request.method === "GET") return json(await config());

			const input = await body(request);
			const unsupported = Object.keys(input).filter(key => key !== "model");
			if (unsupported.length > 0)
				return errorResponse(`Unsupported OMP configuration fields: ${unsupported.join(", ")}`, 501);
			const selected = modelSelection(input.model);
			if (!selected) return errorResponse("Config updates require a provider/model selector", 400);
			await session.setModel(selected.provider, selected.modelID);
			return json(await config());
		}
		if (pathname === "/admin/settings/catalog") {
			if (request.method !== "GET") return unsupportedRoute(request);
			const requestedLocale = url.searchParams.get("locale");
			const locale = rpcSettingsLocale(requestedLocale);
			if (requestedLocale !== null && !locale) {
				return errorResponse(`Unsupported OMP catalog locale: ${requestedLocale}`, 400);
			}
			const session = await this.sessions.ensureDefault(directory);
			return json(await session.client.getSettingsCatalog(locale));
		}
		if (pathname === "/admin/settings") {
			const session = await this.sessions.ensureDefault(directory);
			if (request.method === "GET") return json(await session.client.getSettings());
			if (request.method !== "PATCH") return unsupportedRoute(request);
			const input = await body(request);
			if (typeof input.path !== "string" || !("value" in input)) {
				return errorResponse("OMP settings updates require path and value", 400);
			}
			return json(await session.client.updateSetting(input.path as RpcSettingPath, input.value as RpcSettingValue));
		}
		if (pathname === "/admin/keybindings/catalog") {
			if (request.method !== "GET") return unsupportedRoute(request);
			const requestedLocale = url.searchParams.get("locale");
			const locale = rpcSettingsLocale(requestedLocale);
			if (requestedLocale !== null && !locale) {
				return errorResponse(`Unsupported OMP catalog locale: ${requestedLocale}`, 400);
			}
			const session = await this.sessions.ensureDefault(directory);
			return json(await session.client.getKeybindingsCatalog(locale));
		}
		if (pathname === "/admin/keybindings") {
			const session = await this.sessions.ensureDefault(directory);
			if (request.method === "GET") return json(await session.client.getKeybindings());
			if (request.method === "DELETE") return json(await session.client.resetKeybindings());
			if (request.method !== "PATCH") return unsupportedRoute(request);
			const input = await body(request);
			if (
				typeof input.keybinding !== "string" ||
				!Array.isArray(input.keys) ||
				!input.keys.every(key => typeof key === "string")
			) {
				return errorResponse("OMP keybinding updates require keybinding and string keys", 400);
			}
			return json(
				await session.client.updateKeybinding(
					input.keybinding,
					input.keys.map(key => String(key)),
				),
			);
		}
		if (pathname === "/admin/plugins") {
			const session = await this.sessions.ensureDefault(directory);
			if (request.method === "GET") return json(await session.client.getPlugins());
			if (request.method !== "PATCH") return unsupportedRoute(request);
			const input = await body(request);
			const plugin = pluginSelector(input.plugin);
			if (!plugin || typeof input.enabled !== "boolean") {
				return errorResponse("OMP plugin updates require a plugin selector and enabled state", 400);
			}
			return json(await session.client.setPluginEnabled(plugin, input.enabled));
		}
		if (pathname === "/admin/plugins/features") {
			if (request.method !== "PATCH") return unsupportedRoute(request);
			const input = await body(request);
			if (
				typeof input.name !== "string" ||
				!Array.isArray(input.features) ||
				!input.features.every(feature => typeof feature === "string")
			) {
				return errorResponse("OMP plugin feature updates require a plugin name and string feature list", 400);
			}
			const session = await this.sessions.ensureDefault(directory);
			return json(
				await session.client.setPluginFeatures(
					input.name,
					input.features.map(feature => String(feature)),
				),
			);
		}
		if (pathname === "/admin/plugins/settings") {
			if (request.method !== "PATCH") return unsupportedRoute(request);
			const input = await body(request);
			const value = input.value;
			if (
				typeof input.name !== "string" ||
				typeof input.key !== "string" ||
				value === null ||
				(typeof value !== "string" &&
					typeof value !== "boolean" &&
					(typeof value !== "number" || !Number.isFinite(value)))
			) {
				return errorResponse("OMP plugin setting updates require a scalar setting value", 400);
			}
			const session = await this.sessions.ensureDefault(directory);
			return json(await session.client.setPluginSetting(input.name, input.key, value));
		}
		if (pathname === "/admin/mcp") {
			const session = await this.sessions.ensureDefault(directory);
			if (request.method === "GET") return json(await session.client.getMcpServers());
			const input = await body(request);
			if (request.method === "PATCH") {
				if (typeof input.name !== "string" || typeof input.enabled !== "boolean") {
					return errorResponse("OMP MCP updates require a server name and enabled state", 400);
				}
				return json(await session.client.setMcpServerEnabled(input.name, input.enabled));
			}
			if (request.method === "POST") {
				const config = mcpConfigInput(input.config);
				if (typeof input.name !== "string" || (input.scope !== "user" && input.scope !== "project") || !config) {
					return errorResponse("OMP MCP creation requires a name, scope, and valid transport config", 400);
				}
				return json(await session.client.addMcpServer(input.name, input.scope, config));
			}
			if (request.method === "DELETE") {
				if (typeof input.name !== "string" || (input.scope !== "user" && input.scope !== "project")) {
					return errorResponse("OMP MCP removal requires an OMP-owned server name and scope", 400);
				}
				return json(await session.client.removeMcpServer(input.name, input.scope));
			}
			return unsupportedRoute(request);
		}
		if (pathname === "/provider" && request.method === "GET") {
			return json(await this.models.providers(directory));
		}
		if (pathname === "/config/providers" && request.method === "GET")
			return json(await this.models.providers(directory));
		if (pathname === "/agent" && request.method === "GET") {
			return json(await this.models.agents(directory));
		}
		if (pathname === "/command" && request.method === "GET") {
			return json(await this.models.commands(directory));
		}
		if (pathname === "/mcp" && request.method === "GET") return json(await this.models.mcp(directory));
		const mcpMutation = match(pathname, /^\/mcp\/([^/]+)\/(connect|disconnect)$/);
		if (mcpMutation?.[1] && mcpMutation[2] && request.method === "POST") {
			const session = await this.sessions.ensureDefault(directory);
			await session.client.setMcpServerEnabled(decodeURIComponent(mcpMutation[1]), mcpMutation[2] === "connect");
			return json(true);
		}
		if (pathname === "/lsp" && request.method === "GET") return json(await this.models.lsp(directory));

		if (pathname === "/session") {
			if (request.method === "GET") return this.#sessionList(url);
			if (request.method === "POST") {
				const input = await body(request);
				const session = await this.sessions.create({
					directory,
					title: typeof input.title === "string" ? input.title : undefined,
					parentID: typeof input.parentID === "string" ? input.parentID : undefined,
				});
				return json(session.info());
			}
		}
		if (pathname === "/session/status" && request.method === "GET") {
			return json(await this.sessions.statuses(directory));
		}

		const sessionRoute = match(pathname, /^\/session\/([^/]+)$/);
		if (sessionRoute?.[1] && ["GET", "DELETE", "PATCH"].includes(request.method)) {
			if (request.method === "DELETE") {
				return (await this.sessions.remove(sessionRoute[1]))
					? json(true)
					: errorResponse(`Session not found: ${sessionRoute[1]}`, 404);
			}
			const record = this.sessions.getRecord(sessionRoute[1]);
			if (!record) return errorResponse(`Session not found: ${sessionRoute[1]}`, 404);
			if (request.method === "GET") return json(this.#sessionInfo(record));
			const input = await body(request);
			const unsupported = Object.keys(input).filter(key => key !== "title");
			if (unsupported.length > 0)
				return errorResponse(`Unsupported session update fields: ${unsupported.join(", ")}`, 501);
			if (typeof input.title !== "string") return errorResponse("Session updates require a title", 400);
			const updated = await this.sessions.rename(sessionRoute[1], input.title);
			return updated
				? json(this.#sessionInfo(updated))
				: errorResponse(`Session not found: ${sessionRoute[1]}`, 404);
		}

		const runtimeRoute = match(pathname, /^\/session\/([^/]+)\/runtime$/);
		if (runtimeRoute?.[1] && (request.method === "GET" || request.method === "PATCH")) {
			const session = await this.sessions.activate(runtimeRoute[1]);
			if (!session) return errorResponse(`Session not found: ${runtimeRoute[1]}`, 404);
			if (request.method === "GET") return json(await session.composerRuntime());
			const input = await body(request);
			const unsupported = Object.keys(input).filter(
				key => key !== "thinkingLevel" && key !== "advisorEnabled" && key !== "approvalMode",
			);
			if (unsupported.length > 0)
				return errorResponse(`Unsupported OMP runtime fields: ${unsupported.join(", ")}`, 400);
			const update: {
				thinkingLevel?: OmpThinkingLevel;
				advisorEnabled?: boolean;
				approvalMode?: OmpApprovalMode;
			} = {};
			if ("thinkingLevel" in input) {
				if (
					typeof input.thinkingLevel !== "string" ||
					!(OMP_THINKING_LEVELS as readonly string[]).includes(input.thinkingLevel)
				)
					return errorResponse("Invalid OMP thinking level", 400);
				update.thinkingLevel = input.thinkingLevel as OmpThinkingLevel;
			}
			if ("advisorEnabled" in input) {
				if (typeof input.advisorEnabled !== "boolean") return errorResponse("Invalid OMP advisor state", 400);
				update.advisorEnabled = input.advisorEnabled;
			}
			if ("approvalMode" in input) {
				if (
					typeof input.approvalMode !== "string" ||
					!(OMP_APPROVAL_MODES as readonly string[]).includes(input.approvalMode)
				)
					return errorResponse("Invalid OMP approval mode", 400);
				update.approvalMode = input.approvalMode as OmpApprovalMode;
			}
			return json(await session.updateComposerRuntime(update));
		}

		const ompRoute = match(pathname, /^\/session\/([^/]+)\/omp(?:\/(.*))?$/);
		if (ompRoute?.[1]) {
			const sessionID = ompRoute[1];
			const action = ompRoute[2] ?? "";
			const session = await this.sessions.activate(sessionID);
			if (!session) return errorResponse(`Session not found: ${sessionID}`, 404);
			try {
				if (action === "") {
					if (request.method !== "GET") return unsupportedRoute(request);
					return json(await session.nativeSnapshot());
				}
				if (action === "bash/abort") {
					if (request.method !== "POST") return unsupportedRoute(request);
					await session.abortBash();
					return json(true);
				}
				if (action === "jobs/cancel") {
					if (request.method !== "POST") return unsupportedRoute(request);
					return json({ cancelled: await session.cancelAsyncJobs() });
				}
				if (action === "checkpoints") {
					if (request.method === "GET") {
						const rootPath = url.searchParams.get("rootPath") ?? undefined;
						if (rootPath !== undefined && !rootPath.trim()) {
							return errorResponse("Checkpoint rootPath must be a non-empty string", 400);
						}
						const rawLimit = url.searchParams.get("limit");
						if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) {
							return errorResponse("Checkpoint limit must be a non-negative integer", 400);
						}
						return json(
							await session.listWorkspaceCheckpoints({
								rootPath,
								limit: rawLimit === null ? undefined : Number(rawLimit),
							}),
						);
					}
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["label", "rootPath", "parentId", "pinned"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP checkpoint fields: ${unsupported.join(", ")}`, 400);
					}
					const label = input.label;
					if (label !== undefined && label !== null && typeof label !== "string") {
						return errorResponse("Checkpoint label must be a string or null", 400);
					}
					const rootPath = input.rootPath;
					if (rootPath !== undefined && (typeof rootPath !== "string" || !rootPath.trim())) {
						return errorResponse("Checkpoint rootPath must be a non-empty string", 400);
					}
					const parentId = input.parentId;
					if (parentId !== undefined && (typeof parentId !== "string" || !parentId.trim())) {
						return errorResponse("Checkpoint parentId must be a non-empty string", 400);
					}
					const pinned = input.pinned;
					if (pinned !== undefined && typeof pinned !== "boolean") {
						return errorResponse("Checkpoint pinned must be a boolean", 400);
					}
					return json(
						await session.createWorkspaceCheckpoint({
							label: label as string | null | undefined,
							rootPath: rootPath as string | undefined,
							parentId: parentId as string | undefined,
							pinned: pinned as boolean | undefined,
						}),
					);
				}
				if (action === "checkpoints/preview") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["checkpointId", "rootPath", "scope", "strategy", "paths"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP checkpoint preview fields: ${unsupported.join(", ")}`, 400);
					}
					const checkpointId = typeof input.checkpointId === "string" ? input.checkpointId : "";
					if (!checkpointId.trim()) return errorResponse("Checkpoint preview requires checkpointId", 400);
					const rootPath = input.rootPath;
					if (rootPath !== undefined && (typeof rootPath !== "string" || !rootPath.trim())) {
						return errorResponse("Checkpoint rootPath must be a non-empty string", 400);
					}
					const scope = input.scope;
					if (scope !== "code" && scope !== "conversation" && scope !== "all") {
						return errorResponse("Checkpoint preview requires scope code, conversation, or all", 400);
					}
					const strategy = input.strategy;
					if (strategy !== "preserve" && strategy !== "exact") {
						return errorResponse("Checkpoint preview requires strategy preserve or exact", 400);
					}
					const paths = input.paths;
					if (
						paths !== undefined &&
						(!Array.isArray(paths) || !paths.every(item => typeof item === "string" && item.trim()))
					) {
						return errorResponse("Checkpoint paths must be non-empty strings", 400);
					}
					return json(
						await session.previewWorkspaceRestore({
							checkpointId,
							rootPath: rootPath as string | undefined,
							scope,
							strategy,
							paths: paths as string[] | undefined,
						}),
					);
				}
				if (action === "checkpoints/apply") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["planId", "allowConflicts"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP checkpoint apply fields: ${unsupported.join(", ")}`, 400);
					}
					const planId = typeof input.planId === "string" ? input.planId : "";
					if (!planId.trim()) return errorResponse("Checkpoint apply requires planId", 400);
					const allowConflicts = input.allowConflicts;
					if (allowConflicts !== undefined && typeof allowConflicts !== "boolean") {
						return errorResponse("Checkpoint allowConflicts must be a boolean", 400);
					}
					return json(
						await session.applyWorkspaceRestore({
							planId,
							allowConflicts: allowConflicts as boolean | undefined,
						}),
					);
				}
				if (action === "checkpoints/undo") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["scope"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP checkpoint undo fields: ${unsupported.join(", ")}`, 400);
					}
					const scope = input.scope;
					if (scope !== undefined && scope !== "code" && scope !== "conversation" && scope !== "all") {
						return errorResponse("Checkpoint undo scope must be code, conversation, or all", 400);
					}
					return json(await session.undoWorkspace(scope as "code" | "conversation" | "all" | undefined));
				}
				if (action === "checkpoints/redo") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, []);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP checkpoint redo fields: ${unsupported.join(", ")}`, 400);
					}
					return json(await session.redoWorkspace());
				}
				if (action === "branch") {
					if (request.method === "GET") return json(await session.getBranchMessages());
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["entryId"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP branch fields: ${unsupported.join(", ")}`, 400);
					}
					const entryId = typeof input.entryId === "string" ? input.entryId : "";
					if (!entryId.trim()) return errorResponse("OMP branch requires entryId", 400);
					const branched = await this.sessions.branch(sessionID, entryId);
					return branched ? json(branched) : errorResponse(`Session not found: ${sessionID}`, 404);
				}
				if (action === "handoff") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["customInstructions"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP handoff fields: ${unsupported.join(", ")}`, 400);
					}
					const customInstructions = input.customInstructions;
					if (customInstructions !== undefined && typeof customInstructions !== "string") {
						return errorResponse("OMP handoff customInstructions must be a string", 400);
					}
					return json(await session.handoff(customInstructions as string | undefined));
				}
				if (action === "export") {
					if (request.method !== "GET") return unsupportedRoute(request);
					return json(await session.exportHtml());
				}
				if (action === "login") {
					if (request.method !== "POST") return unsupportedRoute(request);
					const input = await body(request);
					const unsupported = unsupportedFields(input, ["providerId"]);
					if (unsupported.length > 0) {
						return errorResponse(`Unsupported OMP login fields: ${unsupported.join(", ")}`, 400);
					}
					const providerId = typeof input.providerId === "string" ? input.providerId : "";
					if (!providerId.trim()) return errorResponse("OMP login requires providerId", 400);
					return json(await session.login(providerId));
				}
				return errorResponse(`Unknown OMP session action: ${action}`, 400);
			} catch (error) {
				return ompOperationError(error);
			}
		}

		const messageRoute = match(pathname, /^\/session\/([^/]+)\/message\/([^/]+)$/);
		if (messageRoute?.[1] && messageRoute[2] && request.method === "GET") {
			const session = await this.sessions.activate(messageRoute[1]);
			if (!session) return errorResponse(`Session not found: ${messageRoute[1]}`, 404);
			const messageID = decodeURIComponent(messageRoute[2]);
			const message = session.message(messageID);
			return message ? json(message) : errorResponse(`Message not found: ${messageID}`, 404);
		}

		const messagesRoute = match(pathname, /^\/session\/([^/]+)\/message$/);
		if (messagesRoute?.[1] && (request.method === "GET" || request.method === "POST")) {
			const session = await this.sessions.activate(messagesRoute[1]);
			if (!session) return errorResponse(`Session not found: ${messagesRoute[1]}`, 404);
			if (request.method === "GET") return json(session.messages());

			const input = await body(request);
			const selected = input.model === undefined ? undefined : modelSelection(input.model);
			if (input.model !== undefined && !selected) return errorResponse("Invalid prompt model selector", 400);
			if (selected) await session.setModel(selected.provider, selected.modelID);
			const agent = typeof input.agent === "string" ? input.agent : "build";
			if (agent !== "build") return errorResponse(`Unsupported OMP agent: ${agent}`, 501);
			if (input.variant !== undefined) {
				if (
					typeof input.variant !== "string" ||
					!(OMP_THINKING_LEVELS as readonly string[]).includes(input.variant)
				)
					return errorResponse("Invalid OMP thinking level", 400);
				await session.client.setThinkingLevel(input.variant as OmpThinkingLevel);
			}
			const prompt = promptParts(input);
			const message = await session.prompt(prompt.text, prompt.images, prompt.identity);
			return message ? json(message) : errorResponse("Prompt produced no assistant message", 500);
		}

		const promptRoute = match(pathname, /^\/session\/([^/]+)\/prompt_async$/);
		if (promptRoute?.[1] && request.method === "POST") {
			const session = await this.sessions.activate(promptRoute[1]);
			if (!session) return errorResponse(`Session not found: ${promptRoute[1]}`, 404);
			const input = await body(request);
			const selected = input.model === undefined ? undefined : modelSelection(input.model);
			if (input.model !== undefined && !selected) return errorResponse("Invalid prompt model selector", 400);
			if (selected) await session.setModel(selected.provider, selected.modelID);
			const agent = typeof input.agent === "string" ? input.agent : "build";
			if (agent !== "build") return errorResponse(`Unsupported OMP agent: ${agent}`, 501);
			if (input.variant !== undefined) {
				if (
					typeof input.variant !== "string" ||
					!(OMP_THINKING_LEVELS as readonly string[]).includes(input.variant)
				)
					return errorResponse("Invalid OMP thinking level", 400);
				await session.client.setThinkingLevel(input.variant as OmpThinkingLevel);
			}
			const prompt = promptParts(input);
			await session.promptAsync(prompt.text, prompt.images, prompt.identity);
			return noContent();
		}

		const shellRoute = match(pathname, /^\/session\/([^/]+)\/shell$/);
		if (shellRoute?.[1] && request.method === "POST") {
			const session = await this.sessions.activate(shellRoute[1]);
			if (!session) return errorResponse(`Session not found: ${shellRoute[1]}`, 404);
			const input = await body(request);
			const unsupported = unsupportedFields(input, ["agent", "command", "model"]);
			if (unsupported.length > 0)
				return errorResponse(`Unsupported OMP shell fields: ${unsupported.join(", ")}`, 400);
			if (input.agent !== undefined && typeof input.agent !== "string") {
				return errorResponse("Shell agent must be a string", 400);
			}
			const agent = typeof input.agent === "string" ? input.agent : "build";
			if (agent !== "build") return errorResponse(`Unsupported OMP shell agent: ${agent}`, 501);
			const command = typeof input.command === "string" ? input.command : "";
			if (!command.trim()) return errorResponse("Shell command must be a non-empty string", 400);
			const selected = input.model === undefined ? undefined : modelSelection(input.model);
			if (input.model !== undefined && !selected) return errorResponse("Invalid shell model selector", 400);
			if (selected) await session.setModel(selected.provider, selected.modelID);
			return json(await session.bash(command));
		}
		const commandRoute = match(pathname, /^\/session\/([^/]+)\/command$/);
		if (commandRoute?.[1] && request.method === "POST") {
			const session = await this.sessions.activate(commandRoute[1]);
			if (!session) return errorResponse(`Session not found: ${commandRoute[1]}`, 404);
			const input = await body(request);
			const command = typeof input.command === "string" ? input.command.trim().replace(/^\//, "") : "";
			if (!command || /\s|\//.test(command)) return errorResponse("Command must be a slash-command name", 400);
			if (typeof input.arguments !== "string") return errorResponse("Command arguments must be a string", 400);
			const selected = input.model === undefined ? undefined : modelSelection(input.model);
			if (input.model !== undefined && !selected) return errorResponse("Invalid command model selector", 400);
			if (selected) await session.setModel(selected.provider, selected.modelID);
			const agent = typeof input.agent === "string" ? input.agent : "build";
			if (agent !== "build") return errorResponse(`Unsupported OMP command agent: ${agent}`, 501);
			if (input.variant !== undefined) {
				if (
					typeof input.variant !== "string" ||
					!(OMP_THINKING_LEVELS as readonly string[]).includes(input.variant)
				)
					return errorResponse("Invalid OMP thinking level", 400);
				await session.client.setThinkingLevel(input.variant as OmpThinkingLevel);
			}
			const prompt = promptParts(input);
			await session.command(command, input.arguments, prompt.images, prompt.identity);
			return noContent();
		}

		const abortRoute = match(pathname, /^\/session\/([^/]+)\/abort$/);
		if (abortRoute?.[1] && request.method === "POST") {
			const session = await this.sessions.activate(abortRoute[1]);
			if (!session) return errorResponse(`Session not found: ${abortRoute[1]}`, 404);
			await session.abort();
			return json(true);
		}
		const compactRoute = match(pathname, /^\/session\/([^/]+)\/summarize$/);
		if (compactRoute?.[1] && request.method === "POST") {
			const session = await this.sessions.activate(compactRoute[1]);
			if (!session) return errorResponse(`Session not found: ${compactRoute[1]}`, 404);
			const input = await body(request);
			const directModel =
				typeof input.providerID === "string" && typeof input.modelID === "string"
					? { provider: input.providerID.trim(), modelID: input.modelID.trim() }
					: undefined;
			if (
				(input.providerID !== undefined || input.modelID !== undefined) &&
				(!directModel?.provider || !directModel.modelID)
			) {
				return errorResponse("Compaction requires both providerID and modelID", 400);
			}
			const selected = directModel ?? (input.model === undefined ? undefined : modelSelection(input.model));
			if (input.model !== undefined && !selected) return errorResponse("Invalid compaction model selector", 400);
			if (selected) await session.setModel(selected.provider, selected.modelID);
			await session.compact(typeof input.instructions === "string" ? input.instructions : undefined);
			return json(true);
		}
		const todoRoute = match(pathname, /^\/session\/([^/]+)\/todo$/);
		if (todoRoute?.[1] && request.method === "GET") {
			const session = await this.sessions.activate(todoRoute[1]);
			if (!session) return errorResponse(`Session not found: ${todoRoute[1]}`, 404);
			const state = await session.client.getState();
			return json(
				(state.todoPhases ?? []).flatMap(phase =>
					phase.tasks.map((item, index) => ({
						id: `${phase.name}_${index}`,
						content: item.content,
						status: item.status,
						priority: "medium",
					})),
				),
			);
		}
		const diffRoute = match(pathname, /^\/session\/([^/]+)\/diff$/);
		if (diffRoute?.[1] && request.method === "GET") {
			const session = this.sessions.getRecord(diffRoute[1]);
			if (!session) return errorResponse(`Session not found: ${diffRoute[1]}`, 404);
			return json(await this.#diff(session.directory));
		}

		if (pathname === "/question" && request.method === "GET") {
			return json(this.store.listInteractions("question").map(interaction => this.#questionRequest(interaction)));
		}
		if (pathname === "/permission" && request.method === "GET") {
			return json(
				this.store.listInteractions("permission").map(interaction => this.#permissionRequest(interaction)),
			);
		}
		const questionReply = match(pathname, /^\/question\/([^/]+)\/(reply|reject)$/);
		if (questionReply?.[1] && questionReply[2] && request.method === "POST") {
			const [, requestID, action] = questionReply;
			const interaction = this.store.listInteractions("question").find(item => item.id === requestID);
			if (!interaction) return errorResponse(`Question not found: ${requestID}`, 404);
			const session = await this.sessions.activate(interaction.sessionID);
			if (!session) return errorResponse(`Question not found: ${requestID}`, 404);
			let answer: string | undefined;
			if (action === "reply") {
				const input = await body(request);
				const answers = Array.isArray(input.answers) ? input.answers : [];
				const first = Array.isArray(answers[0]) ? answers[0][0] : answers[0];
				if (typeof first !== "string") return errorResponse("Question replies require an answer", 400);
				answer = first;
			}
			if (!(await session.answerInteraction(requestID, answer, action === "reject"))) {
				return errorResponse(`Question not found: ${requestID}`, 404);
			}
			return json(true);
		}
		const permissionReply = match(pathname, /^\/session\/([^/]+)\/permissions\/([^/]+)$/);
		if (permissionReply?.[1] && permissionReply[2] && request.method === "POST") {
			const interaction = this.store.listInteractions("permission").find(item => item.id === permissionReply[2]);
			if (!interaction || interaction.sessionID !== permissionReply[1]) {
				return errorResponse(`Permission not found: ${permissionReply[2]}`, 404);
			}
			const session = await this.sessions.activate(interaction.sessionID);
			if (!session) return errorResponse(`Permission not found: ${permissionReply[2]}`, 404);
			const input = await body(request);
			const response = input.response;
			if (response !== "once" && response !== "always" && response !== "reject") {
				return errorResponse("Permission replies must be once, always, or reject", 400);
			}
			if (!(await session.answerInteraction(permissionReply[2], response !== "reject", response === "reject"))) {
				return errorResponse(`Permission not found: ${permissionReply[2]}`, 404);
			}
			return json(true);
		}

		if (pathname === "/file" && request.method === "GET") {
			return json(await this.files.list(directory, url.searchParams.get("path") ?? undefined));
		}
		if (pathname === "/file/content" && request.method === "GET") {
			const target = url.searchParams.get("path");
			if (!target) return errorResponse("Missing file path", 400);
			return json(await this.files.read(directory, target));
		}
		if (pathname === "/find/file" && request.method === "GET") {
			const type = url.searchParams.get("type");
			return json(
				await this.files.find(
					directory,
					url.searchParams.get("query") ?? "",
					Number(url.searchParams.get("limit") ?? 100),
					type === "file" || type === "directory" ? type : undefined,
				),
			);
		}
		if (pathname === "/find" && request.method === "GET") {
			return json(
				await this.files.grep(directory, url.searchParams.get("pattern") ?? url.searchParams.get("query") ?? "", {
					regex: url.searchParams.get("regex") === "true",
					limit: Number(url.searchParams.get("limit") ?? 100),
				}),
			);
		}

		if (pathname === "/pty/shells" && request.method === "GET") return json([]);
		if (pathname === "/pty") {
			if (request.method === "GET") return json(this.ptys.list());
			if (request.method === "POST") {
				const input = await body(request);
				return json(
					this.ptys.create({
						command: typeof input.command === "string" ? input.command : undefined,
						args: Array.isArray(input.args)
							? input.args.filter((item): item is string => typeof item === "string")
							: undefined,
						cwd: typeof input.cwd === "string" ? this.files.resolve(directory, input.cwd) : directory,
						title: typeof input.title === "string" ? input.title : undefined,
					}),
				);
			}
		}
		const ptyTicket = match(pathname, /^\/pty\/([^/]+)\/connect-token$/);
		if (ptyTicket?.[1] && request.method === "GET") {
			const ticket = this.ptys.connectToken(ptyTicket[1]);
			return ticket ? json({ ticket }) : errorResponse(`PTY not found: ${ptyTicket[1]}`, 404);
		}
		const ptyConnect = match(pathname, /^\/pty\/([^/]+)\/connect$/);
		if (ptyConnect?.[1] && request.method === "GET") {
			const token = url.searchParams.get("ticket");
			if (!token || !this.ptys.consumeToken(ptyConnect[1], token)) return errorResponse("Invalid PTY token", 401);
			if (!server.upgrade(request, { data: { ptyID: ptyConnect[1] } })) {
				return errorResponse("WebSocket upgrade failed", 400);
			}
			return undefined;
		}
		const ptyRoute = match(pathname, /^\/pty\/([^/]+)$/);
		if (ptyRoute?.[1] && ["GET", "DELETE", "PATCH"].includes(request.method)) {
			if (request.method === "GET") {
				const pty = this.ptys.get(ptyRoute[1]);
				return pty ? json(pty) : errorResponse(`PTY not found: ${ptyRoute[1]}`, 404);
			}
			if (request.method === "DELETE") {
				return this.ptys.delete(ptyRoute[1]) ? json(true) : errorResponse(`PTY not found: ${ptyRoute[1]}`, 404);
			}
			const input = await body(request);
			const size = record(input.size);
			if (input.size !== undefined && (typeof size.rows !== "number" || typeof size.cols !== "number")) {
				return errorResponse("PTY size requires numeric rows and cols", 400);
			}
			const pty = this.ptys.update(ptyRoute[1], {
				title: typeof input.title === "string" ? input.title : undefined,
				size: input.size === undefined ? undefined : { rows: size.rows as number, cols: size.cols as number },
			});
			return pty ? json(pty) : errorResponse(`PTY not found: ${ptyRoute[1]}`, 404);
		}

		return unsupportedRoute(request);
	}

	#events(request: Request): Response {
		const lastEventID = Number(request.headers.get("last-event-id") ?? 0);
		let cleanup: (() => void) | undefined;
		let heartbeat: Timer | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				const encoder = new TextEncoder();
				const send = (event: { sequence: number; directory: string; payload: unknown }) => {
					const payload = { directory: event.directory, payload: event.payload };
					controller.enqueue(encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(payload)}\n\n`));
				};
				for (const event of this.store.listEvents(lastEventID)) send(event);
				cleanup = this.store.onEvent(send);
				heartbeat = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 10_000);
			},
			cancel: () => {
				cleanup?.();
				if (heartbeat) clearInterval(heartbeat);
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	}

	#sessionInfo(session: WebSessionRecord) {
		return {
			id: session.id,
			projectID: session.projectID,
			directory: session.directory,
			parentID: session.parentID,
			title: session.title,
			version: "omp",
			time: { created: session.createdAt, updated: session.updatedAt },
		};
	}

	async #sessionList(url: URL): Promise<Response> {
		const roots = url.searchParams.get("roots");
		if (roots !== null && roots !== "true" && roots !== "false") {
			return errorResponse("Session roots must be true or false", 400);
		}
		const rawLimit = url.searchParams.get("limit");
		if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) {
			return errorResponse("Session limit must be a non-negative integer", 400);
		}
		const search = (url.searchParams.get("search") ?? "").trim().toLocaleLowerCase();
		const sessions = await this.sessions.list(url.searchParams.get("directory") ?? undefined);
		const filtered = sessions.filter(session => {
			if (roots === "true" && session.parentID !== undefined) return false;
			return (
				!search ||
				session.id.toLocaleLowerCase().includes(search) ||
				session.title.toLocaleLowerCase().includes(search)
			);
		});
		const limit = rawLimit === null ? undefined : Number(rawLimit);
		return json(filtered.slice(0, limit).map(session => this.#sessionInfo(session)));
	}

	#questionRequest(interaction: { id: string; sessionID: string; request: unknown }) {
		const request = record(interaction.request);
		const title = typeof request.title === "string" ? request.title : "";
		const select = request.method === "select";
		const options =
			select && Array.isArray(request.options)
				? request.options
						.filter((option): option is string => typeof option === "string")
						.map(label => ({ label, description: "" }))
				: [];
		return {
			id: interaction.id,
			requestID: interaction.id,
			sessionID: interaction.sessionID,
			questions: [
				{
					question: title,
					header: title.slice(0, 30),
					options,
					multiple: false,
					custom: !select,
				},
			],
		};
	}

	#permissionRequest(interaction: { id: string; sessionID: string; request: unknown }) {
		const request = record(interaction.request);
		return {
			id: interaction.id,
			requestID: interaction.id,
			sessionID: interaction.sessionID,
			permission: typeof request.title === "string" ? request.title : "",
			patterns: [],
			metadata: { message: typeof request.message === "string" ? request.message : "" },
			always: [],
		};
	}

	async #diff(directory: string) {
		const patches = parsePatch(await git.diff(directory));
		return Promise.all(
			patches.map(async patch => {
				const rawPath = patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName;
				const file = rawPath?.replace(/^[ab]\//, "") ?? "";
				let before = "";
				let after = "";
				try {
					before = await git.show(directory, `HEAD:${file}`);
				} catch {}
				try {
					after = await Bun.file(path.join(directory, file)).text();
				} catch {}
				const lines = patch.hunks.flatMap(hunk => hunk.lines);
				return {
					file,
					before,
					after,
					additions: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
					deletions: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length,
				};
			}),
		);
	}

	async #static(pathname: string, navigation: boolean): Promise<Response> {
		const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
		const candidate = path.resolve(this.options.staticDirectory, relative);
		const root = path.resolve(this.options.staticDirectory);
		if (!(candidate.startsWith(`${root}${path.sep}`) || candidate === root)) {
			return errorResponse(`Static asset not found: ${pathname}`, 404);
		}
		const asset = Bun.file(candidate);
		if (await asset.exists()) return new Response(asset, { headers: { "Content-Type": asset.type } });
		if (!navigation) return errorResponse(`Static asset not found: ${pathname}`, 404);
		const index = Bun.file(path.join(root, "index.html"));
		return (await index.exists())
			? new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } })
			: errorResponse("Web assets are not built", 404);
	}

	#requiresAuth(pathname: string): boolean {
		if (/^\/(?:api\/)?pty\/[^/]+\/connect$/.test(pathname)) return false;
		return (
			Boolean(this.options.password) &&
			(pathname.startsWith("/api/") || pathname.startsWith("/global/") || !pathname.includes("."))
		);
	}

	#authorized(request: Request): boolean {
		if (!this.options.password) return true;
		const expected = `Basic ${Buffer.from(`${this.options.username ?? "omp"}:${this.options.password}`).toString("base64")}`;
		return request.headers.get("authorization") === expected;
	}

	#cors(response: Response): Response {
		response.headers.set("Access-Control-Allow-Origin", "*");
		response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
		response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
		return response;
	}
}
