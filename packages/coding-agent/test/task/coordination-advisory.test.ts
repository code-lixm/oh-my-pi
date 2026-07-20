import { afterEach, describe, expect, it } from "bun:test";
import { buildCoordinationAdvisory, composeSpawnAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-coding-agent/task/types";
import { prompt } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";
import { getPromptLocale, selectPrompt, setPromptLocale } from "../../src/prompts/prompt-locale";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import subagentSystemPromptTemplateZh from "../../src/prompts/system/subagent-system-prompt.zh-CN.md" with {
	type: "text",
};

const item = (): TaskItem => ({ task: "do the thing" });
const initialSettingsUiLocale = getSettingsUiLocale();
const initialPromptLocale = getPromptLocale();

afterEach(() => {
	setSettingsUiLocale(initialSettingsUiLocale);
	setPromptLocale(initialPromptLocale);
});

// Mutates the process-wide prompt locale for one render; afterEach restores it.
function renderCurrentCollaborators(locale: "en" | "zh-CN"): string {
	setPromptLocale(locale);
	return prompt.render(selectPrompt(subagentSystemPromptTemplate, subagentSystemPromptTemplateZh), {
		agent: "Base worker.",
		ircPeers: "- `Main` — main (main, running)\n- `Advisor` — scout (sub, parked)",
		ircSelfId: "Worker",
	});
}

describe("buildCoordinationAdvisory", () => {
	it("renders the English runtime guidance for overlapping async fanout", () => {
		setSettingsUiLocale("en");
		const advice = buildCoordinationAdvisory([item(), item()], true, true);
		expect(advice).toBeDefined();
		expect(advice!).toContain("2");
		expect(advice!).toContain("subagents are running in parallel");
		expect(advice!).toContain("Results return automatically; do not poll");
		expect(advice!).toContain("`hub` `send`");
		expect(advice!).toContain("confirm ownership first");
	});

	it("renders the zh-CN runtime guidance for overlapping async fanout", () => {
		setSettingsUiLocale("zh-CN");
		const advice = buildCoordinationAdvisory([item(), item()], true, true);
		expect(advice).toBeDefined();
		expect(advice!).toContain("2");
		expect(advice!).toContain("并行执行");
		expect(advice!).toContain("自动返回");
		expect(advice!).toContain("无需轮询");
		expect(advice!).toContain("`hub` `send`");
		expect(advice!).toContain("确认分工");
	});

	it("stays silent for a single spawn", () => {
		expect(buildCoordinationAdvisory([item()], true, true)).toBeUndefined();
	});

	it("stays silent when hub messaging is unavailable", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, false)).toBeUndefined();
	});

	it("stays silent at max depth (no spawn capacity)", () => {
		expect(buildCoordinationAdvisory([item(), item()], false, true)).toBeUndefined();
	});
});

describe("subagent Current collaborators guidance", () => {
	it("renders the English collaborator contract with hub ownership handoff", () => {
		const out = renderCurrentCollaborators("en");
		expect(out).toContain("# Current collaborators");
		expect(out).toContain("Currently reachable agents:");
		expect(out).toContain("Use `hub` to contact the main agent and other running subagents. Your agent ID: `Worker`");
		expect(out).toContain("Work or files may overlap? Use `hub send` to confirm ownership first.");
		expect(out).toContain(
			"Set `replyTo` when replying; use `await: true` only when you cannot proceed without the answer.",
		);
	});

	it("renders the zh-CN collaborator contract without peer or IRC wording leaking through", () => {
		const out = renderCurrentCollaborators("zh-CN");
		expect(out).toContain("# 当前协作者");
		expect(out).toContain("当前可联系的代理：");
		expect(out).toContain("你可以通过 `hub` 联系主代理和其他正在运行的子代理。你的代理 ID：`Worker`");
		expect(out).toContain("先用 `hub send` 与对应代理确认分工。");
		expect(out).toContain("回复协作消息时设置 `replyTo`；只有缺少回复就无法继续时，才设置 `await: true`。");
		expect(out).not.toContain("Current collaborators");
		expect(out).not.toMatch(/\bpeer\b|\bsibling\b|IRC/i);
	});
});

// Contract: TaskTool.execute composes the specialization nudge with the
// coordination suggestion, gating the latter to the async path (sync siblings
// have already finished). composeSpawnAdvisory is the seam that decision flows
// through, so the gating is pinned here rather than only inside the builders.
describe("composeSpawnAdvisory", () => {
	const worker = (): TaskItem => ({ task: "x" });

	it("joins the specialization tip with the async coordination contract", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).toContain('`agent: "scout"`');
		expect(advisory).toContain("Results return automatically; do not poll.");
		expect(advisory).toContain("confirm ownership first.");
		expect(advisory).not.toContain("Coordinate:");
	});

	it("drops the coordination suggestion on the sync path but keeps the specialization tip", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: false,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Results return automatically; do not poll.");
		expect(advisory).not.toContain("confirm ownership first.");
	});

	it("omits coordination when hub messaging is unavailable, even async", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: false,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Results return automatically; do not poll.");
		expect(advisory).not.toContain("confirm ownership first.");
	});

	it("returns undefined for a single non-generic spawn", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["reviewer"],
				items: [worker()],
				depthCapacity: true,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});

	it("returns undefined at max depth (no spawn capacity)", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["task", "task"],
				items: [worker(), worker()],
				depthCapacity: false,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});
});
