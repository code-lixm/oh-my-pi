import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	OmpAssistantMessage as AssistantMessage,
	OmpCompactionPart as CompactionPart,
	OmpFilePart as FilePart,
	OmpMessage as Message,
	OmpPart as Part,
	OmpReasoningPart as ReasoningPart,
	OmpTextPart as TextPart,
	OmpToolPart as ToolPart,
	OmpUserMessage as UserMessage,
} from "../shared/omp-view-model";
import { normalizeToolInput, normalizeToolMetadata } from "../shared/tool-presentation";
import type { StoredMessage, WebSessionRecord } from "./domain";

export interface ProjectedMessage {
	info: Message;
	parts: Part[];
}

interface ProjectedImageContent {
	data: string;
	mimeType: string;
}

function projectedContent(content: unknown): { text: string; images: ProjectedImageContent[] } {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const text: string[] = [];
	const images: ProjectedImageContent[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object" || !("type" in item)) continue;
		if (item.type === "text" && "text" in item && typeof item.text === "string") {
			text.push(item.text);
			continue;
		}
		if (
			item.type === "image" &&
			"data" in item &&
			typeof item.data === "string" &&
			"mimeType" in item &&
			typeof item.mimeType === "string"
		) {
			images.push({ data: item.data, mimeType: item.mimeType });
		}
	}
	return { text: text.join("\n"), images };
}

function contentText(content: unknown): string {
	return projectedContent(content).text;
}

function projectedImageParts(content: unknown, sessionID: string, messageID: string, idPrefix: string): FilePart[] {
	return projectedContent(content).images.map((image, index) => ({
		id: `${idPrefix}_file_${index}`,
		sessionID,
		messageID,
		type: "file",
		mime: image.mimeType,
		url: image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`,
	}));
}

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

function jsonSafeValue(value: unknown, ancestors = new WeakSet<object>()): JSONValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return undefined;
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => jsonSafeValue(item, ancestors) ?? null);
		const result: Record<string, JSONValue> = {};
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) continue;
			const nested = jsonSafeValue(descriptor.value, ancestors);
			if (nested !== undefined) result[key] = nested;
		}
		return result;
	} catch {
		return "[Unserializable]";
	} finally {
		ancestors.delete(value);
	}
}

function jsonSafeRecord(value: unknown): Record<string, JSONValue> {
	const safeValue = jsonSafeValue(value);
	return safeValue && typeof safeValue === "object" && !Array.isArray(safeValue) ? safeValue : {};
}

function messageID(message: AgentMessage, index: number): string {
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
	return `msg_${timestamp.toString(36)}_${index.toString(36)}`;
}

function userProjection(
	message: Extract<AgentMessage, { role: "user" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const info: UserMessage = {
		id,
		sessionID: session.id,
		role: "user",
		time: { created: message.timestamp },
		agent: "build",
		model: { providerID: session.provider ?? "omp", modelID: session.model ?? "default" },
	};
	const parts: Part[] = [];
	if (typeof message.content === "string") {
		parts.push({ id: `${id}_text_0`, sessionID: session.id, messageID: id, type: "text", text: message.content });
	} else {
		for (const [index, item] of message.content.entries()) {
			if (item.type === "text") {
				parts.push({
					id: `${id}_text_${index}`,
					sessionID: session.id,
					messageID: id,
					type: "text",
					text: item.text,
				});
				continue;
			}
			if (item.type === "image") {
				const file: FilePart = {
					id: `${id}_file_${index}`,
					sessionID: session.id,
					messageID: id,
					type: "file",
					mime: item.mimeType,
					url: item.data.startsWith("data:") ? item.data : `data:${item.mimeType};base64,${item.data}`,
				};
				parts.push(file);
			}
		}
	}
	return { info, parts };
}

function assistantProjection(
	message: Extract<AgentMessage, { role: "assistant" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const completed = message.duration === undefined ? undefined : message.timestamp + message.duration;
	const info: AssistantMessage = {
		id,
		sessionID: session.id,
		role: "assistant",
		time: { created: message.timestamp, completed },
		parentID: "",
		modelID: message.model,
		providerID: message.provider,
		mode: "build",
		path: { cwd: session.directory, root: session.directory },
		cost: message.usage.cost?.total ?? 0,
		tokens: {
			input: message.usage.input,
			output: message.usage.output,
			reasoning: 0,
			cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
		},
		finish: message.stopReason,
		error:
			message.stopReason === "aborted"
				? { name: "MessageAbortedError", data: { message: message.errorMessage ?? "" } }
				: message.errorMessage
					? { name: "UnknownError", data: { message: message.errorMessage } }
					: undefined,
	};
	const parts: Part[] = [];
	for (const [index, item] of message.content.entries()) {
		const partID = `${id}_part_${index}`;
		if (item.type === "text") {
			const part: TextPart = {
				id: partID,
				sessionID: session.id,
				messageID: id,
				type: "text",
				text: item.text,
				time: { start: message.timestamp, end: completed },
			};
			parts.push(part);
			continue;
		}
		if (item.type === "thinking") {
			const part: ReasoningPart = {
				id: partID,
				sessionID: session.id,
				messageID: id,
				type: "reasoning",
				text: item.thinking,
				time: { start: message.timestamp, end: completed },
			};
			parts.push(part);
			continue;
		}
		if (item.type === "toolCall") {
			const tool: ToolPart = {
				id: partID,
				sessionID: session.id,
				messageID: id,
				type: "tool",
				callID: item.id,
				tool: item.name,
				state: {
					status: "running",
					input: normalizeToolInput(item.name, item.arguments),
					time: { start: message.timestamp },
				},
			};
			parts.push(tool);
			continue;
		}
		if (item.type === "image") {
			parts.push({
				id: partID,
				sessionID: session.id,
				messageID: id,
				type: "file",
				mime: item.mimeType,
				url: item.data.startsWith("data:") ? item.data : `data:${item.mimeType};base64,${item.data}`,
			});
		}
	}
	return { info, parts };
}

function eventAssistantInfo(session: WebSessionRecord, id: string, timestamp: number): AssistantMessage {
	return {
		id,
		sessionID: session.id,
		role: "assistant",
		time: { created: timestamp, completed: timestamp },
		parentID: "",
		modelID: session.model ?? "default",
		providerID: session.provider ?? "omp",
		mode: "build",
		path: { cwd: session.directory, root: session.directory },
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		finish: "stop",
	};
}

function bashExecutionProjection(
	message: Extract<AgentMessage, { role: "bashExecution" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const command = typeof message.command === "string" ? message.command : "";
	const output = typeof message.output === "string" ? message.output : "";
	const exitCode =
		typeof message.exitCode === "number" && Number.isFinite(message.exitCode) ? message.exitCode : undefined;
	const cancelled = message.cancelled === true;
	const truncated = message.truncated === true;
	const input = normalizeToolInput("bash", { command });
	const metadata = {
		exitCode: exitCode ?? null,
		cancelled,
		truncated,
		meta: jsonSafeRecord(message.meta),
		excludeFromContext: message.excludeFromContext === true,
		customType: "bashExecution",
		output,
	};
	const failed = cancelled || (exitCode !== undefined && exitCode !== 0);
	const error = cancelled ? "Command cancelled" : `Command exited with code ${exitCode}`;
	const time = { start: message.timestamp, end: message.timestamp };
	const part: ToolPart = {
		id: `${id}_part_0`,
		sessionID: session.id,
		messageID: id,
		type: "tool",
		callID: `${id}_call_0`,
		tool: "bash",
		state: failed
			? {
					status: "error",
					input,
					error: output ? `${error}\n\n${output}` : error,
					metadata,
					time,
				}
			: {
					status: "completed",
					input,
					output,
					title: "bash",
					metadata,
					time,
				},
	};
	return { info: eventAssistantInfo(session, id, message.timestamp), parts: [part] };
}

function bashExecutionUserProjection(
	message: Extract<AgentMessage, { role: "bashExecution" }>,
	session: WebSessionRecord,
	assistantID: string,
): ProjectedMessage {
	const id = `shell_user_${assistantID}`;
	const command = typeof message.command === "string" ? message.command : "";
	return {
		info: {
			id,
			sessionID: session.id,
			role: "user",
			time: { created: message.timestamp },
			agent: "build",
			model: { providerID: session.provider ?? "omp", modelID: session.model ?? "default" },
		},
		parts: [
			{
				id: `${id}_text_0`,
				sessionID: session.id,
				messageID: id,
				type: "text",
				text: command,
			},
		],
	};
}

function customProjection(message: unknown, session: WebSessionRecord, id: string): ProjectedMessage {
	const data = jsonSafeRecord(message);
	const timestamp = typeof data.timestamp === "number" ? data.timestamp : 0;
	const role = typeof data.role === "string" ? data.role : "custom";
	const customType = typeof data.customType === "string" ? data.customType : role;
	const output =
		contentText(data.content) ||
		(typeof data.output === "string" ? data.output : "") ||
		(typeof data.summary === "string" ? data.summary : "") ||
		`Custom event: ${customType}`;
	const part: ToolPart = {
		id: `${id}_part_0`,
		sessionID: session.id,
		messageID: id,
		type: "tool",
		callID: `${id}_call_0`,
		tool: `event:${customType}`,
		state: {
			status: "completed",
			input: normalizeToolInput("event", { role, customType }),
			output,
			title: customType,
			metadata: { ...data, role, customType },
			time: { start: timestamp, end: timestamp },
		},
	};
	return {
		info: eventAssistantInfo(session, id, timestamp),
		parts: [part, ...projectedImageParts(data.content, session.id, id, `${id}_event`)],
	};
}

function summaryProjection(
	message: Extract<AgentMessage, { role: "branchSummary" }> | Extract<AgentMessage, { role: "compactionSummary" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const compaction = message.role === "compactionSummary";
	const part: CompactionPart = {
		id: `${id}_part_0`,
		sessionID: session.id,
		messageID: id,
		type: "compaction",
		auto: compaction,
		summary: message.summary,
		warning: compaction ? message.warning : undefined,
		tokensBefore: compaction ? message.tokensBefore : undefined,
	};
	const imageContent = compaction ? (message.blocks ?? message.images ?? []) : [];
	return {
		info: eventAssistantInfo(session, id, message.timestamp),
		parts: [part, ...projectedImageParts(imageContent, session.id, id, `${id}_summary`)],
	};
}

function fileMentionProjection(
	message: Extract<AgentMessage, { role: "fileMention" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const images = message.files.flatMap(file => (file.image ? [file.image] : []));
	const part: ToolPart = {
		id: `${id}_part_0`,
		sessionID: session.id,
		messageID: id,
		type: "tool",
		callID: `${id}_call_0`,
		tool: "event:fileMention",
		state: {
			status: "completed",
			input: { paths: message.files.map(file => file.path) },
			output: message.files.map(file => file.path).join("\n"),
			title: "fileMention",
			metadata: jsonSafeRecord(message),
			time: { start: message.timestamp, end: message.timestamp },
		},
	};
	return {
		info: eventAssistantInfo(session, id, message.timestamp),
		parts: [part, ...projectedImageParts(images, session.id, id, `${id}_mention`)],
	};
}

function toolResultProjection(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	session: WebSessionRecord,
	id: string,
): ProjectedMessage {
	const output = contentText(message.content);
	const input: Record<string, unknown> = {};
	const metadata = normalizeToolMetadata(message.toolName, message.details, input);
	const time = { start: message.timestamp, end: message.timestamp };
	const part: ToolPart = {
		id: `${id}_part_0`,
		sessionID: session.id,
		messageID: id,
		type: "tool",
		callID: message.toolCallId,
		tool: message.toolName,
		state: message.isError
			? { status: "error", input, error: output, metadata, time }
			: { status: "completed", input, output, title: message.toolName, metadata, time },
	};
	return {
		info: eventAssistantInfo(session, id, message.timestamp),
		parts: [part, ...projectedImageParts(message.content, session.id, id, `${id}_result`)],
	};
}

export function projectMessages(messages: AgentMessage[], session: WebSessionRecord): ProjectedMessage[] {
	const projected: ProjectedMessage[] = [];
	const toolParts = new Map<string, { part: ToolPart; owner: ProjectedMessage }>();
	for (const [index, message] of messages.entries()) {
		const rawMessage: unknown = message;
		if (message.role === "user") {
			projected.push(userProjection(message, session, messageID(message, index)));
			continue;
		}
		if (message.role === "assistant") {
			const item = assistantProjection(message, session, messageID(message, index));
			for (const part of item.parts) {
				if (part.type === "tool") toolParts.set(part.callID, { part, owner: item });
			}
			projected.push(item);
			continue;
		}
		if (message.role === "developer") continue;
		if (message.role === "branchSummary" || message.role === "compactionSummary") {
			projected.push(summaryProjection(message, session, messageID(message, index)));
			continue;
		}
		if (message.role === "fileMention") {
			projected.push(fileMentionProjection(message, session, messageID(message, index)));
			continue;
		}
		if ((message.role === "custom" || message.role === "hookMessage") && !message.display) continue;
		if (message.role === "bashExecution") {
			const id = messageID(message, index);
			projected.push(
				bashExecutionUserProjection(message, session, id),
				bashExecutionProjection(message, session, id),
			);
			continue;
		}
		if (message.role === "toolResult") {
			const tool = toolParts.get(message.toolCallId);
			if (!tool) {
				projected.push(toolResultProjection(message, session, messageID(message, index)));
				continue;
			}
			const { part, owner } = tool;
			const output = contentText(message.content);
			part.state = message.isError
				? {
						status: "error",
						input: part.state.input,
						error: output,
						metadata: normalizeToolMetadata(part.tool, message.details, part.state.input),
						time: {
							start: "time" in part.state ? part.state.time.start : message.timestamp,
							end: message.timestamp,
						},
					}
				: {
						status: "completed",
						input: part.state.input,
						output,
						title: message.toolName,
						metadata: normalizeToolMetadata(part.tool, message.details, part.state.input),
						time: {
							start: "time" in part.state ? part.state.time.start : message.timestamp,
							end: message.timestamp,
						},
					};
			owner.parts.push(...projectedImageParts(message.content, session.id, owner.info.id, `${part.id}_result`));
			continue;
		}
		projected.push(customProjection(rawMessage, session, messageID(message, index)));
	}
	let parentUserID = "";
	for (const message of projected) {
		if (message.info.role === "user") {
			parentUserID = message.info.id;
			continue;
		}
		if (message.info.role === "assistant") message.info.parentID = parentUserID;
	}
	return projected;
}

export function storedMessages(projected: ProjectedMessage[], sessionID: string): StoredMessage[] {
	return projected.map(message => ({ id: message.info.id, sessionID, data: message }));
}
