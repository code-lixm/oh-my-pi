import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const ARCHIVED_USER_TURN = "ARCHIVED USER TURN MUST REMAIN IN WEB HISTORY";
const RETAINED_USER_TURN = "RETAINED USER TURN AFTER COMPACTION CUTOFF";
const LATEST_USER_TURN = "LATEST USER TURN AFTER COMPACTION";
const ARCHIVED_ASSISTANT_TURN = "ARCHIVED ASSISTANT TURN THAT MATERIALIZES THE SESSION";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

function makeInputStream(frames: readonly object[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`${frames.map(frame => JSON.stringify(frame)).join("\n")}\n`));
			controller.close();
		},
	});
}

function makeLiveInputStream(): {
	input: ReadableStream<Uint8Array>;
	send(frame: object): void;
	close(): void;
} {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const input = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
		},
	});
	return {
		input,
		send(frame) {
			if (!controller) throw new Error("RPC input stream is not ready");
			controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		},
		close() {
			if (!controller || closed) return;
			closed = true;
			controller.close();
		},
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap(part => (part?.type === "text" ? [part.text] : [])).join("");
}

function assistantMessage(content: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function transcriptMarkers(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		if (message.role === "user" || message.role === "assistant") return `${message.role}:${messageText(message)}`;
		return message.role;
	});
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		delete Bun.env[name];
		return;
	}
	process.env[name] = value;
	Bun.env[name] = value;
}

function responseMessages(
	frames: readonly Record<string, unknown>[],
	id: string,
	command: "get_messages" | "get_messages_page",
): { messages: AgentMessage[]; totalMessages?: number } {
	const frame = frames.find(candidate => candidate.type === "response" && candidate.id === id);
	if (
		!frame ||
		frame.command !== command ||
		frame.success !== true ||
		!isRecord(frame.data) ||
		!Array.isArray(frame.data.messages)
	) {
		throw new Error(`Expected successful ${command} response for ${id}`);
	}

	const totalMessages = frame.data.totalMessages;
	if (
		totalMessages !== undefined &&
		(typeof totalMessages !== "number" || !Number.isSafeInteger(totalMessages) || totalMessages < 0)
	) {
		throw new Error(`Expected ${command} to report a valid totalMessages count`);
	}

	return { messages: frame.data.messages as AgentMessage[], totalMessages };
}

function responseState(frames: readonly Record<string, unknown>[], id: string): Record<string, unknown> {
	const frame = frames.find(candidate => candidate.type === "response" && candidate.id === id);
	const data = frame?.data;
	if (frame?.command !== "get_state" || frame?.success !== true || !isRecord(data)) {
		throw new Error(`Expected successful get_state response for ${id}`);
	}
	return data;
}

async function readMessagesThroughRpc(session: AgentSession): Promise<{
	snapshot: AgentMessage[];
	page: { messages: AgentMessage[]; totalMessages?: number };
}> {
	const writes: string[] = [];
	const previousNotifications = process.env.PI_NOTIFICATIONS;
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);

	try {
		await runRpcMode(
			session,
			undefined,
			undefined,
			makeInputStream([
				{ id: "display-snapshot", type: "get_messages" },
				{ id: "display-page", type: "get_messages_page", limit: 256 },
			]),
		);
		throw new Error("runRpcMode unexpectedly returned");
	} catch (error) {
		if (!(error instanceof ProcessExitSignal)) throw error;
		expect(error.code).toBe(0);
	} finally {
		stdoutSpy.mockRestore();
		exitSpy.mockRestore();
		restoreEnvironmentValue("PI_NOTIFICATIONS", previousNotifications);
	}

	const frames = writes
		.join("")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
	const snapshot = responseMessages(frames, "display-snapshot", "get_messages");
	const page = responseMessages(frames, "display-page", "get_messages_page");
	return { snapshot: snapshot.messages, page };
}

describe("RPC message transcript source", () => {
	it("returns a persisted display transcript, rather than the compacted provider context, for snapshots and pages", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-message-transcript-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		let seedManager: SessionManager | undefined;
		let resumedManager: SessionManager | undefined;
		let session: AgentSession | undefined;

		try {
			seedManager = SessionManager.create(tempDir.path(), tempDir.path());
			seedManager.appendMessage({ role: "user", content: ARCHIVED_USER_TURN, timestamp: 1 });
			seedManager.appendMessage(assistantMessage(ARCHIVED_ASSISTANT_TURN, 2));
			const firstKeptEntryId = seedManager.appendMessage({
				role: "user",
				content: RETAINED_USER_TURN,
				timestamp: 3,
			});
			seedManager.appendCompaction("Earlier work was compacted.", "Compacted earlier work", firstKeptEntryId, 3);
			seedManager.appendMessage({ role: "user", content: LATEST_USER_TURN, timestamp: 4 });
			await seedManager.flush();
			const sessionFile = seedManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected the seeded history to persist");
			await seedManager.close();
			seedManager = undefined;

			resumedManager = await SessionManager.open(sessionFile, tempDir.path());
			const providerContext = resumedManager.buildSessionContext().messages;
			const displayTranscript = resumedManager.buildSessionContext({ transcript: true }).messages;
			const expectedTranscript = [
				`user:${ARCHIVED_USER_TURN}`,
				`assistant:${ARCHIVED_ASSISTANT_TURN}`,
				`user:${RETAINED_USER_TURN}`,
				"compactionSummary",
				`user:${LATEST_USER_TURN}`,
			];

			// This is the real resume state: provider history has summarized the
			// archived turn, while the persisted display transcript retains it.
			expect(transcriptMarkers(providerContext)).toEqual([
				"compactionSummary",
				`user:${RETAINED_USER_TURN}`,
				`user:${LATEST_USER_TURN}`,
			]);
			expect(transcriptMarkers(displayTranscript)).toEqual(expectedTranscript);

			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
			session = new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: providerContext },
				}),
				sessionManager: resumedManager,
				settings: Settings.isolated(),
				modelRegistry,
			});
			resumedManager = undefined;

			// The old handler returned this provider state directly, so either RPC
			// assertion below would lose ARCHIVED_USER_TURN before the fix.
			expect(transcriptMarkers(session.messages)).not.toContain(`user:${ARCHIVED_USER_TURN}`);

			const rpc = await readMessagesThroughRpc(session);

			expect(transcriptMarkers(rpc.snapshot)).toEqual(expectedTranscript);
			expect(rpc.page.totalMessages).toBe(expectedTranscript.length);
			expect(transcriptMarkers(rpc.page.messages)).toEqual(expectedTranscript);
		} finally {
			if (session) await session.dispose();
			else await resumedManager?.close();
			await seedManager?.close();
			authStorage.close();
		}
	});
});

describe("RPC state projection", () => {
	it("keeps Web RPC consumers from rendering active eval work as idle in get_state", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-running-state-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		let sessionManager: SessionManager | undefined;
		let session: AgentSession | undefined;

		try {
			sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager,
				settings: Settings.isolated(),
				modelRegistry,
			});
			sessionManager = undefined;

			const evaluation = Promise.withResolvers<void>();
			const trackedEvaluation = session.trackEvalExecution(evaluation.promise, new AbortController());
			const input = makeLiveInputStream();
			const outputFrames: Record<string, unknown>[] = [];
			const activeResponse = Promise.withResolvers<Record<string, unknown>>();
			const settledResponse = Promise.withResolvers<Record<string, unknown>>();
			let outputBuffer = "";
			const previousNotifications = process.env.PI_NOTIFICATIONS;
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				outputBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				for (let newline = outputBuffer.indexOf("\n"); newline !== -1; newline = outputBuffer.indexOf("\n")) {
					const line = outputBuffer.slice(0, newline).trim();
					outputBuffer = outputBuffer.slice(newline + 1);
					if (!line) continue;
					const frame = JSON.parse(line) as Record<string, unknown>;
					outputFrames.push(frame);
					if (frame.type !== "response" || typeof frame.id !== "string") continue;
					if (frame.id === "active-eval") activeResponse.resolve(frame);
					if (frame.id === "settled-eval") settledResponse.resolve(frame);
				}
				return true;
			});
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new ProcessExitSignal(code ?? 0);
			}) as typeof process.exit);
			const mode = runRpcMode(session, undefined, undefined, input.input);
			void activeResponse.promise.catch(() => {});
			void settledResponse.promise.catch(() => {});
			const modeOutcome = mode.then(
				() => {
					const error = new Error("runRpcMode unexpectedly returned");
					activeResponse.reject(error);
					settledResponse.reject(error);
					return { returned: true as const, error };
				},
				error => {
					activeResponse.reject(error);
					settledResponse.reject(error);
					return { returned: false as const, error };
				},
			);

			try {
				input.send({ id: "active-eval", type: "get_state" });
				await activeResponse.promise;
				const active = responseState(outputFrames, "active-eval");
				expect(active).toMatchObject({ isBashRunning: false, isEvalRunning: true });

				evaluation.resolve();
				await trackedEvaluation;
				input.send({ id: "settled-eval", type: "get_state" });
				await settledResponse.promise;
				expect(responseState(outputFrames, "settled-eval")).toMatchObject({
					isBashRunning: false,
					isEvalRunning: false,
				});
				input.close();
				const outcome = await modeOutcome;
				if (outcome.returned) throw outcome.error;
				if (!(outcome.error instanceof ProcessExitSignal)) throw outcome.error;
				expect(outcome.error.code).toBe(0);
			} finally {
				evaluation.resolve();
				await trackedEvaluation;
				input.close();
				await modeOutcome;
				stdoutSpy.mockRestore();
				exitSpy.mockRestore();
				restoreEnvironmentValue("PI_NOTIFICATIONS", previousNotifications);
			}
		} finally {
			if (session) await session.dispose();
			else await sessionManager?.close();
			authStorage.close();
		}
	});
});
