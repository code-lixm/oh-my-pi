import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { OmpApprovalMode, OmpThinkingLevel } from "../shared/omp-view-model";
import type { ProviderListResponse } from "../src/omp/types";
import { createOmpApi } from "../src/utils/omp-api";
import { createOmpApiTransportForServer, createOmpTransportForServer } from "../src/utils/server";
import { OmpWebServer } from "./app-server";
import { RpcWebSession } from "./rpc-session";
import { SessionRegistry } from "./session-registry";
import { DurableStore } from "./store";

const LIVE_IO_TIMEOUT_MS = 5_000;
const bunExecutable = process.execPath;
const roots = new Set<string>();
const servers = new Set<OmpWebServer>();
const registries = new Set<SessionRegistry>();
const sockets = new Set<WebSocket>();

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-server-"));
	roots.add(root);
	return root;
}

function closeSocket(socket: WebSocket): void {
	if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
		socket.close(1000, "Test teardown");
}

async function attempt(action: () => Promise<void> | void, errors: unknown[]): Promise<void> {
	try {
		await action();
	} catch (error) {
		errors.push(error);
	}
}

afterEach(async () => {
	const errors: unknown[] = [];
	await attempt(() => {
		for (const socket of sockets) closeSocket(socket);
		sockets.clear();
	}, errors);
	await attempt(async () => {
		await Promise.all(Array.from(servers, server => server.stop()));
		servers.clear();
	}, errors);
	await attempt(async () => {
		await Promise.all(Array.from(registries, registry => registry.close()));
		registries.clear();
	}, errors);
	await attempt(async () => {
		await Promise.all(Array.from(roots, root => fs.rm(root, { recursive: true, force: true })));
		roots.clear();
	}, errors);
	if (errors.length > 0) throw new AggregateError(errors, "Test resource cleanup failed");
});

function withLiveIoTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
	const { promise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(
		() => reject(new Error(`${label} did not settle within ${LIVE_IO_TIMEOUT_MS}ms`)),
		LIVE_IO_TIMEOUT_MS,
	);
	return Promise.race([operation, promise]).finally(() => clearTimeout(timer));
}

function waitForOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const cleanup = () => {
		socket.removeEventListener("open", onOpen);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("error", onError);
	};
	const onOpen = () => {
		cleanup();
		resolve();
	};
	const onClose = () => {
		cleanup();
		reject(new Error("PTY WebSocket closed before opening"));
	};
	const onError = () => {
		cleanup();
		reject(new Error("PTY WebSocket failed before opening"));
	};
	socket.addEventListener("open", onOpen);
	socket.addEventListener("close", onClose);
	socket.addEventListener("error", onError);
	return promise;
}

function collectTextUntilClose(socket: WebSocket): Promise<{ text: string; code: number }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ text: string; code: number }>();
	let text = "";
	const cleanup = () => {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("error", onError);
	};
	const onMessage = (event: MessageEvent) => {
		if (typeof event.data === "string") {
			text += event.data;
			return;
		}
		cleanup();
		reject(new Error("PTY WebSocket emitted non-text terminal data"));
	};
	const onClose = (event: CloseEvent) => {
		cleanup();
		resolve({ text, code: event.code });
	};
	const onError = () => {
		cleanup();
		reject(new Error("PTY WebSocket failed while streaming terminal output"));
	};
	socket.addEventListener("message", onMessage);
	socket.addEventListener("close", onClose);
	socket.addEventListener("error", onError);
	return promise;
}

function waitForText(socket: WebSocket, expected: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let text = "";
	const cleanup = () => {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("error", onError);
	};
	const onMessage = (event: MessageEvent) => {
		if (typeof event.data !== "string") {
			cleanup();
			reject(new Error("PTY WebSocket emitted non-text terminal data"));
			return;
		}
		text += event.data;
		if (text.includes(expected)) {
			cleanup();
			resolve();
		}
	};
	const onClose = () => {
		cleanup();
		reject(new Error(`PTY WebSocket closed before emitting ${JSON.stringify(expected)}: ${JSON.stringify(text)}`));
	};
	const onError = () => {
		cleanup();
		reject(new Error("PTY WebSocket failed while streaming terminal output"));
	};
	socket.addEventListener("message", onMessage);
	socket.addEventListener("close", onClose);
	socket.addEventListener("error", onError);
	return promise;
}

async function startWebServer(
	promptMessages: unknown[] = [],
	options: FakeRpcServerOptions = {},
): Promise<{ app: OmpWebServer; baseUrl: string; requestLogFile: string }> {
	if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
	const root = await temporaryRoot();
	const sessionID = "bridge-contract-session";
	const sessionFile = path.join(root, `${sessionID}.jsonl`);
	const rpcServerFile = path.join(root, "bridge-contract-rpc.mjs");
	const requestLogFile = options.requestLogFile ?? path.join(root, "bridge-contract-rpc-requests.jsonl");
	await Promise.all([
		fs.writeFile(sessionFile, ""),
		fs.writeFile(requestLogFile, ""),
		fs.writeFile(
			rpcServerFile,
			fakeRpcServer(sessionID, sessionFile, promptMessages, { ...options, requestLogFile }),
		),
	]);
	const app = await OmpWebServer.create({
		hostname: "127.0.0.1",
		port: 0,
		rootDirectory: root,
		staticDirectory: root,
		databaseFile: path.join(root, "state.sqlite"),
		command: [bunExecutable, rpcServerFile],
	});
	servers.add(app);
	const listener = app.start();
	return { app, baseUrl: `http://127.0.0.1:${listener.port}`, requestLogFile };
}

async function expectUnsupportedRoute(response: Response, method: string, pathname: string): Promise<unknown> {
	expect(response.status).toBe(501);
	expect(response.headers.get("content-type")).toContain("application/json");
	const error = await response.json();
	expect(error).toEqual(
		expect.objectContaining({
			name: "UnknownError",
			data: expect.objectContaining({
				message: `Unsupported OMP Web API route: ${method} ${pathname}`,
			}),
		}),
	);
	return error;
}

function terminalFixture(): { command: string; args: string[] } {
	if (process.platform === "win32") {
		const command = process.env.ComSpec;
		if (!command) throw new Error("Windows command shell is required for bridge fixtures");
		return {
			command,
			args: ["/d", "/v:on", "/s", "/c", "set /p line= & echo bridge-output:!line! & set /p ignored= & exit /b 23"],
		};
	}
	return {
		command: "/bin/sh",
		args: ["-c", 'IFS= read -r line; printf "bridge-output:%s\\n" "$line"; IFS= read -r ignored; exit 23'],
	};
}

const fakeRpcModel = {
	provider: "fixture-provider",
	id: "fixture-model",
	reasoning: true,
	thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
	contextWindow: 200_000,
} as const;

type FakeRpcRuntime = {
	thinkingLevel: OmpThinkingLevel;
	configuredThinkingLevel: OmpThinkingLevel;
	advisorEnabled: boolean;
	approvalMode: OmpApprovalMode;
};

type FakeRpcNativeSnapshot = {
	isBashRunning: boolean;
	isEvalRunning: boolean;
	asyncJobs: unknown | null;
	cancelledAsyncJobs: number;
	cancelAsyncJobsError?: string;
};

type FakeRpcServerOptions = {
	startMarkerFile?: string;
	requestLogFile?: string;
	runtime?: Partial<FakeRpcRuntime>;
	nativeSnapshot?: Partial<FakeRpcNativeSnapshot>;
};

function fakeRpcServer(
	sessionID: string,
	sessionFile: string,
	promptMessages: unknown[] = [],
	options: FakeRpcServerOptions = {},
): string {
	const runtime: FakeRpcRuntime = {
		thinkingLevel: options.runtime?.thinkingLevel ?? "low",
		configuredThinkingLevel: options.runtime?.configuredThinkingLevel ?? "low",
		advisorEnabled: options.runtime?.advisorEnabled ?? false,
		approvalMode: options.runtime?.approvalMode ?? "always-ask",
	};
	const nativeSnapshot: FakeRpcNativeSnapshot = {
		isBashRunning: options.nativeSnapshot?.isBashRunning ?? false,
		isEvalRunning: options.nativeSnapshot?.isEvalRunning ?? false,
		asyncJobs: options.nativeSnapshot?.asyncJobs ?? null,
		cancelledAsyncJobs: options.nativeSnapshot?.cancelledAsyncJobs ?? 0,
		cancelAsyncJobsError: options.nativeSnapshot?.cancelAsyncJobsError,
	};
	const state = JSON.stringify({
		sessionId: sessionID,
		sessionFile,
		model: fakeRpcModel,
		thinkingLevel: runtime.thinkingLevel,
		configuredThinkingLevel: runtime.configuredThinkingLevel,
		isStreaming: false,
		isBashRunning: nativeSnapshot.isBashRunning,
		isEvalRunning: nativeSnapshot.isEvalRunning,
	});
	const availableModels = JSON.stringify([fakeRpcModel]);
	const asyncJobs = JSON.stringify(nativeSnapshot.asyncJobs);
	const cancelledAsyncJobs = JSON.stringify(nativeSnapshot.cancelledAsyncJobs);
	const cancelAsyncJobsError = JSON.stringify(nativeSnapshot.cancelAsyncJobsError ?? null);
	const settings = JSON.stringify({
		version: 1,
		values: {
			"advisor.enabled": runtime.advisorEnabled,
			"tools.approvalMode": runtime.approvalMode,
		},
		configured: ["advisor.enabled", "tools.approvalMode"],
		redacted: [],
	});
	const requestLogFile = JSON.stringify(options.requestLogFile ?? "");
	const transcript = JSON.stringify(promptMessages);
	const startMarker = options.startMarkerFile
		? `writeFileSync(${JSON.stringify(options.startMarkerFile)}, "started");`
		: "";
	return `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const state = ${state};
const availableModels = ${availableModels};
const settings = ${settings};
const requestLogFile = ${requestLogFile};
const transcript = ${transcript};
const asyncJobs = ${asyncJobs};
const cancelledAsyncJobs = ${cancelledAsyncJobs};
const cancelAsyncJobsError = ${cancelAsyncJobsError};
let prompted = false;
const reply = value => process.stdout.write(JSON.stringify(value) + "\\n");
const logRequest = request => {
	if (!requestLogFile) return;
	const { id: _id, ...command } = request;
	appendFileSync(requestLogFile, JSON.stringify(command) + "\\n");
};

${startMarker}
reply({ type: "ready" });
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!raw) continue;
	const request = JSON.parse(raw);
	logRequest(request);
	if (request.type === "get_state") {
		reply({ type: "response", id: request.id, command: "get_state", success: true, data: state });
	}
	if (request.type === "set_subagent_subscription") {
		reply({ type: "response", id: request.id, command: "set_subagent_subscription", success: true, data: { level: request.level } });
	}
	if (request.type === "get_subagents") {
		reply({ type: "response", id: request.id, command: "get_subagents", success: true, data: { subagents: [] } });
	}
	if (request.type === "get_async_jobs") {
		reply({ type: "response", id: request.id, command: "get_async_jobs", success: true, data: { asyncJobs } });
	}
	if (request.type === "get_login_providers") {
		reply({ type: "response", id: request.id, command: "get_login_providers", success: true, data: { providers: [] } });
	}
	if (request.type === "cancel_async_jobs") {
		if (cancelAsyncJobsError) {
			reply({ type: "response", id: request.id, command: "cancel_async_jobs", success: false, error: cancelAsyncJobsError });
		} else {
			reply({ type: "response", id: request.id, command: "cancel_async_jobs", success: true, data: { cancelled: cancelledAsyncJobs } });
		}
	}
	if (request.type === "get_settings") {
		reply({ type: "response", id: request.id, command: "get_settings", success: true, data: settings });
	}
	if (request.type === "update_settings") {
		settings.values[request.path] = request.value;
		if (!settings.configured.includes(request.path)) settings.configured.push(request.path);
		reply({ type: "response", id: request.id, command: "update_settings", success: true, data: settings });
	}
	if (request.type === "set_thinking_level") {
		state.configuredThinkingLevel = request.level;
		if (request.level !== "auto") state.thinkingLevel = request.level;
		reply({ type: "response", id: request.id, command: "set_thinking_level", success: true });
	}
	if (request.type === "get_available_models") {
		reply({
			type: "response",
			id: request.id,
			command: "get_available_models",
			success: true,
			data: { models: availableModels },
		});
	}
	if (request.type === "prompt") {
		prompted = true;
		reply({ type: "response", id: request.id, command: "prompt", success: true });
	}
	if (request.type === "get_messages") {
		reply({ type: "response", id: request.id, command: "get_messages", success: true, data: { messages: prompted ? transcript : [] } });
	}
}
`;
}

type ManagementRequest = Record<string, unknown>;

async function managementRequests(logFile: string): Promise<ManagementRequest[]> {
	const content = await fs.readFile(logFile, "utf8");
	return content
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as ManagementRequest);
}

async function fakeRpcRequests(logFile: string): Promise<ManagementRequest[]> {
	const content = await fs.readFile(logFile, "utf8");
	return content
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as ManagementRequest);
}

function fakeManagementRpcServer(
	sessionID: string,
	sessionFile: string,
	requestLogFile: string,
	startMarkerFile?: string,
): string {
	const state = JSON.stringify({ sessionId: sessionID, sessionFile, model: null, isStreaming: false });
	const logFile = JSON.stringify(requestLogFile);
	const startMarker = startMarkerFile ? `writeFileSync(${JSON.stringify(startMarkerFile)}, "started");` : "";
	const plugins = JSON.stringify([
		{
			id: "scoped-plugin",
			name: "Scoped plugin",
			version: "1.0.0",
			kind: "npm",
			scope: "project",
			enabled: true,
		},
	]);
	const mcpServers = JSON.stringify([
		{
			name: "remote server",
			enabled: true,
			status: "connected",
			transport: "http",
			scope: "project",
			source: "fixture",
			removable: true,
		},
		{
			name: "user-server",
			enabled: true,
			status: "connected",
			transport: "stdio",
			scope: "user",
			source: "fixture",
			removable: true,
		},
	]);
	const keybindingCatalog = JSON.stringify({
		version: 1,
		groups: [{ id: "application", label: "Application" }],
		keybindings: [
			{
				id: "app.interrupt",
				label: "Interrupt current operation",
				group: "application",
				defaultKeys: ["escape"],
			},
			{
				id: "app.clear",
				label: "Clear screen or cancel",
				group: "application",
				defaultKeys: ["ctrl+c"],
			},
		],
	});
	const settingsCatalog = JSON.stringify({
		version: 1,
		locale: "en",
		tabs: [],
		settings: [],
		theme: {
			light: {
				id: "fixture-light",
				name: "Fixture light",
				neutral: "#f7f3ed",
				ink: "#102030",
				primary: "#2468ac",
				success: "#137a41",
				warning: "#b66a00",
				error: "#bc2738",
				info: "#1976d2",
				interactive: "#7a3dd1",
				diffAdd: "#008a35",
				diffDelete: "#c51c30",
			},
			dark: {
				id: "fixture-dark",
				name: "Fixture dark",
				neutral: "#17202a",
				ink: "#f8fafc",
				primary: "#7db7ff",
				success: "#78dca4",
				warning: "#ffca6b",
				error: "#ff9cac",
				info: "#8dc7ff",
				interactive: "#cc9eff",
				diffAdd: "#68e39c",
				diffDelete: "#ff8495",
			},
		},
	});
	const initialKeybindings = JSON.stringify({
		version: 1,
		values: {
			"app.interrupt": ["escape"],
			"app.clear": ["ctrl+c"],
		},
		configured: [],
	});
	return `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const state = ${state};
const requestLogFile = ${logFile};
const plugins = ${plugins};
let servers = ${mcpServers};
const settingsCatalog = ${settingsCatalog};
const keybindingCatalog = ${keybindingCatalog};
const initialKeybindings = ${initialKeybindings};
let keybindings = JSON.parse(JSON.stringify(initialKeybindings));
const managementTypes = {
	get_plugins: true,
	set_plugin_enabled: true,
	get_mcp_servers: true,
	set_mcp_server_enabled: true,
	add_mcp_server: true,
	remove_mcp_server: true,
	get_settings_catalog: true,
	get_keybindings_catalog: true,
	get_keybindings: true,
	update_keybinding: true,
	reset_keybindings: true,
};
const reply = value => process.stdout.write(JSON.stringify(value) + "\\n");

${startMarker}

reply({ type: "ready" });
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!raw) continue;
	const request = JSON.parse(raw);
	if (managementTypes[request.type]) {
		const { id: _id, ...command } = request;
		appendFileSync(requestLogFile, JSON.stringify(command) + "\\n");
	}
	if (request.type === "get_state") {
		reply({ type: "response", id: request.id, command: "get_state", success: true, data: state });
		continue;
	}
	if (request.type === "set_subagent_subscription") {
		reply({ type: "response", id: request.id, command: "set_subagent_subscription", success: true, data: { level: request.level } });
		continue;
	}
	if (request.type === "get_messages") {
		reply({ type: "response", id: request.id, command: "get_messages", success: true, data: { messages: [] } });
		continue;
	}
	if (request.type === "get_settings_catalog") {
		const localizedCatalog = { ...settingsCatalog, locale: request.locale ?? settingsCatalog.locale };
		reply({ type: "response", id: request.id, command: "get_settings_catalog", success: true, data: localizedCatalog });
		continue;
	}
	if (request.type === "get_keybindings_catalog") {
		reply({ type: "response", id: request.id, command: "get_keybindings_catalog", success: true, data: keybindingCatalog });
		continue;
	}
	if (request.type === "get_keybindings") {
		reply({ type: "response", id: request.id, command: "get_keybindings", success: true, data: keybindings });
		continue;
	}
	if (request.type === "update_keybinding") {
		keybindings = {
			...keybindings,
			values: { ...keybindings.values, [request.keybinding]: request.keys },
			configured: [...new Set([...keybindings.configured, request.keybinding])],
		};
		reply({ type: "response", id: request.id, command: "update_keybinding", success: true, data: keybindings });
		continue;
	}
	if (request.type === "reset_keybindings") {
		keybindings = JSON.parse(JSON.stringify(initialKeybindings));
		reply({ type: "response", id: request.id, command: "reset_keybindings", success: true, data: keybindings });
		continue;
	}
	if (request.type === "get_plugins") {
		reply({ type: "response", id: request.id, command: "get_plugins", success: true, data: { plugins } });
		continue;
	}
	if (request.type === "set_plugin_enabled") {
		const plugin = plugins.find(item =>
			item.id === request.plugin?.id && item.kind === request.plugin?.kind && item.scope === request.plugin?.scope,
		);
		if (plugin) plugin.enabled = request.enabled;
		reply({ type: "response", id: request.id, command: "set_plugin_enabled", success: true, data: { plugins } });
		continue;
	}
	if (request.type === "get_mcp_servers") {
		reply({ type: "response", id: request.id, command: "get_mcp_servers", success: true, data: { servers } });
		continue;
	}
	if (request.type === "set_mcp_server_enabled") {
		const server = servers.find(item => item.name === request.name);
		if (server) {
			server.enabled = request.enabled;
			server.status = request.enabled ? "connected" : "disabled";
		}
		reply({ type: "response", id: request.id, command: "set_mcp_server_enabled", success: true, data: { servers } });
		continue;
	}
	if (request.type === "add_mcp_server") {
		servers.push({
			name: request.name,
			enabled: true,
			status: "connected",
			transport: request.config.type,
			scope: request.scope,
			source: "fixture",
			removable: true,
		});
		reply({ type: "response", id: request.id, command: "add_mcp_server", success: true, data: { servers } });
		continue;
	}
	if (request.type === "remove_mcp_server") {
		servers = servers.filter(item => item.name !== request.name || item.scope !== request.scope);
		reply({ type: "response", id: request.id, command: "remove_mcp_server", success: true, data: { servers } });
	}
}
`;
}

async function startManagementWebServer(
	options: { startMarkerFile?: string } = {},
): Promise<{ baseUrl: string; requestLogFile: string }> {
	if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
	const root = await temporaryRoot();
	const sessionID = "management-bridge-session";
	const sessionDirectory = path.join(root, "session-fixtures");
	const sessionFile = path.join(root, "management-bridge-session.jsonl");
	const requestLogFile = path.join(root, "management-requests.jsonl");
	const rpcServerFile = path.join(root, "management-rpc-server.mjs");
	await fs.mkdir(sessionDirectory, { recursive: true });
	await Promise.all([
		fs.writeFile(requestLogFile, ""),
		fs.writeFile(
			rpcServerFile,
			fakeManagementRpcServer(sessionID, sessionFile, requestLogFile, options.startMarkerFile),
		),
	]);
	const app = await OmpWebServer.create({
		hostname: "127.0.0.1",
		port: 0,
		rootDirectory: root,
		staticDirectory: root,
		databaseFile: path.join(root, "state.sqlite"),
		command: [bunExecutable, rpcServerFile],
		sessionDir: sessionDirectory,
	});
	servers.add(app);
	const listener = app.start();
	return { baseUrl: `http://127.0.0.1:${listener.port}`, requestLogFile };
}

describe("OMP web server bridge", () => {
	test("advertises exact OMP health and management capabilities", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			healthy: true,
			product: "oh-my-pi",
			version: VERSION,
			pid: process.pid,
			protocol: "omp-web/v1",
			capabilities: {
				providerWrite: false,
				mcpWrite: true,
				settingsRead: true,
				settingsWrite: true,
				pluginRead: true,
				pluginWrite: true,
				projectMetadataWrite: false,
				sessionArchive: false,
				workspaceWrite: false,
				sessionFork: false,
				sessionRevert: false,
				sessionShare: false,
				nativeSessionRpc: true,
			},
		});
	});

	test("projects only authoritative RPC model facts without fabricating OpenCode metadata", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/provider`);

		expect(response.status).toBe(200);
		const providers = (await response.json()) as ProviderListResponse;
		expect(providers.connected).toEqual([fakeRpcModel.provider]);
		expect(providers.default).toEqual({ [fakeRpcModel.provider]: fakeRpcModel.id });
		expect(providers.all).toHaveLength(1);

		const provider = providers.all[0]!;
		expect(provider.id).toBe(fakeRpcModel.provider);
		expect(Object.keys(provider.models)).toEqual([fakeRpcModel.id]);
		const model = provider.models[fakeRpcModel.id];
		expect(model).toEqual({
			id: fakeRpcModel.id,
			providerID: fakeRpcModel.provider,
			name: fakeRpcModel.id,
			capabilities: {
				temperature: false,
				reasoning: true,
				attachment: false,
				toolcall: false,
				input: { text: false, audio: false, image: false, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
				interleaved: false,
			},
			limit: { context: fakeRpcModel.contextWindow, output: 0 },
			variants: Object.fromEntries(["off", "auto", ...fakeRpcModel.thinking.efforts].map(effort => [effort, {}])),
		});
		for (const field of ["api", "cost", "headers", "options", "release_date", "status"] as const) {
			expect(model).not.toHaveProperty(field);
		}
	});

	test("does not advertise a removed plan identity to a build-only web client", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/agent`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual([
			expect.objectContaining({
				name: "build",
				description: "OMP coding agent",
				mode: "primary",
				builtIn: true,
				model: { providerID: fakeRpcModel.provider, modelID: fakeRpcModel.id },
			}),
		]);
	});

	test("lets a user independently change every input-bar control without resetting the others", async () => {
		const { baseUrl, requestLogFile } = await startWebServer([], {
			runtime: {
				thinkingLevel: "low",
				configuredThinkingLevel: "low",
				advisorEnabled: false,
				approvalMode: "always-ask",
			},
		});
		const created = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(created.status).toBe(200);
		expect(created.headers.get("content-type")).toContain("application/json");
		const { id: sessionID } = (await created.json()) as { id: string };
		const runtimePath = `${baseUrl}/api/omp/session/${encodeURIComponent(sessionID)}/runtime`;
		const thinkingOptions = ["off", "auto", ...fakeRpcModel.thinking.efforts];
		const expectedRuntime = (current: OmpThinkingLevel, advisorEnabled: boolean, approvalMode: OmpApprovalMode) => ({
			thinking: { current, options: thinkingOptions },
			advisorEnabled,
			approvalMode,
		});
		const patchRuntime = async (input: Record<string, unknown>) => {
			const response = await fetch(runtimePath, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("application/json");
			return response.json();
		};

		const initial = await fetch(runtimePath);
		expect(initial.status).toBe(200);
		expect(initial.headers.get("content-type")).toContain("application/json");
		expect(await initial.json()).toEqual(expectedRuntime("low", false, "always-ask"));

		expect(await patchRuntime({ thinkingLevel: "auto" })).toEqual(expectedRuntime("auto", false, "always-ask"));
		expect(await patchRuntime({ advisorEnabled: true })).toEqual(expectedRuntime("auto", true, "always-ask"));
		expect(await patchRuntime({ approvalMode: "write" })).toEqual(expectedRuntime("auto", true, "write"));

		const persisted = await fetch(runtimePath);
		expect(persisted.status).toBe(200);
		expect(persisted.headers.get("content-type")).toContain("application/json");
		expect(await persisted.json()).toEqual(expectedRuntime("auto", true, "write"));

		const mutations = (await fakeRpcRequests(requestLogFile)).filter(
			request => request.type === "set_thinking_level" || request.type === "update_settings",
		);
		expect(mutations).toEqual([
			{ type: "set_thinking_level", level: "auto" },
			{ type: "update_settings", path: "advisor.enabled", value: true },
			{ type: "update_settings", path: "tools.approvalMode", value: "write" },
		]);
	});

	test("forwards native Bash and eval activity while limiting snapshot and job cancellation to their supported methods", async () => {
		const { baseUrl } = await startWebServer([], {
			nativeSnapshot: {
				isBashRunning: true,
				isEvalRunning: true,
				asyncJobs: { active: [{ id: "job-to-cancel", status: "running" }] },
				cancelledAsyncJobs: 7,
			},
		});
		const created = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(created.status).toBe(200);
		const { id: sessionID } = (await created.json()) as { id: string };
		const nativePathname = `/api/omp/session/${encodeURIComponent(sessionID)}/omp`;
		const nativePath = `${baseUrl}${nativePathname}`;

		const snapshot = await fetch(nativePath);
		expect(snapshot.status).toBe(200);
		expect(snapshot.headers.get("content-type")).toContain("application/json");
		expect(await snapshot.json()).toEqual(
			expect.objectContaining({
				state: expect.objectContaining({ isBashRunning: true, isEvalRunning: true }),
			}),
		);

		const cancelled = await fetch(`${nativePath}/jobs/cancel`, { method: "POST" });
		expect(cancelled.status).toBe(200);
		expect(cancelled.headers.get("content-type")).toContain("application/json");
		expect(await cancelled.json()).toEqual({ cancelled: 7 });

		await expectUnsupportedRoute(await fetch(nativePath, { method: "POST" }), "POST", nativePathname);
		await expectUnsupportedRoute(await fetch(`${nativePath}/jobs/cancel`), "GET", `${nativePathname}/jobs/cancel`);
	});

	test("maps a native job-cancellation conflict to the established structured bridge error", async () => {
		const cancellationError = "workspace lock held by another operation";
		const { baseUrl } = await startWebServer([], {
			nativeSnapshot: { cancelAsyncJobsError: cancellationError },
		});
		const created = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(created.status).toBe(200);
		const { id: sessionID } = (await created.json()) as { id: string };
		const response = await fetch(`${baseUrl}/api/omp/session/${encodeURIComponent(sessionID)}/omp/jobs/cancel`, {
			method: "POST",
		});

		expect(response.status).toBe(409);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual(
			expect.objectContaining({
				name: "UnknownError",
				data: expect.objectContaining({ message: cancellationError }),
			}),
		);
	});

	test("applies a user's selected thinking variant before their build prompt and rejects the removed plan agent", async () => {
		const { baseUrl, requestLogFile } = await startWebServer();
		const created = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(created.status).toBe(200);
		expect(created.headers.get("content-type")).toContain("application/json");
		const { id: sessionID } = (await created.json()) as { id: string };
		const promptPath = `${baseUrl}/api/omp/session/${encodeURIComponent(sessionID)}/prompt_async`;
		const promptText = "set high thinking before this input-bar prompt";

		const prompted = await fetch(promptPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agent: "build",
				variant: "high",
				parts: [{ type: "text", text: promptText }],
			}),
		});
		expect(prompted.status).toBe(204);
		expect(await prompted.text()).toBe("");

		const removedPlan = await fetch(promptPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent: "plan", parts: [{ type: "text", text: promptText }] }),
		});
		expect(removedPlan.status).toBe(501);
		expect(removedPlan.headers.get("content-type")).toContain("application/json");
		expect(await removedPlan.json()).toEqual(
			expect.objectContaining({
				name: "UnknownError",
				data: expect.objectContaining({ message: "Unsupported OMP agent: plan" }),
			}),
		);

		const promptFlow = (await fakeRpcRequests(requestLogFile)).filter(
			request => request.type === "set_thinking_level" || request.type === "prompt",
		);
		expect(promptFlow).toEqual([
			{ type: "set_thinking_level", level: "high" },
			{ type: "prompt", message: promptText, images: [] },
		]);
	});

	test("rejects legacy OpenCode routes and nested API aliases", async () => {
		const { baseUrl } = await startWebServer();
		const legacyPaths = [
			"/api/session",
			"/api/provider",
			"/api/omp/api/session",
			"/global/health",
			"/event",
		] as const;

		for (const pathname of legacyPaths) {
			const response = await fetch(`${baseUrl}${pathname}`);
			await expectUnsupportedRoute(response, "GET", pathname);
		}
	});

	test("rejects unsupported global API mutations and API reference writes with structured JSON errors", async () => {
		const { baseUrl } = await startWebServer();
		const configPatch = { model: "fixture/should-not-echo", mustNotEcho: "config patch" };
		const requests = [
			{ method: "PATCH", pathname: "/api/omp/global/config" },
			{ method: "POST", pathname: "/api/omp/global/dispose" },
			{ method: "POST", pathname: "/api/omp/reference" },
		] as const;

		for (const request of requests) {
			const response = await fetch(`${baseUrl}${request.pathname}`, {
				method: request.method,
				...(request.method === "PATCH"
					? {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(configPatch),
						}
					: {}),
			});
			const error = await expectUnsupportedRoute(response, request.method, request.pathname);

			if (request.method === "PATCH") expect(error).not.toEqual(expect.objectContaining(configPatch));
		}
	});

	test("returns the OMP configuration from the global config API", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/global/config`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expect.objectContaining({ agent: "build", autoupdate: false }));
	});

	test("returns an empty MCP resource catalog from the experimental API", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/experimental/resource`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	});

	test("returns an empty API reference catalog", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/reference`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: [] });
	});

	test("keeps unknown API-like paths out of the SPA fallback", async () => {
		const { app, baseUrl } = await startWebServer();
		await fs.writeFile(
			path.join(app.options.staticDirectory, "index.html"),
			"<!doctype html><title>SPA fallback</title>",
		);

		const response = await fetch(`${baseUrl}/api/not-real`, { headers: { Accept: "text/html" } });

		expect(response.headers.get("content-type")).not.toContain("text/html");
		await expectUnsupportedRoute(response, "GET", "/api/not-real");
	});

	test("forwards scoped plugin reads and enablement through canonical OMP RPC", async () => {
		const { baseUrl, requestLogFile } = await startManagementWebServer();
		const selector = { id: "scoped-plugin", kind: "npm", scope: "project" };
		const expectedPlugin = {
			...selector,
			name: "Scoped plugin",
			version: "1.0.0",
			enabled: true,
		};

		const listed = await fetch(`${baseUrl}/api/omp/admin/plugins`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual([expectedPlugin]);

		const updated = await fetch(`${baseUrl}/api/omp/admin/plugins`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plugin: selector, enabled: false }),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual([{ ...expectedPlugin, enabled: false }]);

		for (const malformed of [
			{ plugin: { ...selector, scope: "native" }, enabled: false },
			{ plugin: selector, enabled: "false" },
		]) {
			const response = await fetch(`${baseUrl}/api/omp/admin/plugins`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(malformed),
			});
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
		}

		expect(await managementRequests(requestLogFile)).toEqual([
			{ type: "get_plugins" },
			{ type: "set_plugin_enabled", plugin: selector, enabled: false },
		]);
	});

	test("bridges the OMP keybinding catalog, one persisted override, and reset through canonical routes", async () => {
		const { baseUrl, requestLogFile } = await startManagementWebServer();
		const catalogResponse = await fetch(`${baseUrl}/api/omp/admin/keybindings/catalog`);
		expect(catalogResponse.status).toBe(200);
		const catalog = await catalogResponse.json();
		expect({
			version: catalog.version,
			groups: catalog.groups,
			keybindings: catalog.keybindings.map((keybinding: { id: string; label: string; group: string }) => ({
				id: keybinding.id,
				label: keybinding.label,
				group: keybinding.group,
			})),
		}).toEqual({
			version: 1,
			groups: [{ id: "application", label: "Application" }],
			keybindings: [
				{ id: "app.interrupt", label: "Interrupt current operation", group: "application" },
				{ id: "app.clear", label: "Clear screen or cancel", group: "application" },
			],
		});

		const initialResponse = await fetch(`${baseUrl}/api/omp/admin/keybindings`);
		expect(initialResponse.status).toBe(200);
		const initial = (await initialResponse.json()) as {
			version: number;
			values: Record<string, string[]>;
			configured: string[];
		};
		expect(initial.version).toBe(1);
		expect(Object.keys(initial.values).sort()).toEqual(["app.clear", "app.interrupt"]);

		const override = ["ctrl+i"];
		const expectedOverride = {
			...initial,
			values: { ...initial.values, "app.interrupt": override },
			configured: [...new Set([...initial.configured, "app.interrupt"])],
		};
		const updated = await fetch(`${baseUrl}/api/omp/admin/keybindings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keybinding: "app.interrupt", keys: override }),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual(expectedOverride);

		const persisted = await fetch(`${baseUrl}/api/omp/admin/keybindings`);
		expect(persisted.status).toBe(200);
		expect(await persisted.json()).toEqual(expectedOverride);

		const reset = await fetch(`${baseUrl}/api/omp/admin/keybindings`, { method: "DELETE" });
		expect(reset.status).toBe(200);
		expect(await reset.json()).toEqual(initial);

		const restored = await fetch(`${baseUrl}/api/omp/admin/keybindings`);
		expect(restored.status).toBe(200);
		expect(await restored.json()).toEqual(initial);

		for (const pathname of ["/api/admin/keybindings/catalog", "/api/admin/keybindings"] as const) {
			const response = await fetch(`${baseUrl}${pathname}`);
			await expectUnsupportedRoute(response, "GET", pathname);
		}

		expect(await managementRequests(requestLogFile)).toEqual([
			{ type: "get_keybindings_catalog" },
			{ type: "get_keybindings" },
			{ type: "update_keybinding", keybinding: "app.interrupt", keys: override },
			{ type: "get_keybindings" },
			{ type: "reset_keybindings" },
			{ type: "get_keybindings" },
		]);
	});

	test("forwards catalog locale alongside directory and rejects unsupported locales before RPC", async () => {
		const markerRoot = await temporaryRoot();
		const startMarkerFile = path.join(markerRoot, "management-rpc-started");
		const { baseUrl, requestLogFile } = await startManagementWebServer({ startMarkerFile });
		const directory = path.join(path.dirname(requestLogFile), "catalog-scope");
		await fs.mkdir(directory);
		const catalogUrl = (pathname: string, locale: string) =>
			`${baseUrl}${pathname}?${new URLSearchParams({ locale, directory })}`;

		for (const locale of ["fr", "zh"] as const) {
			for (const pathname of ["/api/omp/admin/settings/catalog", "/api/omp/admin/keybindings/catalog"] as const) {
				const response = await fetch(catalogUrl(pathname, locale));
				expect(response.status).toBe(400);
				expect(response.headers.get("content-type")).toContain("application/json");
			}
		}
		expect(await managementRequests(requestLogFile)).toEqual([]);
		expect(await Bun.file(startMarkerFile).exists()).toBe(false);

		const settingsCatalog = await fetch(catalogUrl("/api/omp/admin/settings/catalog", "zh-CN"));
		expect(settingsCatalog.status).toBe(200);
		expect(await settingsCatalog.json()).toEqual(expect.objectContaining({ locale: "zh-CN" }));
		expect(await Bun.file(startMarkerFile).exists()).toBe(true);

		const scopedSessions = await fetch(`${baseUrl}/api/omp/session?${new URLSearchParams({ directory })}`);
		expect(scopedSessions.status).toBe(200);
		expect(await scopedSessions.json()).toContainEqual(expect.objectContaining({ directory }));

		const keybindingsCatalog = await fetch(catalogUrl("/api/omp/admin/keybindings/catalog", "en"));
		expect(keybindingsCatalog.status).toBe(200);

		const keybindingsScopedSessions = await fetch(`${baseUrl}/api/omp/session?${new URLSearchParams({ directory })}`);
		expect(keybindingsScopedSessions.status).toBe(200);
		expect(await keybindingsScopedSessions.json()).toContainEqual(expect.objectContaining({ directory }));

		expect(await managementRequests(requestLogFile)).toEqual([
			{ type: "get_settings_catalog", locale: "zh-CN" },
			{ type: "get_keybindings_catalog", locale: "en" },
		]);
	});

	test("maps OMP MCP management and transport routes to canonical scoped RPC commands", async () => {
		const { baseUrl, requestLogFile } = await startManagementWebServer();
		const listed = await fetch(`${baseUrl}/api/omp/admin/mcp`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "remote server", scope: "project", enabled: true }),
				expect.objectContaining({ name: "user-server", scope: "user", enabled: true }),
			]),
		);

		const updated = await fetch(`${baseUrl}/api/omp/admin/mcp`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "user-server", enabled: false }),
		});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toContainEqual(
			expect.objectContaining({ name: "user-server", enabled: false, status: "disabled" }),
		);

		const created = await fetch(`${baseUrl}/api/omp/admin/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "added-server",
				scope: "project",
				config: {
					type: "stdio",
					command: "  fixture-command  ",
					args: ["--stdio"],
					env: { FIXTURE: "enabled" },
				},
			}),
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toContainEqual(
			expect.objectContaining({ name: "added-server", scope: "project", transport: "stdio", enabled: true }),
		);

		const removed = await fetch(`${baseUrl}/api/omp/admin/mcp`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "added-server", scope: "project" }),
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).not.toContainEqual(
			expect.objectContaining({ name: "added-server", scope: "project" }),
		);

		for (const action of ["connect", "disconnect"] as const) {
			const response = await fetch(`${baseUrl}/api/omp/mcp/${encodeURIComponent("remote server")}/${action}`, {
				method: "POST",
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toBe(true);
		}

		for (const malformed of [
			{ method: "PATCH", body: { name: "user-server", enabled: "false" } },
			{
				method: "POST",
				body: { name: "invalid-server", scope: "project", config: { type: "stdio", command: "tool", args: [1] } },
			},
			{ method: "DELETE", body: { name: "user-server", scope: "native" } },
		] as const) {
			const response = await fetch(`${baseUrl}/api/omp/admin/mcp`, {
				method: malformed.method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(malformed.body),
			});
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("application/json");
		}

		expect(await managementRequests(requestLogFile)).toEqual([
			{ type: "get_mcp_servers" },
			{ type: "set_mcp_server_enabled", name: "user-server", enabled: false },
			{
				type: "add_mcp_server",
				name: "added-server",
				scope: "project",
				config: {
					type: "stdio",
					command: "fixture-command",
					args: ["--stdio"],
					env: { FIXTURE: "enabled" },
				},
			},
			{ type: "remove_mcp_server", name: "added-server", scope: "project" },
			{ type: "set_mcp_server_enabled", name: "remote server", enabled: true },
			{ type: "set_mcp_server_enabled", name: "remote server", enabled: false },
		]);
	});

	test("returns the OMP terminal shell catalog", async () => {
		const { baseUrl } = await startWebServer();
		const response = await fetch(`${baseUrl}/api/omp/pty/shells`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	test("streams a terminal child and reports it as exited after the PTY WebSocket closes", async () => {
		const child = terminalFixture();
		const { app, baseUrl } = await startWebServer();
		const createdResponse = await fetch(`${baseUrl}/api/omp/pty`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				command: child.command,
				args: child.args,
				cwd: app.options.rootDirectory,
			}),
		});
		expect(createdResponse.status).toBe(200);
		const created = (await createdResponse.json()) as { id: string };

		const ticketResponse = await fetch(`${baseUrl}/api/omp/pty/${encodeURIComponent(created.id)}/connect-token`);
		expect(ticketResponse.status).toBe(200);
		const { ticket } = (await ticketResponse.json()) as { ticket: string };
		const socket = new WebSocket(
			`${baseUrl.replace(/^http/, "ws")}/api/omp/pty/${encodeURIComponent(created.id)}/connect?ticket=${encodeURIComponent(ticket)}`,
		);
		sockets.add(socket);
		await withLiveIoTimeout(waitForOpen(socket), "opening PTY WebSocket");

		const closed = collectTextUntilClose(socket);
		const output = waitForText(socket, "bridge-output:hello");
		socket.send("hello\n");
		await withLiveIoTimeout(output, "streaming terminal child output");
		socket.send("exit\n");
		const terminal = await withLiveIoTimeout(closed, "terminal child exit");

		expect(terminal.text).toContain("bridge-output:hello");
		expect(terminal.code).toBe(1000);
		const ptysResponse = await fetch(`${baseUrl}/api/omp/pty`);
		expect(ptysResponse.status).toBe(200);
		const ptys = (await ptysResponse.json()) as Array<{ id: string; status: string }>;
		expect(ptys).toContainEqual(expect.objectContaining({ id: created.id, status: "exited" }));
		expect(app.store.listEvents()).toContainEqual(
			expect.objectContaining({
				directory: app.options.rootDirectory,
				payload: { type: "pty.exited", properties: { id: created.id, exitCode: 23 } },
			}),
		);
	});

	test("serves generated-client trailing-slash message lists and persisted message reads", async () => {
		const userMessageID = "generated-client-message";
		const textPartID = "generated-client-message-text";
		const promptText = "generated client trailing slash prompt";
		const responseText = "generated client trailing slash response";
		const { baseUrl } = await startWebServer([
			{
				role: "user",
				timestamp: 10,
				content: [{ type: "text", text: promptText }],
			},
			{
				role: "assistant",
				timestamp: 11,
				duration: 1,
				model: "model",
				provider: "provider",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				content: [{ type: "text", text: responseText }],
			},
		]);

		const createdResponse = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(createdResponse.status).toBe(200);
		const { id: sessionID } = (await createdResponse.json()) as { id: string };
		const messagePath = `/api/omp/session/${encodeURIComponent(sessionID)}/message`;
		const promptResponse = await fetch(`${baseUrl}${messagePath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: userMessageID,
				parts: [{ id: textPartID, type: "text", text: promptText }],
			}),
		});
		expect(promptResponse.status).toBe(200);

		const canonicalResponse = await fetch(`${baseUrl}${messagePath}`);
		const generatedClientResponse = await fetch(`${baseUrl}${messagePath}/`);
		expect(canonicalResponse.status).toBe(200);
		expect(generatedClientResponse.status).toBe(200);
		expect(generatedClientResponse.headers.get("content-type")).toContain("application/json");

		const canonicalMessages = await canonicalResponse.json();
		const generatedClientMessages = (await generatedClientResponse.json()) as Array<{
			info: { id: string; role: string };
			parts: unknown[];
		}>;
		expect(generatedClientMessages).toEqual(canonicalMessages);
		expect(generatedClientMessages).toEqual([
			expect.objectContaining({
				info: expect.objectContaining({ id: userMessageID, sessionID, role: "user" }),
				parts: [
					expect.objectContaining({ id: textPartID, messageID: userMessageID, type: "text", text: promptText }),
				],
			}),
			expect.objectContaining({
				info: expect.objectContaining({ sessionID, role: "assistant", parentID: userMessageID }),
				parts: [expect.objectContaining({ type: "text", text: responseText })],
			}),
		]);

		const persistedMessage = generatedClientMessages.find(message => message.info.role === "assistant");
		if (!persistedMessage) throw new Error("Fixture assistant message was not persisted");
		const singleMessageResponse = await fetch(
			`${baseUrl}${messagePath}/${encodeURIComponent(persistedMessage.info.id)}`,
		);
		expect(singleMessageResponse.status).toBe(200);
		expect(singleMessageResponse.headers.get("content-type")).toContain("application/json");
		expect(await singleMessageResponse.json()).toEqual(
			expect.objectContaining({
				info: expect.objectContaining({
					id: persistedMessage.info.id,
					sessionID,
					role: "assistant",
					parentID: userMessageID,
				}),
				parts: expect.arrayContaining([
					expect.objectContaining({
						messageID: persistedMessage.info.id,
						type: "text",
						text: responseText,
					}),
				]),
			}),
		);
	});

	test("keeps consecutive assistant transcript messages parented to the user message", async () => {
		const userMessageID = "consecutive-assistant-user-message";
		const textPartID = "consecutive-assistant-user-text";
		const promptText = "consecutive assistant prompt";
		const firstResponseText = "first assistant response";
		const secondResponseText = "second assistant response";
		const { baseUrl } = await startWebServer([
			{
				role: "user",
				timestamp: 10,
				content: [{ type: "text", text: promptText }],
			},
			{
				role: "assistant",
				timestamp: 11,
				duration: 1,
				model: "model",
				provider: "provider",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				content: [{ type: "text", text: firstResponseText }],
			},
			{
				role: "assistant",
				timestamp: 12,
				duration: 1,
				model: "model",
				provider: "provider",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				content: [{ type: "text", text: secondResponseText }],
			},
		]);

		const createdResponse = await fetch(`${baseUrl}/api/omp/session`, { method: "POST" });
		expect(createdResponse.status).toBe(200);
		const { id: sessionID } = (await createdResponse.json()) as { id: string };
		const messagePath = `/api/omp/session/${encodeURIComponent(sessionID)}/message`;
		const promptResponse = await fetch(`${baseUrl}${messagePath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: userMessageID,
				parts: [{ id: textPartID, type: "text", text: promptText }],
			}),
		});
		expect(promptResponse.status).toBe(200);

		const messagesResponse = await fetch(`${baseUrl}${messagePath}`);
		expect(messagesResponse.status).toBe(200);
		const messages = (await messagesResponse.json()) as Array<{
			info: { id: string; role: string; parentID?: string };
			parts: Array<{ type: string; text?: string }>;
		}>;
		const assistantMessages = messages.filter(message => message.info.role === "assistant");
		expect(assistantMessages).toHaveLength(2);
		const [firstAssistant, secondAssistant] = assistantMessages;
		if (!firstAssistant || !secondAssistant) throw new Error("Fixture did not produce both assistant messages");

		expect(firstAssistant.parts).toEqual([expect.objectContaining({ type: "text", text: firstResponseText })]);
		expect(secondAssistant.parts).toEqual([expect.objectContaining({ type: "text", text: secondResponseText })]);
		expect(firstAssistant.info.parentID).toBe(userMessageID);
		expect(secondAssistant.info.parentID).toBe(userMessageID);
		expect([firstAssistant.info.parentID, secondAssistant.info.parentID]).not.toContain(firstAssistant.info.id);
		expect([firstAssistant.info.parentID, secondAssistant.info.parentID]).not.toContain(secondAssistant.info.id);
	});

	test("preserves client prompt IDs in persisted messages and bridge events", async () => {
		if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
		const root = await temporaryRoot();
		const sessionID = "prompt-identity-session";
		const sessionFile = path.join(root, "prompt-identity.jsonl");
		const rpcServerFile = path.join(root, "prompt-identity-rpc.mjs");
		const messageID = "client-user-message";
		const textPartID = "client-user-text";
		await Promise.all([
			fs.writeFile(sessionFile, ""),
			fs.writeFile(
				rpcServerFile,
				fakeRpcServer(sessionID, sessionFile, [
					{
						role: "user",
						timestamp: 10,
						content: [{ type: "text", text: "client question" }],
					},
					{
						role: "assistant",
						timestamp: 11,
						duration: 1,
						model: "model",
						provider: "provider",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						stopReason: "stop",
						content: [{ type: "text", text: "assistant answer" }],
					},
				]),
			),
		]);
		const store = await DurableStore.open(path.join(root, "sessions.sqlite"));
		let session: RpcWebSession | undefined;
		try {
			session = await RpcWebSession.start(store, {
				directory: root,
				projectID: "project_prompt_identity",
				sessionPath: sessionFile,
				command: [bunExecutable, rpcServerFile],
			});

			await session.prompt("client question", undefined, { messageID, textPartID, imagePartIDs: [] });

			const persisted = store.listMessages(session.id);
			expect(persisted).toContainEqual(
				expect.objectContaining({
					id: messageID,
					data: expect.objectContaining({
						info: expect.objectContaining({ id: messageID, role: "user" }),
						parts: [
							expect.objectContaining({
								id: textPartID,
								messageID,
								type: "text",
								text: "client question",
							}),
						],
					}),
				}),
			);
			expect(persisted).toContainEqual(
				expect.objectContaining({
					data: expect.objectContaining({
						info: expect.objectContaining({ role: "assistant", parentID: messageID }),
					}),
				}),
			);

			const events = store.listEvents(0, session.id);
			expect(events).toContainEqual(
				expect.objectContaining({
					payload: expect.objectContaining({
						type: "message.updated",
						properties: expect.objectContaining({
							info: expect.objectContaining({ id: messageID, role: "user" }),
						}),
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					payload: expect.objectContaining({
						type: "message.part.updated",
						properties: expect.objectContaining({
							part: expect.objectContaining({
								id: textPartID,
								messageID,
								type: "text",
								text: "client question",
							}),
						}),
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					payload: expect.objectContaining({
						type: "message.updated",
						properties: expect.objectContaining({
							info: expect.objectContaining({ role: "assistant", parentID: messageID }),
						}),
					}),
				}),
			);
		} finally {
			await session?.close();
			store.close();
		}
	});
	test("removes the legacy SQLite session row when a resumed OMP session reports a new id", async () => {
		if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
		const root = await temporaryRoot();
		const legacyID = "legacy-session-id";
		const actualID = "omp-remapped-session-id";
		const legacySessionFile = path.join(root, "legacy.jsonl");
		const actualSessionFile = path.join(root, "actual.jsonl");
		const rpcServerFile = path.join(root, "fake-rpc-server.mjs");
		await Promise.all([
			fs.writeFile(legacySessionFile, ""),
			fs.writeFile(actualSessionFile, ""),
			fs.writeFile(rpcServerFile, fakeRpcServer(actualID, actualSessionFile)),
		]);
		const store = await DurableStore.open(path.join(root, "sessions.sqlite"));
		const registry = new SessionRegistry(store, {
			rootDirectory: root,
			command: [bunExecutable, rpcServerFile],
		});
		registries.add(registry);
		store.upsertSession({
			id: legacyID,
			projectID: registry.project(root).id,
			directory: root,
			sessionPath: legacySessionFile,
			title: "Persisted session",
			createdAt: 1,
			updatedAt: 1,
		});

		const resumed = await withLiveIoTimeout(registry.activate(legacyID), "resuming persisted OMP session");

		expect(resumed?.id).toBe(actualID);
		expect(store.getSession(legacyID)).toBeUndefined();
		expect((await registry.list(root)).map(session => session.id)).toEqual([actualID]);
	});
	test("keeps persisted session metadata and status cold", async () => {
		if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-server-"));
		const rpcStartMarkerFile = path.join(os.tmpdir(), `omp-web-rpc-started-${crypto.randomUUID()}`);
		let app: OmpWebServer | undefined;
		try {
			const sessionID = "persisted-idle-session";
			const sessionFile = path.join(root, "persisted-idle-session.jsonl");
			const rpcCommandFile = path.join(root, "persisted-session-rpc.mjs");
			await Promise.all([
				fs.writeFile(sessionFile, ""),
				fs.writeFile(
					rpcCommandFile,
					fakeRpcServer(sessionID, sessionFile, [], { startMarkerFile: rpcStartMarkerFile }),
				),
			]);
			app = await OmpWebServer.create({
				hostname: "127.0.0.1",
				port: 0,
				rootDirectory: root,
				staticDirectory: root,
				databaseFile: path.join(root, "state.sqlite"),
				command: [bunExecutable, rpcCommandFile],
			});
			app.store.upsertSession({
				id: sessionID,
				projectID: app.sessions.project(root).id,
				directory: root,
				sessionPath: sessionFile,
				title: "Persisted inactive session",
				createdAt: 1,
				updatedAt: 1,
			});

			const listener = app.start();
			const baseUrl = `http://127.0.0.1:${listener.port}`;
			const metadata = await fetch(`${baseUrl}/api/omp/session/${encodeURIComponent(sessionID)}`);
			expect(metadata.status).toBe(200);
			expect(await metadata.json()).toEqual(
				expect.objectContaining({ id: sessionID, title: "Persisted inactive session", version: "omp" }),
			);
			expect(await Bun.file(rpcStartMarkerFile).exists()).toBe(false);

			const inactiveStatus = await fetch(`${baseUrl}/api/omp/session/status`);
			expect(inactiveStatus.status).toBe(200);
			const inactiveStatuses = (await inactiveStatus.json()) as Record<string, { type: string }>;
			expect(inactiveStatuses).not.toHaveProperty(sessionID);
			expect(await Bun.file(rpcStartMarkerFile).exists()).toBe(false);
		} finally {
			try {
				await app?.stop();
			} finally {
				await Promise.all([
					fs.rm(root, { recursive: true, force: true }),
					fs.rm(rpcStartMarkerFile, { force: true }),
				]);
			}
		}
	});

	test("discovers a canonical OMP JSONL globally under its header cwd project", async () => {
		const root = await temporaryRoot();
		const projectDirectory = path.join(root, "canonical-project");
		const sessionDirectory = path.join(root, "isolated-canonical-sessions");
		const sessionID = "global-canonical-omp-session";
		const sessionFile = path.join(sessionDirectory, `${sessionID}.jsonl`);
		await Promise.all([fs.mkdir(projectDirectory), fs.mkdir(sessionDirectory)]);
		await fs.writeFile(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionID,
				timestamp: "2026-08-17T00:00:00.000Z",
				cwd: projectDirectory,
				title: "Global canonical OMP fixture",
			})}\n`,
		);
		const app = await OmpWebServer.create({
			hostname: "127.0.0.1",
			port: 0,
			rootDirectory: root,
			staticDirectory: root,
			databaseFile: path.join(root, "state.sqlite"),
			sessionDir: sessionDirectory,
		});
		servers.add(app);
		const listener = app.start();
		const baseUrl = `http://127.0.0.1:${listener.port}`;

		const listed = await fetch(`${baseUrl}/api/omp/session`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual([
			expect.objectContaining({
				id: sessionID,
				projectID: app.sessions.project(projectDirectory).id,
				directory: projectDirectory,
				title: "Global canonical OMP fixture",
				version: "omp",
			}),
		]);

		const server = { url: baseUrl };
		const api = createOmpApi({
			current: createOmpApiTransportForServer({ server }),
			transport: directory => createOmpTransportForServer({ server, directory, throwOnError: true }),
		});
		expect(await api.session.list({ limit: 5_000, order: "desc" })).toEqual({
			data: [
				expect.objectContaining({
					id: sessionID,
					projectID: app.sessions.project(projectDirectory).id,
					title: "Global canonical OMP fixture",
					location: expect.objectContaining({ directory: projectDirectory }),
					cost: 0,
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
					time: {
						created: new Date("2026-08-17T00:00:00.000Z").getTime(),
						updated: expect.any(Number),
					},
				}),
			],
			cursor: {},
		});
	});

	test("discovers and deletes a canonical OMP JSONL session with its artifacts", async () => {
		if (!bunExecutable) throw new Error("Bun executable is required for bridge fixtures");
		const root = await temporaryRoot();
		const sessionID = "canonical-omp-session";
		const sessionDirectory = path.join(root, "canonical-session-fixtures");
		const sessionFile = path.join(sessionDirectory, `${sessionID}.jsonl`);
		const artifactsDirectory = sessionFile.slice(0, -6);
		const artifactFile = path.join(artifactsDirectory, "artifact.txt");
		const rpcServerFile = path.join(root, "canonical-session-rpc.mjs");
		await fs.mkdir(artifactsDirectory, { recursive: true });
		await Promise.all([
			fs.writeFile(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sessionID,
					timestamp: "2026-08-17T00:00:00.000Z",
					cwd: root,
					title: "Canonical OMP fixture",
				})}\n`,
			),
			fs.writeFile(artifactFile, "fixture artifact"),
			fs.writeFile(rpcServerFile, fakeRpcServer(sessionID, sessionFile)),
		]);
		const app = await OmpWebServer.create({
			hostname: "127.0.0.1",
			port: 0,
			rootDirectory: root,
			staticDirectory: root,
			databaseFile: path.join(root, "state.sqlite"),
			command: [bunExecutable, rpcServerFile],
			sessionDir: sessionDirectory,
		});
		servers.add(app);
		const listener = app.start();
		const baseUrl = `http://127.0.0.1:${listener.port}`;

		const listed = await fetch(`${baseUrl}/api/omp/session?directory=${encodeURIComponent(root)}`);
		expect(listed.status).toBe(200);
		expect(await listed.json()).toContainEqual(
			expect.objectContaining({ id: sessionID, title: "Canonical OMP fixture", version: "omp" }),
		);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(artifactFile).exists()).toBe(true);

		const deleted = await fetch(`${baseUrl}/api/omp/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toBe(true);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await Bun.file(artifactFile).exists()).toBe(false);
	});

	test("rejects concurrent state database ownership and releases it when stopped", async () => {
		const root = await temporaryRoot();
		const options = {
			hostname: "127.0.0.1",
			port: 0,
			rootDirectory: root,
			staticDirectory: root,
			databaseFile: path.join(root, "state.sqlite"),
		};
		const first = await OmpWebServer.create(options);
		servers.add(first);

		await expect(
			OmpWebServer.create(options).then(server => {
				servers.add(server);
				return server;
			}),
		).rejects.toThrow(/OMP Web state is already owned by another server/);

		await first.stop();
		servers.delete(first);
		const replacement = await OmpWebServer.create(options);
		servers.add(replacement);
	});
});
