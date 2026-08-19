import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionRegistry } from "./session-registry";

function projectCost(cost: Model["cost"]) {
	return {
		input: cost.input,
		output: cost.output,
		cache: { read: cost.cacheRead, write: cost.cacheWrite },
		...(cost.longContext
			? {
					tiers: [
						{
							input: cost.longContext.input,
							output: cost.longContext.output,
							cache: { read: cost.longContext.cacheRead, write: cost.longContext.cacheWrite },
							tier: { type: "context" as const, size: cost.longContext.inputThreshold },
						},
					],
				}
			: {}),
	};
}

function variants(reasoning: boolean, efforts: readonly string[] | undefined) {
	if (!reasoning) return {};
	return Object.fromEntries(["off", "auto", ...(efforts ?? [])].map(level => [level, {}]));
}

function projectLsp(value: unknown, root: string) {
	if (!Array.isArray(value)) return [];
	return value.flatMap(value => {
		const server =
			value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
		if (!server) return [];
		const name = typeof server.name === "string" ? server.name : undefined;
		const id = typeof server.id === "string" ? server.id : name;
		const status =
			server.status === "connected" || server.status === "ready"
				? "connected"
				: server.status === "error"
					? "error"
					: undefined;
		if (!id || !name || !status) return [];
		return [{ id, name, root: typeof server.root === "string" ? server.root : root, status }];
	});
}

export class ModelService {
	readonly #registry: SessionRegistry;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
	}

	async providers(directory?: string) {
		const models = await this.#registry.models(directory);
		const byProvider = new Map<string, typeof models>();
		for (const model of models) {
			const list = byProvider.get(model.provider) ?? [];
			list.push(model);
			byProvider.set(model.provider, list);
		}
		const all = Array.from(byProvider, ([providerID, providerModels]) => ({
			id: providerID,
			name: providerID,
			models: Object.fromEntries(
				providerModels.map(model => [
					model.id,
					{
						id: model.id,
						providerID: model.provider,
						...(model.api !== undefined && model.baseUrl !== undefined
							? { api: { id: model.api, url: model.baseUrl } }
							: {}),
						name: model.name ?? model.id,
						capabilities: {
							temperature: model.compat?.supportsSamplingParams === true,
							reasoning: model.reasoning,
							attachment: model.input?.includes("image") ?? false,
							toolcall: model.supportsTools === true,
							input: {
								text: model.input?.includes("text") ?? false,
								audio: false,
								image: model.input?.includes("image") ?? false,
								video: false,
								pdf: false,
							},
							output: { text: true, audio: false, image: false, video: false, pdf: false },
							interleaved: false,
						},
						...(model.cost ? { cost: projectCost(model.cost) } : {}),
						limit: {
							context: model.contextWindow ?? 0,
							output: model.maxTokens ?? 0,
						},
						variants: variants(model.reasoning, model.thinking?.efforts),
					},
				]),
			),
		}));
		const session = await this.#registry.ensureDefault(directory);
		const state = await session.client.getState();
		const defaultModels = state.model ? { [state.model.provider]: state.model.id } : {};
		return { all, default: defaultModels, connected: all.map(provider => provider.id) };
	}

	async agents(directory?: string) {
		const session = await this.#registry.ensureDefault(directory);
		const state = await session.client.getState();
		const tools = Object.fromEntries((state.dumpTools ?? []).map(tool => [tool.name, true]));
		return [
			{
				name: "build",
				description: "OMP coding agent",
				mode: "primary",
				builtIn: true,
				permission: { edit: "allow", bash: { "*": "allow" }, webfetch: "allow" },
				model: state.model ? { providerID: state.model.provider, modelID: state.model.id } : undefined,
				variant: state.configuredThinkingLevel ?? state.thinkingLevel,
				tools,
				options: {},
			},
		];
	}

	async commands(directory?: string) {
		const commands = await this.#registry.commands(directory);
		return commands.map(command => ({
			name: command.name,
			description: command.description,
			template: `/${command.name} $ARGUMENTS`,
			subtask: false,
		}));
	}

	async mcp(directory?: string) {
		const session = await this.#registry.ensureDefault(directory);
		const servers = await session.client.getMcpServers();
		return Object.fromEntries(
			servers.map(server => {
				if (!server.enabled) return [server.name, { status: "disabled" as const }];
				if (server.status === "connected") return [server.name, { status: "connected" as const }];
				if (server.status === "connecting") return [server.name, { status: "pending" as const }];
				return [server.name, { status: "failed" as const, error: server.status }];
			}),
		);
	}

	async lsp(directory?: string) {
		const session = await this.#registry.ensureDefault(directory);
		const state = await session.client.getState();
		return projectLsp(state.lsp, session.directory);
	}
}
