import { describe, expect, it } from "bun:test";
import { AgentRegistry, resolveTopLevelAgent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function register(registry: AgentRegistry, input: { id: string; kind: "main" | "sub"; parentId?: string }) {
	return registry.register({
		...input,
		displayName: input.id,
		session: {} as AgentSession,
		status: "idle",
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
