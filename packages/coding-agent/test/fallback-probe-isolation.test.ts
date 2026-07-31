import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
const fallback = getBundledModel("openai", "gpt-4o-mini");
if (!primary || !fallback) throw new Error("Expected bundled fallback probe models");

function successfulProbeResponse(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "pong" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
function completedStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: successfulProbeResponse(model) });
	return stream;
}

describe("AgentSession fallback probe isolation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let authStore: SqliteAuthCredentialStore;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fallback-probe-isolation-");
		authStore = await SqliteAuthCredentialStore.open(tempDir.join("auth.db"));
		authStorage = new AuthStorage(authStore);
		await authStorage.reload();
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("keeps a primary probe outside credential rotation, session hooks, and the transcript", async () => {
		const primaryKey = "primary-probe-key";
		await authStorage.set(primary.provider, { type: "api_key", key: primaryKey });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		const onSseEvent = vi.fn();
		let capturedOptions: SimpleStreamOptions | undefined;
		const sideStreamFn: StreamFn = (model, _context, options) => {
			capturedOptions = options;
			void options?.onPayload?.({ probe: true }, model);
			void options?.onResponse?.({ status: 200, headers: {} }, model);
			void options?.onSseEvent?.({ event: "message", data: "{}", raw: ["data: {}"] }, model);
			return completedStream(model);
		};
		const agent = new Agent({
			initialState: {
				model: fallback,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			sideStreamFn,
			onPayload,
			onResponse,
			onSseEvent,
		});

		const sessionIdBeforeProbe = session.sessionId;
		const messagesBeforeProbe = [...session.messages];
		const entriesBeforeProbe = [...sessionManager.getEntries()];
		const healthy = await session.probeModelConnectivity(primary, new AbortController().signal);

		expect(healthy).toBe(true);
		if (!capturedOptions?.sessionId) throw new Error("Expected fallback probe stream options");
		const uniqueProbeSessionId = capturedOptions.sessionId;
		expect(uniqueProbeSessionId).toStartWith(`${sessionIdBeforeProbe}:fallback-probe:`);
		expect(uniqueProbeSessionId).not.toBe(sessionIdBeforeProbe);
		expect(capturedOptions.apiKey).toBe(primaryKey);
		expect(typeof capturedOptions.apiKey).toBe("string");
		expect(capturedOptions.onPayload).toBeUndefined();
		expect(capturedOptions.onResponse).toBeUndefined();
		expect(capturedOptions.onSseEvent).toBeUndefined();
		expect(onPayload).not.toHaveBeenCalled();
		expect(onResponse).not.toHaveBeenCalled();
		expect(onSseEvent).not.toHaveBeenCalled();
		expect(authStore.getCache(`session:sticky:${primary.provider}:${uniqueProbeSessionId}`)).toBeNull();
		expect(session.messages).toEqual(messagesBeforeProbe);
		expect(sessionManager.getEntries()).toEqual(entriesBeforeProbe);
	});
});
