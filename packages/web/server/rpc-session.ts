import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	OMP_APPROVAL_MODES,
	OMP_THINKING_LEVELS,
	type OmpApprovalMode,
	type OmpAssistantMessage,
	type OmpBranchResultView,
	type OmpComposerRuntime,
	type OmpJsonValue,
	type OmpSessionSnapshotView,
	type OmpThinkingLevel,
	type OmpTodoView,
	toOmpJsonValue,
} from "../shared/omp-view-model";
import type { StoredInteraction, WebSessionRecord } from "./domain";
import { type ProjectedMessage, projectMessages, storedMessages } from "./projection";
import type { DurableStore } from "./store";
import type {
	OmpRpcCheckpointCreateRequest,
	OmpRpcCheckpointListRequest,
	OmpRpcRestoreApplyRequest,
	OmpRpcRestorePreviewRequest,
} from "./types/pi-coding-agent";

export interface RpcSessionOptions {
	directory: string;
	projectID: string;
	title?: string;
	parentID?: string;
	parentSessionPath?: string;
	sessionPath?: string;
	cliPath?: string;
	command?: string[];
	sessionDir?: string;
}

export interface PromptIdentity {
	messageID: string;
	textPartID?: string;
	imagePartIDs: string[];
}

function thinkingLevel(value: unknown): OmpThinkingLevel | undefined {
	return typeof value === "string" && (OMP_THINKING_LEVELS as readonly string[]).includes(value)
		? (value as OmpThinkingLevel)
		: undefined;
}

function approvalMode(value: unknown): OmpApprovalMode | undefined {
	return typeof value === "string" && (OMP_APPROVAL_MODES as readonly string[]).includes(value)
		? (value as OmpApprovalMode)
		: undefined;
}

export class RpcWebSession {
	readonly client: RpcClient;
	readonly store: DurableStore;
	#record: WebSessionRecord;
	#messages: ProjectedMessage[] = [];
	#syncChain: Promise<void> = Promise.resolve();
	#closed = false;
	#pendingUserMessages: PromptIdentity[] = [];
	#userMessageOverrides = new Map<string, PromptIdentity>();
	#knownProjectedMessageIDs = new Set<string>();

	static async start(store: DurableStore, options: RpcSessionOptions): Promise<RpcWebSession> {
		const cliPath = options.cliPath ?? path.resolve(import.meta.dir, "../../coding-agent/src/cli.ts");
		const args = options.sessionPath ? ["--session", options.sessionPath] : [];
		const client = new RpcClient({
			cliPath,
			command: options.command,
			mode: "rpc-ui",
			cwd: options.directory,
			sessionDir: options.sessionDir,
			args,
		});
		const now = Date.now();
		const provisional: WebSessionRecord = {
			id: `pending_${crypto.randomUUID()}`,
			projectID: options.projectID,
			directory: options.directory,
			sessionPath: options.sessionPath,
			parentID: options.parentID,
			title: options.title ?? "New session",
			createdAt: now,
			updatedAt: now,
		};
		const session = new RpcWebSession(store, client, provisional);
		session.#bind();
		try {
			await client.start();
			await client.setSubagentSubscription("events");
			if (options.parentSessionPath) {
				const created = await client.newSession(options.parentSessionPath);
				if (created.cancelled) throw new Error("OMP cancelled child-session creation");
			}
			const state = await client.getState();
			const model = state.model;
			session.#record = {
				...provisional,
				id: state.sessionId,
				sessionPath: state.sessionFile ?? options.sessionPath,
				model: model?.id,
				provider: model?.provider,
				updatedAt: Date.now(),
			};
			store.upsertSession(session.#record);
			store.appendEvent(
				options.directory,
				{ type: "session.created", properties: { sessionID: session.id, info: session.info() } },
				session.id,
			);
			await session.syncMessages();
			return session;
		} catch (error) {
			await client.stop().catch(() => undefined);
			throw error;
		}
	}

	private constructor(store: DurableStore, client: RpcClient, record: WebSessionRecord) {
		this.store = store;
		this.client = client;
		this.#record = record;
	}

	get id(): string {
		return this.#record.id;
	}

	get directory(): string {
		return this.#record.directory;
	}

	info() {
		return {
			id: this.#record.id,
			projectID: this.#record.projectID,
			directory: this.#record.directory,
			parentID: this.#record.parentID,
			title: this.#record.title,
			version: "omp",
			time: { created: this.#record.createdAt, updated: this.#record.updatedAt },
		};
	}

	messages(): ProjectedMessage[] {
		return this.#messages;
	}

	message(id: string): ProjectedMessage | undefined {
		return this.#messages.find(message => message.info.id === id);
	}

	async prompt(
		text: string,
		images?: ImageContent[],
		identity?: PromptIdentity,
	): Promise<ProjectedMessage | undefined> {
		await this.#sendPrompt(text, images, identity);
		const state = await this.client.getState();
		if (state.isStreaming) await this.client.waitForIdle(60 * 60 * 1000);
		await this.syncMessages();
		return this.#messages.findLast(message => message.info.role === "assistant");
	}

	async promptAsync(text: string, images?: ImageContent[], identity?: PromptIdentity): Promise<void> {
		await this.#sendPrompt(text, images, identity);
	}

	async command(
		command: string,
		commandArguments: string,
		images?: ImageContent[],
		identity?: PromptIdentity,
	): Promise<void> {
		await this.#sendPrompt(`/${command}${commandArguments ? ` ${commandArguments}` : ""}`, images, identity);
	}

	async #sendPrompt(text: string, images?: ImageContent[], identity?: PromptIdentity): Promise<void> {
		if (identity) this.#pendingUserMessages.push(identity);
		try {
			await this.client.prompt(text, images);
		} catch (error) {
			if (identity) {
				const index = this.#pendingUserMessages.indexOf(identity);
				if (index >= 0) this.#pendingUserMessages.splice(index, 1);
			}
			throw error;
		}
	}

	async abort(): Promise<void> {
		await this.client.abort();
		this.#appendInterruption("agent", "web.abort");
	}

	async compact(instructions?: string): Promise<void> {
		await this.client.compact(instructions);
		await this.syncMessages();
		this.store.appendEvent(
			this.directory,
			{ type: "session.compacted", properties: { sessionID: this.id } },
			this.id,
		);
	}

	async setModel(provider: string, modelID: string): Promise<void> {
		await this.client.setModel(provider, modelID);
		this.#record = { ...this.#record, provider, model: modelID, updatedAt: Date.now() };
		this.store.upsertSession(this.#record);
		this.store.appendEvent(this.directory, { type: "session.updated", properties: { info: this.info() } }, this.id);
	}

	async composerRuntime(): Promise<OmpComposerRuntime> {
		const [state, settings] = await Promise.all([this.client.getState(), this.client.getSettings()]);
		const options: OmpThinkingLevel[] = state.model?.reasoning
			? ["off", "auto", ...(state.model.thinking?.efforts ?? [])]
			: ["off"];
		const current = thinkingLevel(state.configuredThinkingLevel ?? state.thinkingLevel) ?? "off";
		if (!options.includes(current)) options.push(current);
		return {
			thinking: { current, options },
			advisorEnabled: settings.values["advisor.enabled"] === true,
			approvalMode: approvalMode(settings.values["tools.approvalMode"]) ?? "yolo",
		};
	}

	async updateComposerRuntime(input: {
		thinkingLevel?: OmpThinkingLevel;
		advisorEnabled?: boolean;
		approvalMode?: OmpApprovalMode;
	}): Promise<OmpComposerRuntime> {
		if (input.thinkingLevel !== undefined) await this.client.setThinkingLevel(input.thinkingLevel);
		if (input.advisorEnabled !== undefined) await this.client.updateSetting("advisor.enabled", input.advisorEnabled);
		if (input.approvalMode !== undefined) await this.client.updateSetting("tools.approvalMode", input.approvalMode);
		return this.composerRuntime();
	}

	async rename(title: string): Promise<void> {
		await this.client.setSessionName(title);
		this.#updateTitle(title);
	}

	async bash(command: string): Promise<ProjectedMessage> {
		const before = new Set(this.#messages.map(message => message.info.id));
		const result = await this.client.bash(command);
		await this.syncMessages();
		const message = this.#messages.findLast(
			candidate => !before.has(candidate.info.id) && candidate.info.role === "assistant",
		);
		if (message) return message;
		const error = this.#shellProjectionError(result);
		this.store.appendEvent(
			this.directory,
			{
				type: "omp.session.shell_error",
				properties: {
					sessionID: this.id,
					command,
					result: toOmpJsonValue(result),
					message: error.info.error?.data.message,
				},
			},
			this.id,
		);
		return error;
	}

	async abortBash(): Promise<void> {
		await this.client.abortBash();
		this.#appendInterruption("bash", "web.abort_bash");
	}

	async cancelAsyncJobs(): Promise<number> {
		return this.client.cancelAsyncJobs();
	}

	async nativeSnapshot(): Promise<OmpSessionSnapshotView> {
		const [state, subagents, jobs, loginProviders] = await Promise.all([
			this.client.getState(),
			this.client.getSubagents(),
			this.client.getAsyncJobs(),
			this.client.getLoginProviders(),
		]);
		const sessionPath = state.sessionFile ?? this.#record.sessionPath;
		const sessionName = state.sessionName ?? this.#record.title;
		const effectiveThinkingLevel = thinkingLevel(state.thinkingLevel);
		const configuredThinkingLevel =
			state.configuredThinkingLevel === "inherit" ? "inherit" : thinkingLevel(state.configuredThinkingLevel);
		return {
			state: {
				runtime: "active",
				sessionID: state.sessionId,
				...(sessionPath === undefined ? {} : { sessionPath }),
				...(sessionName === undefined ? {} : { sessionName }),
				...(state.model === undefined ? {} : { model: { provider: state.model.provider, id: state.model.id } }),
				...(effectiveThinkingLevel === undefined ? {} : { thinkingLevel: effectiveThinkingLevel }),
				...(configuredThinkingLevel === undefined ? {} : { configuredThinkingLevel }),
				isStreaming: state.isStreaming === true,
				isBashRunning: state.isBashRunning === true,
				isEvalRunning: state.isEvalRunning === true,
				isCompacting: state.isCompacting === true,
				...(state.steeringMode === undefined ? {} : { steeringMode: state.steeringMode }),
				...(state.followUpMode === undefined ? {} : { followUpMode: state.followUpMode }),
				...(state.interruptMode === undefined ? {} : { interruptMode: state.interruptMode }),
				...(state.autoCompactionEnabled === undefined
					? {}
					: { autoCompactionEnabled: state.autoCompactionEnabled }),
				...(state.fastModeEnabled === undefined ? {} : { fastModeEnabled: state.fastModeEnabled }),
				...(state.fastModeActive === undefined ? {} : { fastModeActive: state.fastModeActive }),
				...(state.tokensPerSecond === undefined ? {} : { tokensPerSecond: state.tokensPerSecond }),
				...(state.messageCount === undefined ? {} : { messageCount: state.messageCount }),
				...(state.queuedMessageCount === undefined ? {} : { queuedMessageCount: state.queuedMessageCount }),
				...(state.lsp === undefined ? {} : { lsp: toOmpJsonValue(state.lsp) }),
				...(state.activity === undefined ? {} : { activity: toOmpJsonValue(state.activity) }),
				...(state.planMode === undefined ? {} : { planMode: toOmpJsonValue(state.planMode) }),
				...(state.goalMode === undefined ? {} : { goalMode: toOmpJsonValue(state.goalMode) }),
				...(state.vibeMode === undefined ? {} : { vibeMode: toOmpJsonValue(state.vibeMode) }),
				...(state.contextUsage === undefined ? {} : { contextUsage: toOmpJsonValue(state.contextUsage) }),
				tools: (state.dumpTools ?? []).flatMap(tool => {
					const details = tool as { name?: unknown; description?: unknown };
					return typeof details.name === "string" && typeof details.description === "string"
						? [{ name: details.name, description: details.description }]
						: [];
				}),
				todos: this.#todoViews((state.todoPhases ?? []).flatMap(phase => phase.tasks)),
			},
			subagents: subagents.map(toOmpJsonValue),
			jobs: jobs === null ? null : toOmpJsonValue(jobs),
			loginProviders: loginProviders.map(provider => {
				const details = provider as { available?: unknown; authenticated?: unknown };
				return {
					id: provider.id,
					name: provider.name,
					available: details.available === true,
					authenticated: details.authenticated === true,
				};
			}),
		};
	}

	async todos(): Promise<OmpTodoView[]> {
		const state = await this.client.getState();
		return this.#todoViews((state.todoPhases ?? []).flatMap(phase => phase.tasks));
	}

	async createWorkspaceCheckpoint(request?: OmpRpcCheckpointCreateRequest): Promise<OmpJsonValue> {
		return this.client.createWorkspaceCheckpoint(request);
	}

	async listWorkspaceCheckpoints(request?: OmpRpcCheckpointListRequest): Promise<OmpJsonValue[]> {
		return this.client.listWorkspaceCheckpoints(request);
	}

	async previewWorkspaceRestore(request: OmpRpcRestorePreviewRequest): Promise<OmpJsonValue> {
		return this.client.previewWorkspaceRestore(request);
	}

	async applyWorkspaceRestore(request: OmpRpcRestoreApplyRequest): Promise<OmpJsonValue> {
		return this.client.applyWorkspaceRestore(request);
	}

	async undoWorkspace(scope?: "code" | "conversation" | "all"): Promise<OmpJsonValue> {
		return this.client.undoWorkspace(scope);
	}

	async redoWorkspace(): Promise<OmpJsonValue> {
		return this.client.redoWorkspace();
	}

	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return this.client.getBranchMessages();
	}

	async branch(
		entryId: string,
		onSessionRekey?: (previous: WebSessionRecord, next: WebSessionRecord) => void,
	): Promise<OmpBranchResultView> {
		const previous = this.#record;
		const result = await this.client.branch(entryId);
		if (result.cancelled) return { text: result.text, cancelled: true, session: this.reference() };
		const state = await this.client.getState();
		if (!state.sessionId) throw new Error("OMP branch did not report a session id");
		const model = state.model;
		const changedSession = state.sessionId !== previous.id;
		this.#record = {
			...previous,
			id: state.sessionId,
			sessionPath: state.sessionFile ?? (changedSession ? undefined : previous.sessionPath),
			parentID: changedSession ? previous.id : previous.parentID,
			model: model?.id ?? previous.model,
			provider: model?.provider ?? previous.provider,
			updatedAt: Date.now(),
		};
		this.#messages = [];
		this.#knownProjectedMessageIDs.clear();
		this.#userMessageOverrides.clear();
		if (changedSession && onSessionRekey) onSessionRekey(previous, this.#record);
		else this.store.upsertSession(this.#record);
		this.store.appendEvent(
			this.directory,
			{
				type: changedSession ? "session.created" : "session.updated",
				properties: { sessionID: this.id, info: this.info() },
			},
			this.id,
		);
		await this.syncMessages();
		return { text: result.text, cancelled: false, session: this.reference() };
	}

	async handoff(customInstructions?: string): Promise<{ savedPath?: string } | null> {
		return this.client.handoff(customInstructions);
	}

	async exportHtml(): Promise<{ path: string }> {
		return this.client.exportHtml();
	}

	async login(providerId: string): Promise<{ providerId: string }> {
		return this.client.login(providerId);
	}

	reference() {
		return {
			id: this.#record.id,
			parentID: this.#record.parentID,
			sessionPath: this.#record.sessionPath,
			title: this.#record.title,
		};
	}

	#todoViews(todos: Array<{ content: string; status: string }>): OmpTodoView[] {
		const occurrences = new Map<string, number>();
		return todos.map(todo => {
			const occurrence = occurrences.get(todo.content) ?? 0;
			occurrences.set(todo.content, occurrence + 1);
			return {
				id: `${this.id}:todo:${encodeURIComponent(todo.content)}:${occurrence}`,
				content: todo.content,
				status: todo.status,
				priority: "medium",
			};
		});
	}

	#updateTitle(title: string): void {
		if (title === this.#record.title) return;
		this.#record = { ...this.#record, title, updatedAt: Date.now() };
		this.store.upsertSession(this.#record);
		this.store.appendEvent(
			this.directory,
			{ type: "session.updated", properties: { sessionID: this.id, info: this.info() } },
			this.id,
		);
	}

	#appendInterruption(scope: "agent" | "bash", reason: string): void {
		const event = { type: "interrupted", scope, reason };
		this.store.appendEvent(
			this.directory,
			{ type: "omp.session.interrupted", properties: { sessionID: this.id, ...event } },
			this.id,
		);
		this.store.appendEvent(
			this.directory,
			{ type: "omp.session.event", properties: { sessionID: this.id, event } },
			this.id,
		);
	}

	#shellProjectionError(result: { exitCode?: number; cancelled: boolean; timedOut?: boolean }): ProjectedMessage & {
		info: OmpAssistantMessage;
	} {
		const id = `shell_error_${crypto.randomUUID()}`;
		const now = Date.now();
		const reason = result.cancelled
			? "OMP RPC cancelled the shell command without appending an assistant session message"
			: result.timedOut
				? "OMP RPC timed out the shell command without appending an assistant session message"
				: `OMP RPC completed shell command with exit code ${result.exitCode ?? "unknown"} without appending an assistant session message`;
		return {
			info: {
				id,
				sessionID: this.id,
				role: "assistant",
				time: { created: now, completed: now },
				parentID: "",
				modelID: this.#record.model ?? "omp",
				providerID: this.#record.provider ?? "omp",
				mode: "build",
				path: { cwd: this.directory, root: this.directory },
				cost: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
				finish: "error",
				error: { name: "ShellProjectionError", data: { message: reason } },
			},
			parts: [
				{
					id: `${id}_part_0`,
					sessionID: this.id,
					messageID: id,
					type: "text",
					text: reason,
					time: { start: now, end: now },
				},
			],
		};
	}
	async syncMessages(): Promise<void> {
		const previous = this.#syncChain;
		const current = previous.then(async () => {
			if (this.#closed) return;
			const messages = await this.client.getMessages();
			const projected = projectMessages(messages, this.#record).map(message => {
				const generatedID = message.info.id;
				const isNew = !this.#knownProjectedMessageIDs.has(generatedID);
				this.#knownProjectedMessageIDs.add(generatedID);
				if (
					isNew &&
					message.info.role === "user" &&
					!message.info.id.startsWith("shell_user_") &&
					!this.#userMessageOverrides.has(generatedID)
				) {
					const identity = this.#pendingUserMessages.shift();
					if (identity) this.#userMessageOverrides.set(generatedID, identity);
				}
				const identity = this.#userMessageOverrides.get(generatedID);
				if (!identity) return message;
				let imageIndex = 0;
				return {
					info: { ...message.info, id: identity.messageID },
					parts: message.parts.map(part => {
						const requestedID =
							part.type === "text"
								? identity.textPartID
								: part.type === "file"
									? identity.imagePartIDs[imageIndex++]
									: undefined;
						return { ...part, id: requestedID ?? part.id, messageID: identity.messageID };
					}),
				};
			});
			for (const message of projected) {
				if (message.info.role !== "assistant") continue;
				const parent = this.#userMessageOverrides.get(message.info.parentID);
				if (parent) message.info = { ...message.info, parentID: parent.messageID };
			}
			const old = new Map(this.#messages.map(message => [message.info.id, JSON.stringify(message)]));
			const next = new Map(projected.map(message => [message.info.id, JSON.stringify(message)]));
			this.#messages = projected;
			this.store.replaceMessages(this.id, storedMessages(projected, this.id));
			for (const message of projected) {
				const serialized = next.get(message.info.id);
				if (old.get(message.info.id) === serialized) continue;
				this.store.appendEvent(
					this.directory,
					{ type: "message.updated", properties: { info: message.info } },
					this.id,
				);
				for (const part of message.parts) {
					this.store.appendEvent(this.directory, { type: "message.part.updated", properties: { part } }, this.id);
				}
			}
			for (const messageID of old.keys()) {
				if (next.has(messageID)) continue;
				this.store.appendEvent(
					this.directory,
					{ type: "message.removed", properties: { sessionID: this.id, messageID } },
					this.id,
				);
			}
			this.#record = { ...this.#record, updatedAt: Date.now() };
			this.store.upsertSession(this.#record);
		});
		this.#syncChain = current.catch(() => undefined);
		await current;
	}

	async answerInteraction(id: string, value: string | boolean | undefined, rejected = false): Promise<boolean> {
		const pending = this.store.listInteractions(undefined, this.id).find(interaction => interaction.id === id);
		if (!pending) return false;
		const interactionRejected = rejected || value === undefined || (pending.kind === "permission" && value === false);
		if (!this.store.resolveInteraction(id, interactionRejected ? "rejected" : "resolved")) return false;
		let response: RpcExtensionUIResponse;
		if (rejected || value === undefined) response = { type: "extension_ui_response", id, cancelled: true };
		else if (typeof value === "boolean") response = { type: "extension_ui_response", id, confirmed: value };
		else response = { type: "extension_ui_response", id, value };
		this.client.respondToExtensionUi(response);
		this.#emitInteractionResult(pending, interactionRejected, value);
		return true;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.client.stop();
	}

	#bind(): void {
		this.client.onSessionEvent(event => {
			if (this.#closed) return;
			this.store.appendEvent(
				this.directory,
				{ type: "omp.session.event", properties: { sessionID: this.id, event: toOmpJsonValue(event) } },
				this.id,
			);
			const nativeEvent = event as unknown as {
				type: string;
				isTerminal?: boolean;
				attempt?: number;
				errorMessage?: string;
				delayMs?: number;
				todos?: Array<{ content?: unknown; status?: unknown }>;
			};
			switch (nativeEvent.type) {
				case "agent_start":
					this.store.appendEvent(
						this.directory,
						{ type: "session.status", properties: { sessionID: this.id, status: { type: "busy" } } },
						this.id,
					);
					break;
				case "agent_end":
					void this.syncMessages().finally(() => {
						if (nativeEvent.isTerminal === false || this.#closed) return;
						this.store.appendEvent(
							this.directory,
							{ type: "session.status", properties: { sessionID: this.id, status: { type: "idle" } } },
							this.id,
						);
						this.store.appendEvent(
							this.directory,
							{ type: "session.idle", properties: { sessionID: this.id } },
							this.id,
						);
					});
					break;
				case "message_start":
				case "message_update":
				case "message_end":
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end":
					void this.syncMessages();
					break;
				case "auto_retry_start":
					this.store.appendEvent(
						this.directory,
						{
							type: "session.status",
							properties: {
								sessionID: this.id,
								status: {
									type: "retry",
									attempt: typeof nativeEvent.attempt === "number" ? nativeEvent.attempt : 0,
									message: typeof nativeEvent.errorMessage === "string" ? nativeEvent.errorMessage : "",
									next: Date.now() + (typeof nativeEvent.delayMs === "number" ? nativeEvent.delayMs : 0),
								},
							},
						},
						this.id,
					);
					break;
				case "auto_retry_end":
					this.store.appendEvent(
						this.directory,
						{ type: "session.status", properties: { sessionID: this.id, status: { type: "busy" } } },
						this.id,
					);
					break;
				case "todo_reminder": {
					const todos = Array.isArray(nativeEvent.todos)
						? nativeEvent.todos.flatMap(todo =>
								typeof todo.content === "string" && typeof todo.status === "string"
									? [{ content: todo.content, status: todo.status }]
									: [],
							)
						: [];
					this.store.appendEvent(
						this.directory,
						{ type: "todo.updated", properties: { sessionID: this.id, todos: this.#todoViews(todos) } },
						this.id,
					);
					break;
				}
				case "todo_auto_clear":
					this.store.appendEvent(
						this.directory,
						{ type: "todo.updated", properties: { sessionID: this.id, todos: [] } },
						this.id,
					);
					break;
			}
		});
		const appendSubagentEvent = (type: string, payload: unknown) => {
			if (this.#closed) return;
			this.store.appendEvent(
				this.directory,
				{ type, properties: { sessionID: this.id, payload: toOmpJsonValue(payload) } },
				this.id,
			);
		};
		this.client.onSubagentLifecycle(payload => appendSubagentEvent("omp.subagent.lifecycle", payload));
		this.client.onSubagentProgress(payload => appendSubagentEvent("omp.subagent.progress", payload));
		this.client.onSubagentEvent(payload => appendSubagentEvent("omp.subagent.event", payload));
		this.client.onExtensionUiRequest(request => this.#interaction(request));
	}

	#emitInteractionResult(
		interaction: StoredInteraction,
		rejected: boolean,
		value: string | boolean | undefined,
	): void {
		if (interaction.kind === "permission") {
			this.store.appendEvent(
				this.directory,
				{
					type: "permission.replied",
					properties: { sessionID: this.id, requestID: interaction.id, reply: rejected ? "reject" : "once" },
				},
				this.id,
			);
			return;
		}
		if (interaction.kind !== "question") return;
		this.store.appendEvent(
			this.directory,
			{
				type: rejected ? "question.rejected" : "question.replied",
				properties: rejected
					? { sessionID: this.id, requestID: interaction.id }
					: { sessionID: this.id, requestID: interaction.id, answers: [[String(value)]] },
			},
			this.id,
		);
	}

	#appendNativeUiEvent(request: RpcExtensionUIRequest): void {
		this.store.appendEvent(
			this.directory,
			{ type: `omp.ui.${request.method}`, properties: toOmpJsonValue(request) },
			this.id,
		);
	}

	#interaction(request: RpcExtensionUIRequest): void {
		if (this.#closed) return;
		if (request.method === "notify" || request.method === "open_url") {
			const message = request.method === "notify" ? request.message : request.url;
			const interaction: StoredInteraction = {
				id: request.id,
				sessionID: this.id,
				kind: "notification",
				request,
				status: "resolved",
				createdAt: Date.now(),
			};
			this.store.upsertInteraction(interaction);
			this.store.appendEvent(
				this.directory,
				{
					type: "tui.toast.show",
					properties: {
						title: "OMP",
						message,
						variant: request.method === "notify" ? (request.notifyType ?? "info") : "info",
					},
				},
				this.id,
			);
			return;
		}
		if (request.method === "cancel") {
			const pending = this.store
				.listInteractions(undefined, this.id)
				.find(interaction => interaction.id === request.targetId);
			if (pending && this.store.resolveInteraction(pending.id, "rejected")) {
				this.#emitInteractionResult(pending, true, undefined);
			}
			this.#appendNativeUiEvent(request);
			return;
		}
		if (request.method === "setTitle") {
			this.#appendNativeUiEvent(request);
			void this.rename(request.title).catch(() => undefined);
			return;
		}
		if (request.method === "setStatus" || request.method === "setWidget" || request.method === "set_editor_text") {
			this.#appendNativeUiEvent(request);
			return;
		}
		const permission = request.method === "confirm";
		const interaction: StoredInteraction = {
			id: request.id,
			sessionID: this.id,
			kind: permission ? "permission" : "question",
			request,
			status: "pending",
			createdAt: Date.now(),
		};
		this.store.upsertInteraction(interaction);
		if (permission) {
			this.store.appendEvent(
				this.directory,
				{
					type: "permission.asked",
					properties: {
						id: request.id,
						sessionID: this.id,
						permission: "omp.confirm",
						patterns: [],
						metadata: { title: request.title, message: request.message },
						always: [],
					},
				},
				this.id,
			);
			return;
		}
		const options = request.method === "select" ? request.options.map(label => ({ label, description: "" })) : [];
		this.store.appendEvent(
			this.directory,
			{
				type: "question.asked",
				properties: {
					id: request.id,
					sessionID: this.id,
					questions: [
						{
							question: request.title,
							header: request.title.slice(0, 30),
							options,
							multiple: false,
							custom: request.method !== "select",
						},
					],
				},
			},
			this.id,
		);
	}
}
