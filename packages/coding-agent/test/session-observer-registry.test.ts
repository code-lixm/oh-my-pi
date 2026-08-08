import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type SessionObserverChange,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	mergePersistedAgentSnapshot,
	type PersistedAgentObservation,
	type PersistedAgentSessionSnapshot,
	rememberPersistedAgentSnapshot,
	snapshotPersistedSessionEntries,
} from "@oh-my-pi/pi-coding-agent/registry/persisted-agent-snapshot";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

const TRANSCRIPT_TIMESTAMP = "2026-08-07T00:00:00.000Z";
const TRANSCRIPT_TIMESTAMP_MS = Date.parse(TRANSCRIPT_TIMESTAMP);

function yieldEntry(
	id: string,
	details: { status: "success" | "aborted"; type?: string | string[] },
	isError = false,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TRANSCRIPT_TIMESTAMP,
		message: {
			role: "toolResult",
			toolCallId: `${id}-call`,
			toolName: "yield",
			content: [{ type: "text", text: "Result submitted." }],
			details,
			isError,
			timestamp: TRANSCRIPT_TIMESTAMP_MS,
		},
	};
}

function assistantErrorEntry(id: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TRANSCRIPT_TIMESTAMP,
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "subagent execution failed",
			timestamp: TRANSCRIPT_TIMESTAMP_MS,
		},
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
	observation: Pick<PersistedAgentObservation, "status" | "lastUpdate">,
	snapshot?: PersistedAgentSessionSnapshot,
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
	rememberPersistedAgentSnapshot(
		ref,
		snapshot ?? {
			observations: new Map([[id, { id, ...observation }]]),
			entries: [],
		},
	);
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
		{
			name: "a regular final yield",
			parentStatus: "pending",
			terminalStatus: "completed",
			entries: () => [
				yieldEntry("incremental-yield", { status: "success", type: ["findings"] }),
				yieldEntry("final-yield", { status: "success" }),
			],
		},
		{
			name: "an aborted yield with an incremental result type",
			parentStatus: "running",
			terminalStatus: "aborted",
			entries: () => [yieldEntry("aborted-yield", { status: "aborted", type: ["findings"] })],
		},
		{
			name: "an assistant error stop reason",
			parentStatus: "pending",
			terminalStatus: "failed",
			entries: () => [assistantErrorEntry("assistant-error")],
		},
	] as const)(
		"restores $terminalStatus from $name over $parentStatus parent progress by id",
		async ({ parentStatus, terminalStatus, entries }) => {
			using tempDir = TempDir.createSync("@omp-session-observer-terminal-");
			const id = `terminal-${terminalStatus}`;
			const fixture = await createSessionFixture(tempDir, id);
			const parent: PersistedAgentObservation = {
				id,
				status: parentStatus,
				lastUpdate: TRANSCRIPT_TIMESTAMP_MS,
				progress: progressPayload(id, parentStatus, 0).progress,
			};
			const childSnapshot = snapshotPersistedSessionEntries(entries());

			expect(childSnapshot.terminalStatus).toBe(terminalStatus);
			const mergedSnapshot = mergePersistedAgentSnapshot(childSnapshot, parent);
			expect(mergedSnapshot.terminalStatus).toBe(terminalStatus);

			registerMain(fixture.mainSessionFile);
			registerParkedChild(id, fixture.childSessionFile, parent, mergedSnapshot);
			const observers = new SessionObserverRegistry();

			try {
				observers.setMainSession(fixture.mainSessionFile);
				expect(observers.getSession(id)).toMatchObject({
					id,
					kind: "subagent",
					status: terminalStatus,
					progress: { status: terminalStatus },
				});
			} finally {
				observers.dispose();
			}
		},
	);
	it.each([
		{
			name: "a parked ref terminal failure over a completed child snapshot",
			refStatus: "parked",
			refTerminalStatus: "failed",
			expectedStatus: "failed",
		},
		{
			name: "a hard-aborted ref over conflicting terminal evidence",
			refStatus: "aborted",
			refTerminalStatus: "failed",
			expectedStatus: "aborted",
		},
	] as const)(
		"prefers the registered $refStatus/$refTerminalStatus over a completed child snapshot",
		async ({ refStatus, refTerminalStatus, expectedStatus }) => {
			using tempDir = TempDir.createSync("@omp-session-observer-ref-terminal-");
			const id = `ref-${refStatus}-${expectedStatus}`;
			const fixture = await createSessionFixture(tempDir, id);
			const parent: PersistedAgentObservation = {
				id,
				status: "pending",
				lastUpdate: TRANSCRIPT_TIMESTAMP_MS,
				progress: progressPayload(id, "pending", 0).progress,
			};
			const childSnapshot = snapshotPersistedSessionEntries([yieldEntry("completed-child", { status: "success" })]);
			const mergedSnapshot = mergePersistedAgentSnapshot(childSnapshot, parent);

			registerMain(fixture.mainSessionFile);
			registerParkedChild(id, fixture.childSessionFile, parent, mergedSnapshot);
			const ref = AgentRegistry.global().get(id);
			if (!ref) throw new Error(`Expected parked ref ${id} to be registered`);
			ref.status = refStatus;
			ref.terminalStatus = refTerminalStatus;
			const observers = new SessionObserverRegistry();

			try {
				observers.setMainSession(fixture.mainSessionFile);
				expect(observers.getSession(id)).toMatchObject({
					id,
					kind: "subagent",
					status: expectedStatus,
					progress: { status: expectedStatus },
				});
			} finally {
				observers.dispose();
			}
		},
	);

	it.each([
		{
			name: "a completed parent over a failed child transcript",
			parentStatus: "completed",
			childTerminalStatus: "failed",
			entries: () => [assistantErrorEntry("failed-child")],
		},
		{
			name: "a failed parent over a completed child transcript",
			parentStatus: "failed",
			childTerminalStatus: "completed",
			entries: () => [yieldEntry("completed-child", { status: "success" })],
		},
		{
			name: "an aborted parent over a completed child transcript",
			parentStatus: "aborted",
			childTerminalStatus: "completed",
			entries: () => [yieldEntry("completed-child", { status: "success" })],
		},
	] as const)(
		"uses $parentStatus parent finalization over $childTerminalStatus child evidence from $name",
		async ({ parentStatus, childTerminalStatus, entries }) => {
			using tempDir = TempDir.createSync("@omp-session-observer-parent-terminal-");
			const id = `parent-${parentStatus}-over-${childTerminalStatus}`;
			const fixture = await createSessionFixture(tempDir, id);
			const parent: PersistedAgentObservation = {
				id,
				status: parentStatus,
				lastUpdate: TRANSCRIPT_TIMESTAMP_MS,
				progress: progressPayload(id, parentStatus, 0).progress,
			};
			const childSnapshot = snapshotPersistedSessionEntries(entries());

			expect(childSnapshot.terminalStatus).toBe(childTerminalStatus);
			const mergedSnapshot = mergePersistedAgentSnapshot(childSnapshot, parent);
			expect(mergedSnapshot.terminalStatus).toBe(parentStatus);

			registerMain(fixture.mainSessionFile);
			registerParkedChild(id, fixture.childSessionFile, parent, mergedSnapshot);
			const observers = new SessionObserverRegistry();

			try {
				observers.setMainSession(fixture.mainSessionFile);
				expect(observers.getSession(id)).toMatchObject({
					id,
					status: parentStatus,
					progress: { status: parentStatus },
				});
			} finally {
				observers.dispose();
			}
		},
	);

	it("does not promote an incremental yield without terminal evidence to completed", async () => {
		using tempDir = TempDir.createSync("@omp-session-observer-incremental-");
		const id = "incremental-only";
		const fixture = await createSessionFixture(tempDir, id);
		const parent: PersistedAgentObservation = {
			id,
			status: "pending",
			lastUpdate: TRANSCRIPT_TIMESTAMP_MS,
			progress: progressPayload(id, "pending", 0).progress,
		};
		const childSnapshot = snapshotPersistedSessionEntries([
			yieldEntry("incremental-yield", { status: "success", type: ["findings"] }),
		]);

		expect(childSnapshot.terminalStatus).toBeUndefined();
		const mergedSnapshot = mergePersistedAgentSnapshot(childSnapshot, parent);
		expect(mergedSnapshot.terminalStatus).toBeUndefined();

		registerMain(fixture.mainSessionFile);
		registerParkedChild(id, fixture.childSessionFile, parent, mergedSnapshot);
		const observers = new SessionObserverRegistry();

		try {
			observers.setMainSession(fixture.mainSessionFile);
			expect(observers.getSessions().find(candidate => candidate.id === id)).toMatchObject({
				id,
				status: "active",
				progress: { status: "pending" },
			});
		} finally {
			observers.dispose();
		}
	});

	it("ignores an error-marked aborted yield while restoring a pending parked child", async () => {
		using tempDir = TempDir.createSync("@omp-session-observer-error-yield-");
		const id = "error-marked-yield";
		const fixture = await createSessionFixture(tempDir, id);
		const parent: PersistedAgentObservation = {
			id,
			status: "pending",
			lastUpdate: TRANSCRIPT_TIMESTAMP_MS,
			progress: progressPayload(id, "pending", 0).progress,
		};
		const childSnapshot = snapshotPersistedSessionEntries([
			yieldEntry("error-yield", { status: "aborted", type: ["findings"] }, true),
		]);

		expect(childSnapshot.terminalStatus).toBeUndefined();
		const mergedSnapshot = mergePersistedAgentSnapshot(childSnapshot, parent);
		expect(mergedSnapshot.terminalStatus).toBeUndefined();

		registerMain(fixture.mainSessionFile);
		registerParkedChild(id, fixture.childSessionFile, parent, mergedSnapshot);
		const observers = new SessionObserverRegistry();

		try {
			observers.setMainSession(fixture.mainSessionFile);
			expect(observers.getSession(id)).toMatchObject({
				id,
				kind: "subagent",
				status: "active",
				progress: { status: "pending" },
			});
		} finally {
			observers.dispose();
		}
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
