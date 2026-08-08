import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { AgentDrawer } from "../src/components/agents/AgentDrawer";
import { AgentsPanel } from "../src/components/agents/AgentsPanel";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const CLIENT = new GuestClient(LINK, "viewer");

type TerminalStatus = NonNullable<AgentSnapshot["terminalStatus"]>;

function agent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		id: "worker",
		displayName: "Worker",
		kind: "sub",
		status: "idle",
		hasSessionFile: false,
		createdAt: 1,
		lastActivity: 1,
		...overrides,
	};
}

function progress(status: SubagentProgressPayload["progress"]["status"]): SubagentProgressPayload {
	return {
		index: 0,
		agent: "worker",
		task: "inspect terminal state",
		progress: {
			index: 0,
			id: "worker",
			agent: "worker",
			status,
			task: "inspect terminal state",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		},
	};
}

function lifecycle(status: SubagentLifecyclePayload["status"]): SubagentLifecyclePayload {
	return {
		id: "worker",
		agent: "worker",
		status,
		index: 0,
	};
}

function renderDrawer(
	snapshot: AgentSnapshot,
	payload?: SubagentProgressPayload,
	lifecyclePayload?: SubagentLifecyclePayload,
): string {
	return renderToStaticMarkup(
		<AgentDrawer
			agent={snapshot}
			progress={payload}
			lifecycle={lifecyclePayload}
			client={CLIENT}
			onClose={() => {}}
		/>,
	);
}

function renderPanel(
	snapshot: AgentSnapshot,
	payload?: SubagentProgressPayload,
	lifecyclePayload?: SubagentLifecyclePayload,
): string {
	return renderToStaticMarkup(
		<AgentsPanel
			agents={[snapshot]}
			progress={payload ? new Map([[snapshot.id, payload]]) : new Map()}
			lifecycle={lifecyclePayload ? new Map([[snapshot.id, lifecyclePayload]]) : new Map()}
			selectedId={null}
			onSelect={() => {}}
		/>,
	);
}

function expectVisibleStatus(drawer: string, panel: string, status: "running" | TerminalStatus): void {
	expect(drawer).toContain(`<span class="ag-chip ag-chip--${status}">${status}</span>`);
	expect(panel).toContain(`<span class="ag-dot ag-dot--${status}"></span>`);
	expect(panel).toContain(`<span class="ag-row-activity">${status}</span>`);
}

describe("collaboration agent terminal status display", () => {
	for (const terminalStatus of ["completed", "failed", "aborted"] as const) {
		it(`shows persisted ${terminalStatus} to a late-joining guest without live events`, () => {
			const snapshot = agent({ terminalStatus });
			expectVisibleStatus(renderDrawer(snapshot), renderPanel(snapshot), terminalStatus);
		});
	}

	for (const scenario of [
		{
			name: "live completed progress over an idle runtime snapshot",
			snapshot: agent({ status: "idle", terminalStatus: "failed" }),
			progress: progress("completed"),
			expected: "completed",
		},
		{
			name: "live failed lifecycle over a parked runtime snapshot",
			snapshot: agent({ status: "parked", terminalStatus: "completed" }),
			lifecycle: lifecycle("failed"),
			expected: "failed",
		},
	] as const) {
		it(`prefers ${scenario.name}`, () => {
			expectVisibleStatus(
			renderDrawer(scenario.snapshot, scenario.progress, scenario.lifecycle),
			renderPanel(scenario.snapshot, scenario.progress, scenario.lifecycle),
			scenario.expected,
		);
		});
	}

	it("shows running after a fresh start even when prior terminal state remains in the snapshot", () => {
		const snapshot = agent({ status: "parked", terminalStatus: "completed" });
		const staleProgress = progress("failed");
		const freshStart = lifecycle("started");
		expectVisibleStatus(renderDrawer(snapshot, staleProgress, freshStart), renderPanel(snapshot, staleProgress, freshStart), "running");
	});
});
