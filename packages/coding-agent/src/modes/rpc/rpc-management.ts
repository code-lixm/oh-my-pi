import * as path from "node:path";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../../capability";
import { type MCPServer, mcpCapability } from "../../capability/mcp";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { PluginManager } from "../../extensibility/plugins/manager";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import type { InstalledPlugin, PluginSettingSchema } from "../../extensibility/plugins/types";
import { loadAllMCPConfigs } from "../../mcp/config";
import {
	addMCPServer,
	readDisabledServers,
	readEnabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setMcpServerEnabled,
} from "../../mcp/config-writer";
import type { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";
import type {
	RpcMcpServerConfigInput,
	RpcMcpServerInfo,
	RpcPluginInfo,
	RpcPluginSelector,
	RpcPluginSettingInfo,
} from "./rpc-management-types";
import type { RpcSettingValue } from "./rpc-settings-types";

function settingScalar(value: unknown): RpcSettingValue | undefined {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function pluginSettingInfo(
	key: string,
	schema: PluginSettingSchema,
	values: Record<string, unknown>,
): RpcPluginSettingInfo {
	const configured = Object.hasOwn(values, key);
	const current = schema.secret ? undefined : settingScalar(values[key]);
	const defaultValue = schema.secret ? undefined : settingScalar(schema.default);
	return {
		key,
		type: schema.type,
		...(schema.description ? { description: schema.description } : {}),
		secret: schema.secret === true,
		configured,
		...(current !== undefined ? { value: current } : {}),
		...(defaultValue !== undefined ? { defaultValue } : {}),
		...(schema.type === "enum" ? { values: [...schema.values] } : {}),
		...(schema.type === "number" && schema.min !== undefined ? { min: schema.min } : {}),
		...(schema.type === "number" && schema.max !== undefined ? { max: schema.max } : {}),
		...(schema.type === "number" && schema.step !== undefined ? { step: schema.step } : {}),
	};
}

function validatePluginSetting(schema: PluginSettingSchema, value: RpcSettingValue): void {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") throw new Error("Plugin setting must be a string");
			return;
		case "boolean":
			if (typeof value !== "boolean") throw new Error("Plugin setting must be a boolean");
			return;
		case "enum":
			if (typeof value !== "string" || !schema.values.includes(value)) {
				throw new Error(`Plugin setting must be one of: ${schema.values.join(", ")}`);
			}
			return;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Plugin setting must be a number");
			if (schema.min !== undefined && value < schema.min)
				throw new Error(`Plugin setting must be at least ${schema.min}`);
			if (schema.max !== undefined && value > schema.max)
				throw new Error(`Plugin setting must be at most ${schema.max}`);
			return;
	}
}

function mcpTransport(server: Pick<MCPServer, "transport" | "url">): RpcMcpServerInfo["transport"] {
	if (server.transport) return server.transport;
	return server.url ? "http" : "stdio";
}

export interface RpcManagementControllerOptions {
	session: AgentSession;
	mcpManager?: MCPManager;
	onPluginsChanged: () => Promise<void>;
}

/** Canonical OMP management operations exposed to trusted RPC hosts. */
export class RpcManagementController {
	readonly #session: AgentSession;
	readonly #mcpManager: MCPManager | undefined;
	readonly #onPluginsChanged: () => Promise<void>;

	constructor(options: RpcManagementControllerOptions) {
		this.#session = options.session;
		this.#mcpManager = options.mcpManager;
		this.#onPluginsChanged = options.onPluginsChanged;
	}

	#plugins(): PluginManager {
		return new PluginManager(this.#session.sessionManager.getCwd());
	}

	async #marketplaceManager(): Promise<MarketplaceManager> {
		const cwd = this.#session.sessionManager.getCwd();
		return new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
	}

	async plugins(): Promise<RpcPluginInfo[]> {
		const manager = this.#plugins();
		const [npmPlugins, marketplacePlugins] = await Promise.all([
			manager.list(),
			this.#marketplaceManager().then(marketplace => marketplace.listInstalledPlugins()),
		]);
		const npm = await Promise.all(npmPlugins.map(plugin => this.#npmPluginInfo(manager, plugin)));
		const marketplace: RpcPluginInfo[] = marketplacePlugins.map(plugin => ({
			id: plugin.id,
			name: plugin.id,
			version: plugin.entries[0]?.version ?? "unknown",
			kind: "marketplace",
			scope: plugin.scope,
			enabled: plugin.entries[0]?.enabled !== false,
			...(plugin.shadowedBy ? { shadowedBy: plugin.shadowedBy } : {}),
		}));
		return [...npm, ...marketplace].sort((left, right) => left.name.localeCompare(right.name));
	}

	async #npmPluginInfo(manager: PluginManager, plugin: InstalledPlugin): Promise<RpcPluginInfo> {
		const values = await manager.getPluginSettings(plugin.name);
		const enabledFeatures = new Set(plugin.enabledFeatures ?? []);
		return {
			id: plugin.name,
			name: plugin.manifest.name ?? plugin.name,
			version: plugin.version,
			...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
			kind: "npm",
			scope: "global",
			enabled: plugin.enabled,
			features: Object.entries(plugin.manifest.features ?? {}).map(([id, feature]) => ({
				id,
				...(feature.description ? { description: feature.description } : {}),
				enabled: plugin.enabledFeatures === null ? feature.default === true : enabledFeatures.has(id),
			})),
			settings: Object.entries(plugin.manifest.settings ?? {}).map(([key, schema]) =>
				pluginSettingInfo(key, schema, values),
			),
		};
	}

	async setPluginEnabled(plugin: RpcPluginSelector, enabled: boolean): Promise<RpcPluginInfo[]> {
		if (plugin.kind === "npm") {
			await this.#plugins().setEnabled(plugin.id, enabled);
		} else {
			if (plugin.scope !== "user" && plugin.scope !== "project") {
				throw new Error(`Invalid marketplace plugin scope: ${plugin.scope}`);
			}
			const manager = await this.#marketplaceManager();
			await manager.setPluginEnabled(plugin.id, enabled, plugin.scope);
		}
		await this.#onPluginsChanged();
		return this.plugins();
	}

	async setPluginFeatures(name: string, features: string[]): Promise<RpcPluginInfo[]> {
		const manager = this.#plugins();
		const plugin = (await manager.list()).find(item => item.name === name);
		if (!plugin) throw new Error(`Plugin not found: ${name}`);
		const declared = plugin.manifest.features ?? {};
		for (const feature of features) {
			if (!Object.hasOwn(declared, feature)) throw new Error(`Unknown feature "${feature}" in ${name}`);
		}
		await manager.setEnabledFeatures(name, features);
		await this.#onPluginsChanged();
		return this.plugins();
	}

	async setPluginSetting(name: string, key: string, value: RpcSettingValue): Promise<RpcPluginInfo[]> {
		const manager = this.#plugins();
		const plugin = (await manager.list()).find(item => item.name === name);
		const schema = plugin?.manifest.settings?.[key];
		if (!plugin || !schema) throw new Error(`Unknown plugin setting: ${name}.${key}`);
		validatePluginSetting(schema, value);
		await manager.setPluginSetting(name, key, value);
		await this.#onPluginsChanged();
		return this.plugins();
	}

	async mcpServers(): Promise<RpcMcpServerInfo[]> {
		const cwd = this.#session.sessionManager.getCwd();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);
		const [loaded, disabled, forced] = await Promise.all([
			loadCapability<MCPServer>(mcpCapability.id, { cwd, includeDisabled: true }),
			readDisabledServers(userPath).then(names => new Set(names)),
			readEnabledServers(userPath).then(names => new Set(names)),
		]);
		const servers = loaded.items.map(server => {
			const enabled = !disabled.has(server.name) && (server.enabled !== false || forced.has(server.name));
			const runtime = this.#mcpManager?.getConnectionStatus(server.name) ?? "disconnected";
			const sourcePath = path.resolve(server._source.path);
			return {
				name: server.name,
				enabled,
				status: enabled ? runtime : "disabled",
				transport: mcpTransport(server),
				scope: server._source.level,
				source: server._source.providerName,
				removable: sourcePath === path.resolve(userPath) || sourcePath === path.resolve(projectPath),
			} satisfies RpcMcpServerInfo;
		});
		return servers.sort((left, right) => left.name.localeCompare(right.name));
	}

	async setMcpServerEnabled(name: string, enabled: boolean): Promise<RpcMcpServerInfo[]> {
		const cwd = this.#session.sessionManager.getCwd();
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", cwd),
			projectPath: getMCPConfigPath("project", cwd),
			name,
			enabled,
		});
		if (this.#mcpManager) {
			if (enabled) {
				const loaded = await loadAllMCPConfigs(cwd);
				const config = loaded.configs[name];
				if (!config) throw new Error(`MCP server not found after enabling: ${name}`);
				await this.#mcpManager.connectServers({ [name]: config }, { [name]: loaded.sources[name]! });
			} else {
				await this.#mcpManager.disconnectServer(name);
			}
			await this.#session.refreshMCPTools(this.#mcpManager.getTools());
		}
		return this.mcpServers();
	}

	async addMcpServer(
		name: string,
		scope: "user" | "project",
		input: RpcMcpServerConfigInput,
	): Promise<RpcMcpServerInfo[]> {
		const cwd = this.#session.sessionManager.getCwd();
		const config: MCPServerConfig =
			input.type === "stdio"
				? { type: "stdio", command: input.command, args: input.args, env: input.env }
				: { type: input.type, url: input.url, headers: input.headers };
		await addMCPServer(getMCPConfigPath(scope, cwd), name, config);
		return this.setMcpServerEnabled(name, true);
	}

	async removeMcpServer(name: string, scope: "user" | "project"): Promise<RpcMcpServerInfo[]> {
		const cwd = this.#session.sessionManager.getCwd();
		const targetPath = getMCPConfigPath(scope, cwd);
		const config = await readMCPConfigFile(targetPath);
		if (!config.mcpServers?.[name]) throw new Error(`MCP server "${name}" is not owned by OMP ${scope} config`);
		await removeMCPServer(targetPath, name);
		if (this.#mcpManager) {
			await this.#mcpManager.disconnectServer(name);
			await this.#session.refreshMCPTools(this.#mcpManager.getTools());
		}
		return this.mcpServers();
	}
}
