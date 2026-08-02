import { describe, expect, it } from "bun:test";
import type { SessionStatus } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/status-proj";

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function header(id: string): string {
	return line({ type: "session", version: 3, id, cwd: "/proj", timestamp: new Date().toISOString() });
}

let nextEntryId = 0;
function msg(message: unknown): string {
	nextEntryId += 1;
	return line({
		type: "message",
		id: `e${nextEntryId}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	});
}

const user = (text: string) => msg({ role: "user", content: text });
const assistant = (stopReason: string, content: unknown[]) =>
	msg({ role: "assistant", provider: "anthropic", model: "m", stopReason, content });
const toolResult = () =>
	msg({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }] });
const runMarker = (customType: "session_run_start" | "session_run_stop", pid: number) =>
	line({ type: "custom", customType, data: { recordedAt: "2024-01-01T00:00:00.000Z", pid } });
const textBlock = (text: string) => ({ type: "text", text });
const toolCallBlock = () => ({ type: "toolCall", id: "t1", name: "read", arguments: {} });

/** Build a fresh in-memory store seeded with one session file per id. */
function seed(files: Record<string, string>): MemorySessionStorage {
	const storage = new MemorySessionStorage();
	for (const id in files) {
		storage.writeTextSync(`${SESSION_DIR}/${id}.jsonl`, header(id) + files[id]);
	}
	return storage;
}

async function statusById(storage: MemorySessionStorage): Promise<Map<string, SessionStatus | undefined>> {
	const sessions = await SessionManager.list("/proj", SESSION_DIR, storage);
	return new Map(sessions.map(s => [s.id, s.status]));
}

describe("SessionManager.list session status (tail derivation)", () => {
	it("classifies each terminal-entry shape from the session tail", async () => {
		const storage = seed({
			complete: user("hi") + assistant("stop", [textBlock("all done")]),
			"interrupted-tooluse": user("go") + assistant("toolUse", [toolCallBlock()]),
			"interrupted-toolresult": user("go") + assistant("toolUse", [toolCallBlock()]) + toolResult(),
			aborted: user("go") + assistant("aborted", [{ type: "thinking", thinking: "x" }]),
			error: user("go") + assistant("error", []),
			pending: user("still waiting for a reply"),
			// `stop` but with an unanswered tool call → the loop was cut off before
			// running it, so this is interrupted rather than complete.
			"stop-with-pending-tool": user("go") + assistant("stop", [toolCallBlock()]),
			// Header only, no messages → nothing to classify.
			"header-only": "",
		});

		const status = await statusById(storage);
		expect(status.get("complete")).toBe("complete");
		expect(status.get("interrupted-tooluse")).toBe("interrupted");
		expect(status.get("interrupted-toolresult")).toBe("interrupted");
		expect(status.get("aborted")).toBe("aborted");
		expect(status.get("error")).toBe("error");
		expect(status.get("pending")).toBe("pending");
		expect(status.get("stop-with-pending-tool")).toBe("interrupted");
		expect(status.get("header-only")).toBe("unknown");
	});

	it("gives a live run marker precedence over tool-result and pending tails", async () => {
		const storage = seed({
			"active-after-tool-result":
				user("go") +
				assistant("toolUse", [toolCallBlock()]) +
				toolResult() +
				runMarker("session_run_start", process.pid),
			"active-after-pending": user("still waiting for a reply") + runMarker("session_run_start", process.pid),
		});

		const status = await statusById(storage);
		expect(status.get("active-after-tool-result")).toBe("active");
		expect(status.get("active-after-pending")).toBe("active");
	});

	it("restores tail-derived status after a newer run stop marker", async () => {
		const storage = seed({
			"stopped-after-tool-result":
				user("go") +
				assistant("toolUse", [toolCallBlock()]) +
				toolResult() +
				runMarker("session_run_start", process.pid) +
				runMarker("session_run_stop", process.pid),
			"stopped-after-pending":
				user("still waiting for a reply") +
				runMarker("session_run_start", process.pid) +
				runMarker("session_run_stop", process.pid),
		});

		const status = await statusById(storage);
		expect(status.get("stopped-after-tool-result")).toBe("interrupted");
		expect(status.get("stopped-after-pending")).toBe("pending");
	});

	it("re-derives an unchanged active session after its owning PID exits", async () => {
		const child = Bun.spawn([process.execPath, "--eval", "process.stdin.resume()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			const storage = seed({
				"live-then-dead": user("still waiting for a reply") + runMarker("session_run_start", child.pid),
			});

			expect((await statusById(storage)).get("live-then-dead")).toBe("active");

			child.kill();
			await child.exited;

			// The file's stat identity is unchanged; only liveness can make this pending.
			expect((await statusById(storage)).get("live-then-dead")).toBe("pending");
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});

	it("reports unknown rather than misclassifying when the final message exceeds the tail window", async () => {
		// A completed turn whose final assistant message is larger than the 32 KiB
		// tail window: the window only captures a fragment of that final line, which
		// fails to parse. The picker must surface 'unknown', never a wrong status.
		const huge = "x".repeat(40_000);
		const storage = seed({
			"huge-complete": user("go") + assistant("toolUse", [toolCallBlock()]) + assistant("stop", [textBlock(huge)]),
		});

		const status = await statusById(storage);
		expect(status.get("huge-complete")).toBe("unknown");
	});
});
