import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import { $which } from "@oh-my-pi/pi-utils";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { PYTHON_PRELUDE } from "../../src/eval/py/prelude";

/**
 * The eval RLM façade (`rlm`, `agent_message`) must emit the exact unified
 * `__rlm__` wire payloads — `op` plus snake_case fields — through the host
 * bridge. These tests run the shipped prelude verbatim against a bridge spy,
 * so a façade that renames a field, drops an option, or targets the wrong
 * synthetic host reddens here.
 */

function loadJsPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

describe("eval JS RLM façade wire", () => {
	it("rlm() sends {op:'run', prompt, name?, model?} to __rlm__", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadJsPrelude(async (name, args) => {
			calls.push({ name, args });
			return { rlm_child_id: "c-1", name: "w", session_dir: "/tmp/d", model: "m" };
		});

		await vm.runInContext(`rlm("do it")`, sandbox);
		await vm.runInContext(`rlm("do it", { name: "assistant", model: "provider/x" })`, sandbox);

		expect(calls).toEqual([
			{ name: "__rlm__", args: { op: "run", prompt: "do it" } },
			{ name: "__rlm__", args: { op: "run", prompt: "do it", name: "assistant", model: "provider/x" } },
		]);
	});

	it("rlm.list_subagents sends {op:'list_subagents'} to __rlm__", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadJsPrelude(async (name, args) => {
			calls.push({ name, args });
			return { subagents: [] };
		});

		await vm.runInContext(`rlm.list_subagents()`, sandbox);
		expect(calls).toEqual([{ name: "__rlm__", args: { op: "list_subagents" } }]);
	});

	it("rlm.delete_subagent sends {op:'delete_subagent', target} to __rlm__", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadJsPrelude(async (name, args) => {
			calls.push({ name, args });
			return { rlm_child_id: "c-1", name: "w", deleted: true };
		});

		await vm.runInContext(`rlm.delete_subagent("c-1")`, sandbox);
		expect(calls).toEqual([{ name: "__rlm__", args: { op: "delete_subagent", target: "c-1" } }]);
	});

	it("agent_message.send forwards receiver_role/receiver_name/target as snake_case", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadJsPrelude(async (name, args) => {
			calls.push({ name, args });
			return { deliveryStatus: "delivered" };
		});

		await vm.runInContext(`agent_message.send("hi")`, sandbox);
		await vm.runInContext(`agent_message.send("hi", { receiver_role: "child", receiver_name: "w" })`, sandbox);
		await vm.runInContext(`agent_message.send("hi", { target: "all" })`, sandbox);
		await vm.runInContext(`agent_message.list_agents()`, sandbox);

		expect(calls).toEqual([
			{ name: "__rlm__", args: { op: "agent_message.send", message: "hi" } },
			{
				name: "__rlm__",
				args: { op: "agent_message.send", message: "hi", receiver_role: "child", receiver_name: "w" },
			},
			{ name: "__rlm__", args: { op: "agent_message.send", message: "hi", target: "all" } },
			{ name: "__rlm__", args: { op: "agent_message.list_agents" } },
		]);
	});

	it("agent_message.send rejects unknown option keys", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadJsPrelude(async (name, args) => {
			calls.push({ name, args });
			return { deliveryStatus: "delivered" };
		});

		expect(async () => await vm.runInContext(`agent_message.send("hi", { receiverRole: "child" })`, sandbox)).toThrow(
			/Unknown agent_message.send\(\) argument: receiverRole/,
		);
		expect(calls).toEqual([]);
	});
});

const HAS_PYTHON = Boolean($which("python3") || $which("python"));
const HAS_RUBY = Boolean($which("ruby"));

describe.skipIf(!HAS_PYTHON)("eval Python RLM façade wire", () => {
	it("rlm/agent_message send the exact __rlm__ payloads through the bridge", async () => {
		// Runs the shipped Python prelude in a real interpreter against a
		// bridge spy that records the raw `(name, args)` pairs the façade
		// issues. `_bridge_call` is module-global, so overriding it in the
		// namespace after load captures every façade call.
		const bridgeRecorder = `
def __rlm_recorder(name, args):
    __rlm_calls.append((name, dict(args)))
    if args.get("op") == "run":
        return {"rlm_child_id": "c-1", "name": "w", "session_dir": "/tmp/d", "model": "m"}
    if args.get("op") == "list_subagents":
        return {"subagents": []}
    if args.get("op") == "delete_subagent":
        return {"rlm_child_id": "c-1", "name": "w", "deleted": True}
    if args.get("op") == "agent_message.list_agents":
        return {"agents": []}
    return {"deliveryStatus": "delivered"}
`;
		const assertions = `
import json
rlm("do it")
rlm("do it", name="assistant", model="provider/x")
rlm.list_subagents()
rlm.delete_subagent("c-1")
agent_message.send("hi")
agent_message.send("hi", receiver_role="child", receiver_name="w")
agent_message.send("hi", target="all")
agent_message.list_agents()
print(json.dumps(__rlm_calls))
`;
		// `__omp_display` is injected by the real runner; stub it out here so the
		// prelude loads verbatim (mirrors the existing py/prelude.test.ts seam).
		// The `from __future__` line must stay first, so the display stub goes
		// after the prelude's leading future import.
		const preludeWithDisplay = PYTHON_PRELUDE.replace(
			"from __future__ import annotations",
			"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
		);
		const script = `${preludeWithDisplay}\n__rlm_calls = []\n${bridgeRecorder}\n_bridge_call = __rlm_recorder\n${assertions}`;
		const proc = Bun.spawn([$which("python3") ?? "python", "-c", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		expect(exitCode, stderr).toBe(0);

		const calls = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as Array<[string, Record<string, unknown>]>;
		expect(calls).toEqual([
			["__rlm__", { op: "run", prompt: "do it" }],
			["__rlm__", { op: "run", prompt: "do it", name: "assistant", model: "provider/x" }],
			["__rlm__", { op: "list_subagents" }],
			["__rlm__", { op: "delete_subagent", target: "c-1" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "parent" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "child", receiver_name: "w" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "parent", target: "all" }],
			["__rlm__", { op: "agent_message.list_agents" }],
		]);
	});
});

describe.skipIf(!HAS_RUBY)("eval Ruby RLM façade wire", () => {
	it("rlm/Rlm/AgentMessage send the exact __rlm__ payloads through the bridge", async () => {
		const preludeRbPath = path.join(import.meta.dir, "../../src/eval/rb/prelude.rb");
		const script = `
require "json"
load ${JSON.stringify(preludeRbPath)}
$rlm_calls = []
module OmpBridge
  class << self
    def call(name, args)
      $rlm_calls << [name, args]
      case args["op"]
      when "run" then { "rlm_child_id" => "c-1", "name" => "w", "session_dir" => "/tmp/d", "model" => "m" }
      when "list_subagents" then { "subagents" => [] }
      when "delete_subagent" then { "rlm_child_id" => "c-1", "name" => "w", "deleted" => true }
      when "agent_message.list_agents" then { "agents" => [] }
      else { "deliveryStatus" => "delivered" }
      end
    end
  end
end
rlm("do it")
rlm("do it", name: "assistant", model: "provider/x")
Rlm.list_subagents
Rlm.delete_subagent("c-1")
AgentMessage.send("hi")
AgentMessage.send("hi", receiver_role: "child", receiver_name: "w")
AgentMessage.send("hi", target: "all")
AgentMessage.list_agents
puts JSON.generate($rlm_calls)
`;
		const proc = Bun.spawn([$which("ruby")!, "-e", script], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		expect(exitCode, stderr).toBe(0);

		const calls = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as Array<[string, Record<string, unknown>]>;
		expect(calls).toEqual([
			["__rlm__", { op: "run", prompt: "do it" }],
			["__rlm__", { op: "run", prompt: "do it", name: "assistant", model: "provider/x" }],
			["__rlm__", { op: "list_subagents" }],
			["__rlm__", { op: "delete_subagent", target: "c-1" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "parent" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "child", receiver_name: "w" }],
			["__rlm__", { op: "agent_message.send", message: "hi", receiver_role: "parent", target: "all" }],
			["__rlm__", { op: "agent_message.list_agents" }],
		]);
	});
});
