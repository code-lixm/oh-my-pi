import { describe, expect, it } from "bun:test";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function progressPayload(
	id: string,
	status: AgentProgress["status"],
	index: number,
	timing: Pick<AgentProgress, "startedAtMs" | "completedAtMs"> = {},
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: `Exercise ${id}`,
		progress: {
			index,
			id,
			agent: "task",
			agentSource: "bundled",
			status,
			task: `Exercise ${id}`,
			description: `Task ${id}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			...timing,
		},
	};
}

function lifecyclePayload(
	id: string,
	status: SubagentLifecyclePayload["status"],
	index: number,
	timing: Pick<SubagentLifecyclePayload, "startedAtMs" | "completedAtMs"> = {},
): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description: `Task ${id}`,
		status,
		...timing,
	};
}

describe("SessionObserverRegistry progress status consistency", () => {
	it("projects progress-only completed and failed updates onto existing observer statuses", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		try {
			for (const [index, status] of (["completed", "failed"] as const).entries()) {
				const id = `progress-${status}`;
				eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running", index));
				eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, status, index));
			}

			expect(
				registry.getSessions().map(session => ({
					id: session.id,
					status: session.status,
					progressStatus: session.progress?.status,
				})),
			).toEqual([
				{ id: "progress-completed", status: "completed", progressStatus: "completed" },
				{ id: "progress-failed", status: "failed", progressStatus: "failed" },
			]);
		} finally {
			registry.dispose();
		}
	});

	it("does not let late running progress reopen a lifecycle-terminal task, but accepts a new start", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		const id = "terminal-then-restart";

		try {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecyclePayload(id, "started", 0, { startedAtMs: 100 }));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running", 0, { startedAtMs: 100 }));
			eventBus.emit(
				TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				lifecyclePayload(id, "failed", 0, { startedAtMs: 100, completedAtMs: 200 }),
			);

			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running", 0, { startedAtMs: 100 }));
			expect(registry.getSessions()).toMatchObject([
				{
					id,
					status: "failed",
					startedAtMs: 100,
					completedAtMs: 200,
					progress: { status: "failed", completedAtMs: 200 },
				},
			]);

			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecyclePayload(id, "started", 0, { startedAtMs: 300 }));
			const restarted = registry.getSessions().at(0);
			expect(restarted).toMatchObject({
				id,
				status: "active",
				startedAtMs: 300,
				progress: { status: "running" },
			});
			expect(restarted?.completedAtMs).toBeUndefined();
			expect(restarted?.progress?.completedAtMs).toBeUndefined();
		} finally {
			registry.dispose();
		}
	});

	it("retains every agent and terminal status across a hundred started-progress-failed bursts", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		const ids = Array.from({ length: 100 }, (_, index) => `burst-${String(index).padStart(3, "0")}`);

		try {
			for (const [index, id] of ids.entries()) {
				eventBus.emit(
					TASK_SUBAGENT_LIFECYCLE_CHANNEL,
					lifecyclePayload(id, "started", index, { startedAtMs: index * 10 }),
				);
				eventBus.emit(
					TASK_SUBAGENT_PROGRESS_CHANNEL,
					progressPayload(id, "running", index, { startedAtMs: index * 10 }),
				);
				eventBus.emit(
					TASK_SUBAGENT_LIFECYCLE_CHANNEL,
					lifecyclePayload(id, "failed", index, {
						startedAtMs: index * 10,
						completedAtMs: index * 10 + 9,
					}),
				);
			}

			expect(
				registry
					.getSessions()
					.map(session => ({
						id: session.id,
						index: session.index,
						status: session.status,
						progressId: session.progress?.id,
						progressStatus: session.progress?.status,
					}))
					.sort((left, right) => left.id.localeCompare(right.id)),
			).toEqual(
				ids.map((id, index) => ({
					id,
					index,
					status: "failed",
					progressId: id,
					progressStatus: "failed",
				})),
			);
		} finally {
			registry.dispose();
		}
	});
});
