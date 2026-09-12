import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { withReadOnlyBashTool } from "../../src/advisor/read-only-bash";

const bashSchema = type({ command: "string" });

function createTool(name: string) {
	let executions = 0;
	const result = { content: [{ type: "text" as const, text: "ran" }] };
	const tool: AgentTool<typeof bashSchema> = {
		name,
		label: name,
		description: "test tool",
		parameters: bashSchema,
		execute: async () => {
			executions++;
			return result;
		},
	};

	return { executions: () => executions, result, tool };
}

describe("withReadOnlyBashTool", () => {
	it("returns a non-bash tool unchanged", () => {
		const { tool } = createTool("read");

		expect(withReadOnlyBashTool(tool)).toBe(tool);
	});

	it("runs a provably read-only bash command and passes through its result", async () => {
		const { executions, result, tool } = createTool("bash");
		const wrapped = withReadOnlyBashTool(tool);

		const received = await wrapped.execute("call-id", { command: "git status" });

		expect(received).toBe(result);
		expect(executions()).toBe(1);
	});

	it.each([
		["a mutating command", { command: "git commit -m x" }],
		["a missing command", {}],
		["a non-string command", { command: 42 }],
	])("rejects %s without running the original bash tool", async (_case, args) => {
		const { executions, tool } = createTool("bash");
		const wrapped = withReadOnlyBashTool(tool);

		const result = await wrapped.execute("call-id", args as never);

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("read-only") }]);
		expect(executions()).toBe(0);
	});
});
