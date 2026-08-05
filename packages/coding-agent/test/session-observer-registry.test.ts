import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type SessionObserverChange,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { rememberPersistedAgentSnapshot } from "@oh-my-pi/pi-coding-agent/registry/persisted-agent-snapshot";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

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

async function createSessionFixture(
	tempDir: TempDir,
	childId: string,
): Promise<{
	mainSessionFile: string;
	childSessionFile: string;
}> {
	const mainSessionFile = tempDir.join("main.jsonl");
	const childSessionFile = tempDir.join(`${childId}.jsonl`);
	await Bun.write(mainSessionFile, "");
	await Bun.write(childSessionFile, "");
	return { mainSessionFile, childSessionFile };
}

function registerMain(sessionFile: string): void {
	AgentRegistry.global().register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: null,
		sessionFile,
		status: "idle",
	});
}

function registerParkedChild(
	id: string,
	sessionFile: string,
	observation: { status?: AgentProgress["status"]; lastUpdate: number },
): void {
	const ref = AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile,
		status: "parked",
	});
	rememberPersistedAgentSnapshot(ref, {
		observations: new Map([[id, { id, ...observation }]]),
		entries: [],
	});
}

describe("SessionObserverRegistry change payloads", () => {
	it("marks main, reset, and lifecycle updates for todo reconciliation", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		const changes: SessionObserverChange[] = [];
		const unsubscribe = registry.onChange(change => changes.push(change));
		registry.subscribeToEventBus(eventBus);

		try {
			registry.setMainSession("/sessions/main.jsonl");
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecyclePayload("lifecycle-worker", "started", 0));
			registry.resetSessions();

			expect(changes).toEqual([
				{ kind: "main", requiresTodoReconcile: true },
				{ kind: "lifecycle", requiresTodoReconcile: true },
				{ kind: "reset", requiresTodoReconcile: true },
			]);
		} finally {
			unsubscribe();
			registry.dispose();
		}
	});

	it.each([
		{ name: "running", status: "running", sessionStatus: "active", requiresTodoReconcile: false },
		{ name: "completed", status: "completed", sessionStatus: "completed", requiresTodoReconcile: true },
		{ name: "failed", status: "failed", sessionStatus: "failed", requiresTodoReconcile: false },
		{ name: "aborted", status: "aborted", sessionStatus: "aborted", requiresTodoReconcile: false },
	] as const)("marks $name progress with the required todo reconciliation behavior", testCase => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		const changes: SessionObserverChange[] = [];
		const unsubscribe = registry.onChange(change => changes.push(change));
		registry.subscribeToEventBus(eventBus);

		try {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				progressPayload(`progress-${testCase.name}`, testCase.status, 0),
			);

			expect(changes).toEqual([{ kind: "progress", requiresTodoReconcile: testCase.requiresTodoReconcile }]);
			expect(registry.getSessions()).toMatchObject([
				{ id: `progress-${testCase.name}`, status: testCase.sessionStatus, progress: { status: testCase.status } },
			]);
		} finally {
			unsubscribe();
			registry.dispose();
		}
	});
});

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
		const changes: SessionObserverChange[] = [];
		const unsubscribe = registry.onChange(change => changes.push(change));

		try {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecyclePayload(id, "started", 0, { startedAtMs: 100 }));
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running", 0, { startedAtMs: 100 }));
			eventBus.emit(
				TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				lifecyclePayload(id, "failed", 0, { startedAtMs: 100, completedAtMs: 200 }),
			);

			changes.length = 0;
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload(id, "running", 0, { startedAtMs: 100 }));
			expect(changes).toEqual([]);
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
			unsubscribe();
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

describe("SessionObserverRegistry persisted parked observations", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it.each([
		{ id: "persisted-completed", status: "completed", lastUpdate: 1_234 },
		{ id: "persisted-failed", status: "failed", lastUpdate: 5_678 },
	] as const)("restores a status-only $status observation for a parked child", async ({ id, status, lastUpdate }) => {
		using tempDir = TempDir.createSync("@omp-session-observer-persisted-");
		const fixture = await createSessionFixture(tempDir, id);
		registerMain(fixture.mainSessionFile);
		registerParkedChild(id, fixture.childSessionFile, { status, lastUpdate });
		const observers = new SessionObserverRegistry();

		try {
			observers.setMainSession(fixture.mainSessionFile);
			const session = observers.getSessions().find(candidate => candidate.id === id);

			expect(session).toMatchObject({
				id,
				kind: "subagent",
				status,
				lastUpdate,
			});
			expect(session?.progress).toBeUndefined();
			expect(session?.startedAtMs).toBeUndefined();
			expect(session?.completedAtMs).toBeUndefined();
		} finally {
			observers.dispose();
		}
	});

	it("does not synthesize a completed row from an old snapshot without observation status", async () => {
		using tempDir = TempDir.createSync("@omp-session-observer-legacy-");
		const id = "legacy-child";
		const fixture = await createSessionFixture(tempDir, id);
		registerMain(fixture.mainSessionFile);
		registerParkedChild(id, fixture.childSessionFile, { lastUpdate: 9_001 });
		const observers = new SessionObserverRegistry();

		try {
			observers.setMainSession(fixture.mainSessionFile);
			const sessions = observers.getSessions();

			expect(sessions.map(session => session.id)).toEqual(["main"]);
			expect(sessions.some(session => session.status === "completed")).toBe(false);
		} finally {
			observers.dispose();
		}
	});
});
