import { afterEach, describe, expect, it, vi } from "bun:test";
import { RpcSessionEventCoalescer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type ToolUpdate = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

function toolUpdate(toolCallId: string, text: string, isError?: true): ToolUpdate {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: {},
		partialResult: {
			content: [{ type: "text", text }],
			...(isError ? { isError } : {}),
		},
	};
}

function toolEnd(toolCallId: string, text: string): ToolEnd {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { content: [{ type: "text", text }] },
		isError: false,
	};
}

describe("RpcSessionEventCoalescer", () => {
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("delivers only the newest normal update in a tool-call burst", () => {
		vi.useFakeTimers();
		const delivered: AgentSessionEvent[] = [];
		const coalescer = new RpcSessionEventCoalescer(event => delivered.push(event));
		const first = toolUpdate("call-1", "first snapshot");
		const middle = toolUpdate("call-1", "middle snapshot");
		const latest = toolUpdate("call-1", "latest snapshot");

		coalescer.emit(first);
		coalescer.emit(middle);
		coalescer.emit(latest);

		expect(delivered).toEqual([]);
		vi.runAllTimers();
		expect(delivered).toEqual([latest]);

		coalescer.dispose();
	});

	it("flushes a pending update before its terminal end", () => {
		vi.useFakeTimers();
		const delivered: AgentSessionEvent[] = [];
		const coalescer = new RpcSessionEventCoalescer(event => delivered.push(event));
		const pending = toolUpdate("call-1", "latest before end");
		const end = toolEnd("call-1", "terminal result");

		coalescer.emit(pending);
		coalescer.emit(end);

		expect(delivered).toEqual([pending, end]);
		vi.runAllTimers();
		expect(delivered).toEqual([pending, end]);

		coalescer.dispose();
	});

	it("immediately flushes pending normal updates and forwards an error partial", () => {
		vi.useFakeTimers();
		const delivered: AgentSessionEvent[] = [];
		const coalescer = new RpcSessionEventCoalescer(event => delivered.push(event));
		const pending = toolUpdate("call-1", "latest before error");
		const error = toolUpdate("call-1", "error partial", true);

		coalescer.emit(pending);
		expect(delivered).toEqual([]);

		coalescer.emit(error);
		expect(delivered).toEqual([pending, error]);
		vi.runAllTimers();
		expect(delivered).toEqual([pending, error]);

		coalescer.dispose();
	});

	it("immediately forwards a truthy third-party error partial to consumers", () => {
		vi.useFakeTimers();
		const delivered: AgentSessionEvent[] = [];
		const coalescer = new RpcSessionEventCoalescer(event => delivered.push(event));
		const pending = toolUpdate("call-1", "latest before third-party error");
		const error = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
			partialResult: {
				content: [{ type: "text", text: "third-party error partial" }],
				isError: "third-party failure",
			},
		} as unknown as ToolUpdate;

		coalescer.emit(pending);
		expect(delivered).toEqual([]);

		coalescer.emit(error);
		expect(delivered).toEqual([pending, error]);
		vi.advanceTimersByTime(33);
		expect(delivered).toEqual([pending, error]);

		coalescer.dispose();
	});
});
