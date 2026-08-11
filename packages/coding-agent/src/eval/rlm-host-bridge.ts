import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentMessageReceipt, AgentMessageRole, AgentMessageTarget } from "../irc/rlm-message-adapter";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { RlmChildRegistryEntry, RlmSpawnHandle } from "./rlm-types";

/** The only synthetic host wire name exposed by all eval runtimes. */
export const EVAL_RLM_BRIDGE_NAME = "__rlm__";

export interface RlmListSubagentsResult {
	subagents: Array<{
		rlm_child_id: string;
		name: string;
		session_dir: string;
		status: string;
		active_session_id: string | null;
	}>;
}

export interface RlmDeleteSubagentResult {
	rlm_child_id: string;
	name: string;
	deleted: true;
}

export interface RlmAgentMessageListResult {
	agents: AgentMessageTarget[];
}

export interface RlmAgentMessageBroadcastResult {
	deliveries: AgentMessageReceipt[];
}

export interface RlmBridgeCallOptions {
	session: ToolSession;
	signal?: AbortSignal;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ToolError(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new ToolError(`${label} must be a string`);
	return value.trim() || undefined;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new ToolError(`Unknown rlm() argument: ${key}`);
	}
}

function requireLifecycle(session: ToolSession) {
	const lifecycle = session.getRlmLifecycle?.();
	if (!lifecycle) throw new ToolError("RLM is not available in this session");
	return lifecycle;
}

async function runRlmSpawn(args: unknown, options: RlmBridgeCallOptions): Promise<RlmSpawnHandle> {
	const lifecycle = requireLifecycle(options.session);
	if (typeof args === "string") return await lifecycle.spawnChild(requireString(args, "prompt"), {});
	if (!isRecord(args)) throw new ToolError("rlm() requires a prompt string or an argument object");
	const op = args.op;
	if (op !== undefined && op !== "run") throw new ToolError(`Unknown rlm() op: ${String(op)}`);
	rejectUnknownKeys(args, ["op", "prompt", "name", "model"]);
	const prompt = requireString(args.prompt, "prompt");
	const name = optionalString(args.name, "name");
	const model = optionalString(args.model, "model");
	return await lifecycle.spawnChild(prompt, {
		...(name === undefined ? {} : { name }),
		...(model === undefined ? {} : { model }),
	});
}

async function runRlmList(args: unknown, options: RlmBridgeCallOptions): Promise<RlmListSubagentsResult> {
	const lifecycle = requireLifecycle(options.session);
	if (!isRecord(args)) throw new ToolError("list_subagents requires an argument object");
	rejectUnknownKeys(args, ["op"]);
	return {
		subagents: lifecycle.listChildren().map((child: RlmChildRegistryEntry) => ({
			rlm_child_id: child.rlm_child_id,
			name: child.session_name,
			session_dir: child.session_dir,
			status: child.status,
			active_session_id: child.active_session_id,
		})),
	};
}

async function runRlmDelete(args: unknown, options: RlmBridgeCallOptions): Promise<RlmDeleteSubagentResult> {
	const lifecycle = requireLifecycle(options.session);
	if (!isRecord(args)) throw new ToolError("delete_subagent requires an argument object");
	rejectUnknownKeys(args, ["op", "target"]);
	const target = requireString(args.target, "target");
	const child = lifecycle.listChildren().find(entry => entry.rlm_child_id === target || entry.session_name === target);
	await lifecycle.deleteChild(target);
	return { rlm_child_id: child?.rlm_child_id ?? target, name: child?.session_name ?? target, deleted: true };
}

function requireRole(value: unknown): AgentMessageRole {
	if (value === undefined || value === null) return "parent";
	if (value === "parent" || value === "sibling" || value === "child") return value;
	throw new ToolError("receiver_role must be parent, sibling, or child");
}

async function runRlmAgentMessage(
	args: unknown,
	options: RlmBridgeCallOptions,
): Promise<RlmAgentMessageListResult | AgentMessageReceipt | RlmAgentMessageBroadcastResult> {
	const lifecycle = requireLifecycle(options.session);
	if (!isRecord(args)) throw new ToolError("agent_message operation requires an argument object");
	const op = args.op;
	if (op === "agent_message.list_agents") {
		rejectUnknownKeys(args, ["op"]);
		if (!lifecycle.listAgents) throw new ToolError("RLM agent_message is not available in this session");
		await lifecycle.refreshAgents?.();
		return { agents: lifecycle.listAgents() };
	}
	if (op !== "agent_message.send") throw new ToolError(`Unknown rlm() op: ${String(op)}`);
	rejectUnknownKeys(args, ["op", "message", "receiver_role", "receiver_name", "target"]);
	const message = requireString(args.message, "message");
	const role = requireRole(args.receiver_role);
	const receiverName = optionalString(args.receiver_name, "receiver_name");
	const target = optionalString(args.target, "target");
	if (target !== undefined && target !== "all") throw new ToolError('target must be "all" when provided');
	if (target === "all") {
		if (role !== "parent" || receiverName !== undefined) {
			throw new ToolError('target "all" cannot be combined with receiver_role or receiver_name');
		}
		if (!lifecycle.broadcastMessage) throw new ToolError("RLM agent_message is not available in this session");
		return { deliveries: await lifecycle.broadcastMessage(message) };
	}
	if (role === "parent" && receiverName !== undefined) {
		throw new ToolError("receiver_name is not allowed when receiver_role is parent");
	}
	if (role !== "parent" && receiverName === undefined) {
		throw new ToolError("receiver_name is required for sibling and child messages");
	}
	if (!lifecycle.sendMessage) throw new ToolError("RLM agent_message is not available in this session");
	return await lifecycle.sendMessage(message, {
		receiverRole: role,
		...(receiverName === undefined ? {} : { receiverName }),
	});
}

export async function callRlmBridge(name: string, args: unknown, options: RlmBridgeCallOptions): Promise<unknown> {
	if (name !== EVAL_RLM_BRIDGE_NAME) throw new ToolError(`Unknown RLM bridge: ${name}`);
	if (isRecord(args)) {
		const op = args.op;
		if (op === "list_subagents") return await runRlmList(args, options);
		if (op === "delete_subagent") return await runRlmDelete(args, options);
		if (op === "agent_message.list_agents" || op === "agent_message.send")
			return await runRlmAgentMessage(args, options);
	}
	return await runRlmSpawn(args, options);
}
