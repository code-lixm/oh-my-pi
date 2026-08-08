import { describe, expect, it } from "bun:test";
import {
	type AgentKind,
	AgentRegistry,
	type AgentStatus,
	resolveTopLevelAgent,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function register(registry: AgentRegistry, input: { id: string; kind: "main" | "sub"; parentId?: string }) {
	return registry.register({
		...input,
		displayName: input.id,
		session: {} as AgentSession,
		status: "idle",
	});
}

function registerAgent(
	registry: AgentRegistry,
	input: { id: string; kind: AgentKind; status: AgentStatus; parentId?: string },
) {
	return registry.register({
		...input,
		displayName: input.id,
		session: null,
	});
}

describe("resolveTopLevelAgent", () => {
	it("resolves descendants to their actual Main or secondary main owner", () => {
		const registry = new AgentRegistry();
		const main = register(registry, { id: "Main", kind: "main" });
		const secondary = register(registry, { id: "top-level:review", kind: "main" });
		register(registry, { id: "main-child", kind: "sub", parentId: main.id });
		register(registry, { id: "review-parent", kind: "sub", parentId: secondary.id });
		register(registry, { id: "review-child", kind: "sub", parentId: "review-parent" });

		expect(resolveTopLevelAgent(registry, "main-child")).toBe(main);
		expect(resolveTopLevelAgent(registry, "review-child")).toBe(secondary);
	});

	it("fails closed for missing and cyclic parent chains", () => {
		const registry = new AgentRegistry();
		register(registry, { id: "Main", kind: "main" });
		register(registry, { id: "orphan", kind: "sub", parentId: "missing" });
		register(registry, { id: "cycle-a", kind: "sub", parentId: "cycle-b" });
		register(registry, { id: "cycle-b", kind: "sub", parentId: "cycle-a" });

		expect(resolveTopLevelAgent(registry, "orphan")).toBeUndefined();
		expect(resolveTopLevelAgent(registry, "cycle-a")).toBeUndefined();
	});
});

describe("AgentRegistry running subagent count", () => {
	it("counts only running subagents across status transitions and unregister", () => {
		const registry = new AgentRegistry();
		registerAgent(registry, { id: "Main", kind: "main", status: "running" });
		registerAgent(registry, { id: "Advisor", kind: "advisor", status: "running" });
		const worker = registerAgent(registry, { id: "Worker", kind: "sub", status: "idle" });

		expect(registry.getRunningSubagentCount()).toBe(0);

		const transitions: Array<[AgentStatus, number]> = [
			["running", 1],
			["waiting", 0],
			["running", 1],
			["idle", 0],
			["running", 1],
			["parked", 0],
			["running", 1],
			["aborted", 0],
		];
		for (const [status, expectedCount] of transitions) {
			expect(registry.setStatus(worker.id, status)).toBe(true);
			expect(registry.getRunningSubagentCount()).toBe(expectedCount);
		}

		const removable = registerAgent(registry, { id: "Removable", kind: "sub", status: "running" });
		expect(registry.getRunningSubagentCount()).toBe(1);
		expect(registry.unregister(removable.id)).toBe(true);
		expect(registry.getRunningSubagentCount()).toBe(0);
	});

	it("reconciles same-id replacement generations in the running count", () => {
		const registry = new AgentRegistry();

		registerAgent(registry, { id: "Worker", kind: "sub", status: "running" });
		expect(registry.getRunningSubagentCount()).toBe(1);

		registerAgent(registry, { id: "Worker", kind: "sub", status: "idle" });
		expect(registry.getRunningSubagentCount()).toBe(0);

		registerAgent(registry, { id: "Worker", kind: "main", status: "running" });
		expect(registry.getRunningSubagentCount()).toBe(0);

		registerAgent(registry, { id: "Worker", kind: "sub", status: "running" });
		expect(registry.getRunningSubagentCount()).toBe(1);
	});

	it("leaves the count unchanged by metadata and activity updates", () => {
		const registry = new AgentRegistry();
		const worker = registerAgent(registry, { id: "Worker", kind: "sub", status: "running" });
		const metadata = {
			displayName: "Registry audit worker",
			sessionTitle: "Agent count investigation",
			sessionFile: "/sessions/registry-audit.jsonl",
		};

		expect(registry.getRunningSubagentCount()).toBe(1);
		expect(registry.updateMetadata(worker.id, metadata)).toBe(true);
		expect(registry.getRunningSubagentCount()).toBe(1);
		registry.setActivity(worker.id, "Reconciling live work");
		expect(registry.getRunningSubagentCount()).toBe(1);
		expect(
			registry.setActivityState(worker.id, {
				phase: "tool",
				label: "Inspecting registry",
				phaseStartedAtMs: 100,
				lastActivityAtMs: 110,
			}),
		).toBe(true);
		expect(registry.getRunningSubagentCount()).toBe(1);
		expect(registry.updateMetadata(worker.id, metadata)).toBe(true);
		expect(registry.getRunningSubagentCount()).toBe(1);
	});
});
describe("AgentRegistry terminal status", () => {
	it("retains the task outcome through idle and parked, then clears it for a fresh run", () => {
		const registry = new AgentRegistry();
		const worker = registerAgent(registry, { id: "Worker", kind: "sub", status: "running" });

		expect(registry.setTerminalStatus(worker.id, "completed", worker)).toBe(true);
		expect(registry.setStatus(worker.id, "idle", worker)).toBe(true);
		expect(worker.status).toBe("idle");
		expect(worker.terminalStatus).toBe("completed");

		expect(registry.setStatus(worker.id, "parked", worker)).toBe(true);
		expect(worker.status).toBe("parked");
		expect(worker.terminalStatus).toBe("completed");

		expect(registry.setStatus(worker.id, "running", worker)).toBe(true);
		expect(worker.status).toBe("running");
		expect(worker.terminalStatus).toBeUndefined();
	});

	it("pins a hard-aborted generation to the aborted terminal outcome", () => {
		const registry = new AgentRegistry();
		const worker = registerAgent(registry, { id: "Worker", kind: "sub", status: "running" });

		expect(registry.setTerminalStatus(worker.id, "completed", worker)).toBe(true);
		expect(registry.setStatus(worker.id, "aborted", worker)).toBe(true);
		expect(worker.status).toBe("aborted");
		expect(worker.terminalStatus).toBe("aborted");
		expect(registry.setTerminalStatus(worker.id, "failed", worker)).toBe(false);
		expect(registry.setStatus(worker.id, "running", worker)).toBe(false);
		expect(worker.status).toBe("aborted");
		expect(worker.terminalStatus).toBe("aborted");
	});
});
