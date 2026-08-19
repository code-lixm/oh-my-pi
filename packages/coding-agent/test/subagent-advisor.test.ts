/**
 * Per-agent subagent advisors: global `advisor.subagents` and per-agent
 * `task.agentAdvisor` configuration load independently, child settings are
 * advisor-off by default (spawns opt in per agent), and nested per-subagent
 * `__advisor.jsonl` transcripts are discovered.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

describe("advisor subagent settings", () => {
	let agentDir = "";
	afterEach(() => {
		if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
	});

	const load = async (configYml: string): Promise<Settings> => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-advisor-settings-"));
		fs.writeFileSync(path.join(agentDir, "config.yml"), configYml);
		return await Settings.loadReadOnly({ agentDir, cwd: agentDir });
	};

	for (const { name, configYml, expected } of [
		{ name: "nested true", configYml: "advisor:\n  subagents: true\n", expected: true },
		{ name: "flat true", configYml: '"advisor.subagents": true\n', expected: true },
		{ name: "nested false", configYml: "advisor:\n  subagents: false\n", expected: false },
		{ name: "flat false", configYml: '"advisor.subagents": false\n', expected: false },
	]) {
		it(`keeps ${name} advisor.subagents as the global setting`, async () => {
			const settings = await load(configYml);
			expect(settings.get("advisor.subagents")).toBe(expected);
		});
	}

	it("keeps an explicit task.agentAdvisor entry alongside the global setting", async () => {
		const settings = await load('advisor:\n  subagents: true\ntask:\n  agentAdvisor:\n    task: "off"\n');
		expect(settings.get("advisor.subagents")).toBe(true);
		expect(settings.get("task.agentAdvisor")).toEqual({ task: "off" });
	});
});

describe("createSubagentSettings advisor default", () => {
	it("forces the advisor off for subagents even when the parent has it enabled", () => {
		const parent = Settings.isolated({ "advisor.enabled": true });
		expect(createSubagentSettings(parent).get("advisor.enabled")).toBe(false);
	});

	it("lets a per-agent opt-in re-enable the advisor with its own advisor model role", () => {
		const parent = Settings.isolated({ "advisor.enabled": false, modelRoles: { smol: "openai/gpt-5-mini" } });
		const child = createSubagentSettings(parent, {
			"advisor.enabled": true,
			modelRoles: { ...parent.getModelRoles(), advisor: "moonshot/k3" },
		});
		expect(child.get("advisor.enabled")).toBe(true);
		expect(child.getModelRole("advisor")).toBe("moonshot/k3");
		// Other roles from the parent snapshot survive the advisor override.
		expect(child.getModelRole("smol")).toBe("openai/gpt-5-mini");
	});
});

/** Minimal current-version session JSONL: header + one user/assistant exchange. */
function sessionFixtureJsonl(id: string): string {
	const timestamp = new Date().toISOString();
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: "/tmp" };
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "hello", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

/** Advisor metadata must stop before an arbitrarily large malformed history tail. */
function advisorFixtureWithCorruptTailJsonl(id: string): string {
	const timestamp = new Date().toISOString();
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: "/tmp" };
	const sessionInit = {
		type: "session_init",
		id: "init",
		parentId: null,
		timestamp,
		task: "Inspect a persisted transcript",
		agent: "advisor",
		readOnly: true,
	};
	const historicAssistantEntry = {
		type: "message",
		id: "historic-assistant",
		parentId: "init",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "historic advisor reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 19, output: 23 },
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return [
		JSON.stringify(header),
		JSON.stringify(sessionInit),
		JSON.stringify(historicAssistantEntry),
		`{"type":"message","content":"${"x".repeat(512 * 1024)}`,
	].join("\n");
}

describe("subagent advisor transcript discovery", () => {
	it("registers advisor transcripts without replaying their corrupt history tails", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-advisor-"));
		try {
			// Main session advisor: <session>/__advisor.jsonl. Subagent advisor:
			// one level deeper, <session>/<SubId>/__advisor.jsonl — the recorder
			// derives the directory from the subagent's own session file.
			fs.writeFileSync(path.join(dir, "main.jsonl"), sessionFixtureJsonl("main"));
			fs.mkdirSync(path.join(dir, "main", "Sub1"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "main", "__advisor.jsonl"),
				advisorFixtureWithCorruptTailJsonl("main-advisor"),
			);
			fs.writeFileSync(path.join(dir, "main", "Sub1.jsonl"), sessionFixtureJsonl("sub1"));
			fs.writeFileSync(
				path.join(dir, "main", "Sub1", "__advisor.jsonl"),
				advisorFixtureWithCorruptTailJsonl("sub1-advisor"),
			);

			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));

			expect(registry.get("Sub1")?.kind).toBe("sub");
			const mainAdvisor = registry.get(`${MAIN_AGENT_ID}/advisor`);
			expect(mainAdvisor?.kind).toBe("advisor");
			expect(mainAdvisor?.parentId).toBe(MAIN_AGENT_ID);
			expect(mainAdvisor?.sessionFile).toBe(path.join(dir, "main", "__advisor.jsonl"));
			const subAdvisor = registry.get("Sub1/advisor");
			expect(subAdvisor?.kind).toBe("advisor");
			expect(subAdvisor?.parentId).toBe("Sub1");
			expect(subAdvisor?.sessionFile).toBe(path.join(dir, "main", "Sub1", "__advisor.jsonl"));
			// The valid assistant before each corrupt tail would add metrics if the
			// advisor transcript were replayed rather than registered as metadata only.
			expect(mainAdvisor?.history?.metrics).toBeUndefined();
			expect(subAdvisor?.history?.metrics).toBeUndefined();
			// Ordinary subagent transcripts still receive their full history summary.
			expect(registry.get("Sub1")?.history?.metrics?.requests).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
