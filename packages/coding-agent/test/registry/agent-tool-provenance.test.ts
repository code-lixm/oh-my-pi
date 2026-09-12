import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Minimal session double: only the provenance accessor the registry snapshots. */
function sessionWith(builtIn: string[]): AgentSession {
	return { getBuiltInToolNames: () => builtIn } as unknown as AgentSession;
}

describe("AgentRef built-in tool provenance", () => {
	it("snapshots a live session's provenance and keeps it after the session detaches", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "sub:a", displayName: "a", kind: "sub", session: sessionWith(["grep", "read"]) });
		expect(registry.get("sub:a")?.builtInToolNames).toEqual(["grep", "read"]);

		registry.detachSession("sub:a");

		expect(registry.get("sub:a")?.session).toBeNull();
		expect(registry.get("sub:a")?.builtInToolNames).toEqual(["grep", "read"]);
	});

	it("keeps a same-named extension tool off the built-in list", () => {
		const registry = new AgentRegistry();
		// The session's own answer already excludes the shadowed built-in name.
		registry.register({ id: "sub:b", displayName: "b", kind: "sub", session: sessionWith(["read"]) });
		registry.detachSession("sub:b");

		const snapshot = registry.get("sub:b")?.builtInToolNames ?? [];
		expect(snapshot).not.toContain("grep");
		expect(snapshot).toContain("read");
	});

	it("uses persisted provenance when restoring an agent with no live session", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "sub:c",
			displayName: "c",
			kind: "sub",
			session: null,
			builtInToolNames: ["grep"],
		});

		expect(registry.get("sub:c")?.builtInToolNames).toEqual(["grep"]);
	});

	it("stays unknown when neither a session nor persisted provenance exists", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "sub:d", displayName: "d", kind: "sub", session: null });

		expect(registry.get("sub:d")?.builtInToolNames).toBeUndefined();
	});

	it("does not erase restored provenance when a session without the accessor attaches", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "sub:e",
			displayName: "e",
			kind: "sub",
			session: null,
			builtInToolNames: ["grep"],
		});

		registry.attachSession("sub:e", {} as unknown as AgentSession);

		expect(registry.get("sub:e")?.builtInToolNames).toEqual(["grep"]);
	});

	it("refreshes the snapshot on detach so lazily registered built-ins are captured", () => {
		const registry = new AgentRegistry();
		let builtIn = ["grep"];
		const session = { getBuiltInToolNames: () => builtIn } as unknown as AgentSession;
		registry.register({ id: "sub:f", displayName: "f", kind: "sub", session });
		expect(registry.get("sub:f")?.builtInToolNames).toEqual(["grep"]);

		// A built-in registered after the session attached (lazy write/goal/…).
		builtIn = ["grep", "write"];
		registry.detachSession("sub:f");

		expect(registry.get("sub:f")?.builtInToolNames).toEqual(["grep", "write"]);
	});
});
