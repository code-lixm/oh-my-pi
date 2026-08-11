import type { RlmChildRegistryEntry } from "../eval/rlm-types";

export interface RlmMessageAdapterRegistry {
	list(): RlmChildRegistryEntry[];
	get?(childId: string): RlmChildRegistryEntry | undefined;
	awaitPublication?(childId: string, signal?: AbortSignal): Promise<unknown>;
	refresh?(): Promise<void>;
}

export interface RlmMessageAdapterDeps {
	registry: RlmMessageAdapterRegistry;
	/** Current RLM agent; its registry contains only direct children. */
	ownerAgentId: string;
	/** Upstream parent for child-to-parent family messages. Omitted by the root agent. */
	parentAgentId?: string;
	/** Optional sibling projection from the parent's direct-child registry. */
	listSiblings?: () => RlmChildRegistryEntry[];
	/** Parent-owned sibling registry, including queued/running publication state. */
	siblingRegistry?: RlmMessageAdapterRegistry;
	sendToAgent: (
		agentId: string,
		message: string,
		mode: "steer" | "followUp",
	) => Promise<"delivered" | "queued" | "failed">;
	/** Record that this child sent its first explicit reply to its upstream parent. */
	markParentReply?: () => Promise<void>;
}

export type AgentMessageRole = "parent" | "sibling" | "child";

export interface AgentMessageSendOptions {
	receiverRole: AgentMessageRole;
	receiverName?: string;
	mode?: "auto" | "steer" | "follow_up";
}

export interface AgentMessageReceipt {
	deliveryStatus: "delivered" | "queued" | "failed";
	receiverId?: string;
}

export interface AgentMessageTarget {
	relationship: AgentMessageRole;
	name: string;
	id: string;
	status: string;
}

/**
 * RLM agent_message adapter.
 * Enforces nuclear-family reach ACL: parent, siblings, direct children only.
 */
export class RlmMessageAdapter {
	readonly #deps: RlmMessageAdapterDeps;

	constructor(deps: RlmMessageAdapterDeps) {
		this.#deps = deps;
	}

	async refresh(): Promise<void> {
		await Promise.all([this.#deps.registry.refresh?.(), this.#deps.siblingRegistry?.refresh?.()]);
	}

	listAgents(): AgentMessageTarget[] {
		const parent = this.#deps.parentAgentId;
		const directEntries = this.#deps.registry
			.list()
			.filter(entry => entry.rlm_child_id !== this.#deps.ownerAgentId && entry.rlm_child_id !== parent);
		const children = directEntries.map(entry => ({
			relationship: "child" as const,
			name: entry.session_name,
			id: entry.rlm_child_id,
			status: entry.status,
		}));
		const siblingEntries = this.#deps.siblingRegistry?.list() ?? this.#deps.listSiblings?.() ?? [];
		const siblings = siblingEntries
			.filter(
				entry =>
					entry.rlm_child_id !== this.#deps.ownerAgentId &&
					entry.rlm_child_id !== parent &&
					!directEntries.some(child => child.rlm_child_id === entry.rlm_child_id),
			)
			.map(entry => ({
				relationship: "sibling" as const,
				name: entry.session_name,
				id: entry.rlm_child_id,
				status: entry.status,
			}));
		return parent && parent !== this.#deps.ownerAgentId
			? [
					{
						relationship: "parent" as const,
						name: "parent",
						id: parent,
						status: "running",
					},
					...children,
					...siblings,
				]
			: [...children, ...siblings];
	}

	async send(message: string, options: AgentMessageSendOptions): Promise<AgentMessageReceipt> {
		if (!message.trim()) throw new Error("RLM agent_message message must be a non-empty string.");
		const target = this.#resolveTarget(options.receiverRole, options.receiverName);
		if (!target) return { deliveryStatus: "failed" };

		// RLM messages are steering interrupts. Follow-up mode could strand a
		// queued child behind its terminal turn and is intentionally not exposed.
		if (target.relationship !== "parent") {
			if (target.status === "failed" || target.status === "cancelled") {
				return { deliveryStatus: "failed", receiverId: target.id };
			}
			const registry = target.relationship === "sibling" ? this.#deps.siblingRegistry : this.#deps.registry;
			const entry = registry?.get?.(target.id);
			if (entry?.active_session_id === null && registry?.awaitPublication) {
				await registry.awaitPublication(target.id);
			}
		}
		const status = await this.#deps.sendToAgent(target.id, message, "steer");
		if (status !== "failed" && target.relationship === "parent") {
			await this.#deps.markParentReply?.();
		}
		return { deliveryStatus: status, receiverId: target.id };
	}

	async broadcast(message: string): Promise<AgentMessageReceipt[]> {
		const targets = this.listAgents().filter(target => target.relationship !== "parent");
		return await Promise.all(
			targets.map(async target => {
				try {
					return await this.send(message, { receiverRole: target.relationship, receiverName: target.name });
				} catch {
					return { deliveryStatus: "failed", receiverId: target.id };
				}
			}),
		);
	}

	#resolveTarget(role: AgentMessageRole, name?: string): AgentMessageTarget | undefined {
		const agents = this.listAgents().filter(agent => agent.relationship === role);
		if (!name) return agents[0];
		return agents.find(agent => agent.name === name || agent.id === name);
	}
}

export function createRlmMessageAdapter(deps: RlmMessageAdapterDeps): RlmMessageAdapter {
	return new RlmMessageAdapter(deps);
}
