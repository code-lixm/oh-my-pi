import { describe, expect, it, vi } from "bun:test";
import { callRlmBridge, EVAL_RLM_BRIDGE_NAME } from "../../src/eval/rlm-host-bridge";
import type { RlmChildRegistryEntry } from "../../src/eval/rlm-types";
import type { AgentMessageReceipt, AgentMessageTarget } from "../../src/irc/rlm-message-adapter";
import type { RlmChildLifecycle } from "../../src/prime-integration/contracts";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "../../src/tools/tool-errors";

const CHILD: RlmChildRegistryEntry = {
	rlm_child_id: "child-1",
	active_session_id: "sess-1",
	session_id: "sess-1",
	session_name: "worker",
	session_dir: "/tmp/artifacts/rlm/child-1",
	status: "completed",
};

function fakeLifecycle(overrides: Partial<RlmChildLifecycle> = {}): RlmChildLifecycle {
	return {
		spawnChild: vi.fn(async (_prompt: string, options: { name?: string; model?: string }) => ({
			rlm_child_id: "child-1",
			name: options.name ?? "worker",
			session_dir: "/tmp/artifacts/rlm/child-1",
			model: options.model ?? "provider/model",
		})),
		listChildren: vi.fn((): RlmChildRegistryEntry[] => [CHILD]),
		deleteChild: vi.fn(async () => {}),
		listAgents: vi.fn((): AgentMessageTarget[] => [
			{ relationship: "parent", name: "parent", id: "parent-1", status: "running" },
			{ relationship: "child", name: "worker", id: "child-1", status: "completed" },
		]),
		sendMessage: vi.fn(
			async (_message: string): Promise<AgentMessageReceipt> => ({
				deliveryStatus: "delivered",
				receiverId: "child-1",
			}),
		),
		broadcastMessage: vi.fn(
			async (): Promise<AgentMessageReceipt[]> => [{ deliveryStatus: "delivered", receiverId: "child-1" }],
		),
		...overrides,
	};
}

function sessionWith(lifecycle: RlmChildLifecycle): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getRlmLifecycle: () => lifecycle,
	} as ToolSession;
}

describe("RLM host bridge", () => {
	it("exposes the single unified synthetic host wire name", () => {
		expect(EVAL_RLM_BRIDGE_NAME).toBe("__rlm__");
	});

	it("spawns via __rlm__ with a bare prompt", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(EVAL_RLM_BRIDGE_NAME, "do the thing", { session: sessionWith(lifecycle) });
		expect(lifecycle.spawnChild).toHaveBeenCalledWith("do the thing", {});
		expect(result).toEqual({
			rlm_child_id: "child-1",
			name: "worker",
			session_dir: "/tmp/artifacts/rlm/child-1",
			model: "provider/model",
		});
	});

	it("spawns via __rlm__ with {op:'run'} plus name/model", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "run", prompt: "do it", name: "assistant", model: "other/model" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.spawnChild).toHaveBeenCalledWith("do it", { name: "assistant", model: "other/model" });
		expect(result).toMatchObject({ rlm_child_id: "child-1", name: "assistant" });
	});

	it("rejects empty prompts and unknown keys", async () => {
		const lifecycle = fakeLifecycle();
		const session = sessionWith(lifecycle);
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, "  ", { session })).rejects.toThrow(ToolError);
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, { prompt: "x", extra: 1 }, { session })).rejects.toThrow(
			/Unknown rlm\(\) argument: extra/,
		);
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "run", extra: 1 }, { session })).rejects.toThrow(
			/Unknown rlm\(\) argument: extra/,
		);
		expect(lifecycle.spawnChild).not.toHaveBeenCalled();
	});

	it("rejects unknown ops on the unified wire", async () => {
		const lifecycle = fakeLifecycle();
		const session = sessionWith(lifecycle);
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "fly", prompt: "x" }, { session })).rejects.toThrow(
			/Unknown rlm\(\) op: fly/,
		);
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "list" }, { session })).rejects.toThrow(
			/Unknown rlm\(\) op: list/,
		);
		expect(lifecycle.spawnChild).not.toHaveBeenCalled();
	});

	it("lists direct children via op:list_subagents", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "list_subagents" },
			{ session: sessionWith(lifecycle) },
		);
		expect(result).toEqual({
			subagents: [
				{
					rlm_child_id: "child-1",
					name: "worker",
					session_dir: "/tmp/artifacts/rlm/child-1",
					status: "completed",
					active_session_id: "sess-1",
				},
			],
		});
		expect(lifecycle.listChildren).toHaveBeenCalledTimes(1);
	});

	it("rejects unknown keys on list_subagents", async () => {
		const lifecycle = fakeLifecycle();
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "list_subagents", extra: 1 }, { session: sessionWith(lifecycle) }),
		).rejects.toThrow(/Unknown rlm\(\) argument: extra/);
		expect(lifecycle.listChildren).not.toHaveBeenCalled();
	});

	it("deletes via op:delete_subagent with a child id", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "delete_subagent", target: "child-1" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.deleteChild).toHaveBeenCalledWith("child-1");
		expect(result).toEqual({ rlm_child_id: "child-1", name: "worker", deleted: true });
	});

	it("deletes via op:delete_subagent resolving the target name from the registry", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "delete_subagent", target: "worker" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.deleteChild).toHaveBeenCalledWith("worker");
		expect(result).toEqual({ rlm_child_id: "child-1", name: "worker", deleted: true });
	});

	it("rejects unknown keys and empty targets on delete_subagent", async () => {
		const lifecycle = fakeLifecycle();
		const session = sessionWith(lifecycle);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "delete_subagent", target: "x", extra: 1 }, { session }),
		).rejects.toThrow(/Unknown rlm\(\) argument: extra/);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "delete_subagent", target: "  " }, { session }),
		).rejects.toThrow(ToolError);
		expect(lifecycle.deleteChild).not.toHaveBeenCalled();
	});

	it("lists agents via agent_message.list_agents", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "agent_message.list_agents" },
			{ session: sessionWith(lifecycle) },
		);
		expect(result).toEqual({
			agents: [
				{ relationship: "parent", name: "parent", id: "parent-1", status: "running" },
				{ relationship: "child", name: "worker", id: "child-1", status: "completed" },
			],
		});
		expect(lifecycle.listAgents).toHaveBeenCalledTimes(1);
	});

	it("sends a parent-directed message via agent_message.send", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "agent_message.send", message: "hello parent" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.sendMessage).toHaveBeenCalledWith("hello parent", { receiverRole: "parent" });
		expect(result).toEqual({ deliveryStatus: "delivered", receiverId: "child-1" });
	});

	it("sends a named child message via agent_message.send", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "agent_message.send", message: "hi", receiver_role: "child", receiver_name: "worker" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.sendMessage).toHaveBeenCalledWith("hi", {
			receiverRole: "child",
			receiverName: "worker",
		});
		expect(result).toEqual({ deliveryStatus: "delivered", receiverId: "child-1" });
	});

	it("broadcasts to all children via target:'all'", async () => {
		const lifecycle = fakeLifecycle();
		const result = await callRlmBridge(
			EVAL_RLM_BRIDGE_NAME,
			{ op: "agent_message.send", message: "everyone", target: "all" },
			{ session: sessionWith(lifecycle) },
		);
		expect(lifecycle.broadcastMessage).toHaveBeenCalledWith("everyone");
		expect(lifecycle.sendMessage).not.toHaveBeenCalled();
		expect(result).toEqual({ deliveries: [{ deliveryStatus: "delivered", receiverId: "child-1" }] });
	});

	it("rejects ACL-invalid agent_message.send combinations", async () => {
		const lifecycle = fakeLifecycle();
		const session = sessionWith(lifecycle);
		// target:"all" is a broadcast and cannot carry receiver fields.
		await expect(
			callRlmBridge(
				EVAL_RLM_BRIDGE_NAME,
				{ op: "agent_message.send", message: "x", target: "all", receiver_role: "child" },
				{ session },
			),
		).rejects.toThrow(/target "all" cannot be combined with receiver_role or receiver_name/);
		await expect(
			callRlmBridge(
				EVAL_RLM_BRIDGE_NAME,
				{ op: "agent_message.send", message: "x", target: "all", receiver_name: "worker" },
				{ session },
			),
		).rejects.toThrow(/target "all" cannot be combined with receiver_role or receiver_name/);
		// Parent messages cannot name a receiver.
		await expect(
			callRlmBridge(
				EVAL_RLM_BRIDGE_NAME,
				{ op: "agent_message.send", message: "x", receiver_role: "parent", receiver_name: "worker" },
				{ session },
			),
		).rejects.toThrow(/receiver_name is not allowed when receiver_role is parent/);
		// Sibling/child messages require a receiver name.
		await expect(
			callRlmBridge(
				EVAL_RLM_BRIDGE_NAME,
				{ op: "agent_message.send", message: "x", receiver_role: "child" },
				{ session },
			),
		).rejects.toThrow(/receiver_name is required for sibling and child messages/);
		// Unknown receiver roles and non-"all" targets are rejected.
		await expect(
			callRlmBridge(
				EVAL_RLM_BRIDGE_NAME,
				{ op: "agent_message.send", message: "x", receiver_role: "cousin" },
				{ session },
			),
		).rejects.toThrow(/receiver_role must be parent, sibling, or child/);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "agent_message.send", message: "x", target: "worker" }, { session }),
		).rejects.toThrow(/target must be "all" when provided/);
		expect(lifecycle.sendMessage).not.toHaveBeenCalled();
		expect(lifecycle.broadcastMessage).not.toHaveBeenCalled();
	});

	it("fails closed when agent_message is unsupported by the lifecycle", async () => {
		const lifecycle = fakeLifecycle({
			listAgents: undefined,
			sendMessage: undefined,
			broadcastMessage: undefined,
		});
		const session = sessionWith(lifecycle);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "agent_message.list_agents" }, { session }),
		).rejects.toThrow(/RLM agent_message is not available in this session/);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "agent_message.send", message: "x" }, { session }),
		).rejects.toThrow(/RLM agent_message is not available in this session/);
		await expect(
			callRlmBridge(EVAL_RLM_BRIDGE_NAME, { op: "agent_message.send", message: "x", target: "all" }, { session }),
		).rejects.toThrow(/RLM agent_message is not available in this session/);
	});

	it("fails closed when no lifecycle is installed", async () => {
		const session = { cwd: "/tmp", hasUI: false, getSessionFile: () => null } as ToolSession;
		await expect(callRlmBridge(EVAL_RLM_BRIDGE_NAME, "x", { session })).rejects.toThrow(/RLM is not available/);
	});

	it("rejects unknown wire names before touching the lifecycle", async () => {
		const lifecycle = fakeLifecycle();
		await expect(callRlmBridge("__rlm_unknown__", {}, { session: sessionWith(lifecycle) })).rejects.toThrow(
			/Unknown RLM bridge/,
		);
		expect(lifecycle.spawnChild).not.toHaveBeenCalled();
	});
});
