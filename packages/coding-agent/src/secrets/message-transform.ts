import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import type { SessionContext } from "../session/session-context";
import type { JsonValue, SecretObfuscator } from "./obfuscator";
import { collectJsonRegexSecretValues, isPlainRecord, mapJsonStrings } from "./placeholder-scan";

// ═══════════════════════════════════════════════════════════════════════════
// Display restore (inbound, persisted/provider → local display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Restore secret placeholders for local display. Only message kinds the model
 * itself authored from obfuscated context carry placeholders — assistant
 * content and the LLM-written branch/compaction summaries. User, developer, and
 * tool-result messages are persisted with their literal text, so operator-authored
 * placeholder-shaped text must survive untouched; those roles are never walked.
 */
export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = deobfuscateAgentMessages(obfuscator, sessionContext.messages);
	return messages === sessionContext.messages ? sessionContext : { ...sessionContext, messages };
}

export function deobfuscateAgentMessages(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = messages.map((message): AgentMessage => {
		switch (message.role) {
			case "assistant": {
				const content = deobfuscateAssistantContent(obfuscator, message.content);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			case "branchSummary": {
				const summary = deob(message.summary);
				if (summary === message.summary) return message;
				changed = true;
				return { ...message, summary };
			}
			case "compactionSummary": {
				const summary = deob(message.summary);
				const shortSummary = message.shortSummary === undefined ? undefined : deob(message.shortSummary);
				const blocks = message.blocks === undefined ? undefined : deobfuscateTextBlocks(obfuscator, message.blocks);
				if (summary === message.summary && shortSummary === message.shortSummary && blocks === message.blocks) {
					return message;
				}
				changed = true;
				return { ...message, summary, shortSummary, blocks };
			}
			default:
				return message;
		}
	});
	return changed ? result : messages;
}

/**
 * Restore placeholders in assistant content: visible text and tool-call
 * arguments/intent/rawBlock. Thinking and signatures are opaque
 * provider-replay/hidden-reasoning data and pass through byte-identical.
 */
export function deobfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!obfuscator.hasSecrets()) return content;
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = deob(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}

		if (block.type === "toolCall") {
			const args = deobfuscateToolArguments(obfuscator, block.arguments);
			const intent = block.intent === undefined ? undefined : deob(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : deob(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

/**
 * Restore placeholders inside a tool call's arguments. Arguments are arbitrary
 * model-authored JSON, so tool-call arguments are the ONLY place a recursive
 * JSON walk runs.
 */
export function deobfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonValue, s => obfuscator.deobfuscate(s)) as Record<string, unknown>;
}

/** Redact secrets inside a tool call's arguments (same JSON-walk exception as {@link deobfuscateToolArguments}). */
export function obfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
	sharedRegexSecretValues?: ReadonlySet<string>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	const regexSecretValues = sharedRegexSecretValues ?? collectJsonRegexSecretValues(obfuscator, args as JsonValue);
	return mapJsonStrings(args as JsonValue, s => obfuscator.obfuscate(s, regexSecretValues)) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Outbound obfuscation (local → provider)
// ═══════════════════════════════════════════════════════════════════════════

type UserFacingMessage = Extract<Message, { role: "user" | "developer" | "toolResult" }>;

/** Obfuscate `text` blocks of a content array; image and other blocks pass through. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
	sharedRegexSecretValues?: ReadonlySet<string>,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/** Restore placeholders in `text` blocks of a content array; image and other blocks pass through. */
function deobfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.deobfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/**
 * Re-obfuscate assistant content before it returns to a provider after session
 * restoration, removing friendly prefixes made unsafe by this batch. A changed
 * thinking block loses its byte-bound replay signature.
 */
function obfuscateAssistantContentForReplay(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage["content"] {
	const obfuscate = (text: string): string =>
		obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(
			obfuscator.obfuscate(text, sharedRegexSecretValues),
			sharedRegexSecretValues,
		);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscate(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = mapJsonStrings(block.arguments as JsonValue, obfuscate) as Record<string, unknown>;
			const intent = block.intent === undefined ? undefined : obfuscate(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : obfuscate(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}
const CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
	root: ["instructionsTemplate"],
	instructionsVariables: ["personalityDefault", "personalityFriendly", "personalityPragmatic"],
	approvals: ["onRequest", "onRequestAutoReview", "never", "unlessTrusted"],
	collaborationModes: ["default", "plan"],
	autoReview: ["policy", "policyTemplate"],
	permissions: ["dangerFullAccess", "workspaceWrite", "readOnly"],
	tokenBudget: ["reminderMessageTemplate", "guidanceMessage", "autoCompactFallbackPrompt"],
};

/** Visit only provider-visible or profile-provenance text fields; cache/provenance digests are intentionally excluded. */
function visitCodexNativePromptRecordStrings(
	value: unknown,
	fields: readonly string[],
	visit: (text: string) => void,
): void {
	if (typeof value !== "object" || value === null || !isPlainRecord(value)) return;
	for (const field of fields) {
		if (typeof value[field] === "string") visit(value[field]);
	}
}

function visitCodexNativePromptModelMessages(value: unknown, visit: (text: string) => void): void {
	if (Array.isArray(value)) {
		for (const message of value) {
			if (typeof message !== "object" || message === null || !isPlainRecord(message)) continue;
			if (typeof message.content === "string") visit(message.content);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !isPlainRecord(value)) return;
	visitCodexNativePromptRecordStrings(value, CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.root, visit);
	visitCodexNativePromptRecordStrings(
		value.instructionsVariables,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.instructionsVariables,
		visit,
	);
	visitCodexNativePromptRecordStrings(value.approvals, CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.approvals, visit);
	visitCodexNativePromptRecordStrings(
		value.collaborationModes,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.collaborationModes,
		visit,
	);
	visitCodexNativePromptRecordStrings(
		value.autoReview,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.autoReview,
		visit,
	);
	visitCodexNativePromptRecordStrings(
		value.permissions,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.permissions,
		visit,
	);
	visitCodexNativePromptRecordStrings(
		value.tokenBudget,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.tokenBudget,
		visit,
	);
}

function visitCodexNativePromptText(nativePrompt: unknown, visit: (text: string) => void): void {
	if (typeof nativePrompt !== "object" || nativePrompt === null || !isPlainRecord(nativePrompt)) return;
	if (typeof nativePrompt.instructions === "string") visit(nativePrompt.instructions);
	for (const field of ["developerFragments", "contextualUserFragments"] as const) {
		const fragments = nativePrompt[field];
		if (!Array.isArray(fragments)) continue;
		for (const fragment of fragments) {
			if (typeof fragment === "string") visit(fragment);
		}
	}
	visitCodexNativePromptModelMessages(nativePrompt.modelMessages, visit);
}

function collectCodexNativePromptRegexSecretValues(obfuscator: SecretObfuscator, nativePrompt: unknown): Set<string> {
	const values = new Set<string>();
	visitCodexNativePromptText(nativePrompt, text => {
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) values.add(value);
	});
	return values;
}

function obfuscateCodexNativePromptRecordStrings(
	obfuscator: SecretObfuscator,
	value: unknown,
	fields: readonly string[],
	sharedRegexSecretValues: ReadonlySet<string>,
): unknown {
	if (typeof value !== "object" || value === null || !isPlainRecord(value)) return value;
	let result: Record<string, unknown> | undefined;
	for (const field of fields) {
		const original = value[field];
		if (typeof original !== "string") continue;
		const obfuscated = obfuscator.obfuscate(original, sharedRegexSecretValues);
		if (obfuscated === original) continue;
		result ??= { ...value };
		result[field] = obfuscated;
	}
	return result ?? value;
}

function obfuscateCodexNativePromptFragments(
	obfuscator: SecretObfuscator,
	value: unknown,
	sharedRegexSecretValues: ReadonlySet<string>,
): unknown {
	if (!Array.isArray(value)) return value;
	let changed = false;
	const fragments = value.map(fragment => {
		if (typeof fragment !== "string") return fragment;
		const obfuscated = obfuscator.obfuscate(fragment, sharedRegexSecretValues);
		if (obfuscated !== fragment) changed = true;
		return obfuscated;
	});
	return changed ? fragments : value;
}

function obfuscateCodexNativePromptModelMessages(
	obfuscator: SecretObfuscator,
	value: unknown,
	sharedRegexSecretValues: ReadonlySet<string>,
): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const messages = value.map(message => {
			if (typeof message !== "object" || message === null || !isPlainRecord(message)) return message;
			if (typeof message.content !== "string") return message;
			const content = obfuscator.obfuscate(message.content, sharedRegexSecretValues);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		});
		return changed ? messages : value;
	}
	if (typeof value !== "object" || value === null || !isPlainRecord(value)) return value;
	const root = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.root,
		sharedRegexSecretValues,
	);
	const instructionsVariables = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.instructionsVariables,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.instructionsVariables,
		sharedRegexSecretValues,
	);
	const approvals = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.approvals,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.approvals,
		sharedRegexSecretValues,
	);
	const collaborationModes = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.collaborationModes,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.collaborationModes,
		sharedRegexSecretValues,
	);
	const autoReview = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.autoReview,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.autoReview,
		sharedRegexSecretValues,
	);
	const permissions = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.permissions,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.permissions,
		sharedRegexSecretValues,
	);
	const tokenBudget = obfuscateCodexNativePromptRecordStrings(
		obfuscator,
		value.tokenBudget,
		CODEX_NATIVE_PROMPT_MODEL_MESSAGE_TEXT_FIELDS.tokenBudget,
		sharedRegexSecretValues,
	);
	if (
		root === value &&
		instructionsVariables === value.instructionsVariables &&
		approvals === value.approvals &&
		collaborationModes === value.collaborationModes &&
		autoReview === value.autoReview &&
		permissions === value.permissions &&
		tokenBudget === value.tokenBudget
	) {
		return value;
	}
	return {
		...(root as Record<string, unknown>),
		...(instructionsVariables === value.instructionsVariables ? {} : { instructionsVariables }),
		...(approvals === value.approvals ? {} : { approvals }),
		...(collaborationModes === value.collaborationModes ? {} : { collaborationModes }),
		...(autoReview === value.autoReview ? {} : { autoReview }),
		...(permissions === value.permissions ? {} : { permissions }),
		...(tokenBudget === value.tokenBudget ? {} : { tokenBudget }),
	};
}

/**
 * Redact the sidecar's provider-visible text without altering its cache and
 * provenance identity. Broad JSON walking is deliberately avoided: opaque
 * metadata must remain byte-stable, while every protocol-defined prompt field
 * is covered explicitly.
 */
function obfuscateCodexNativePrompt(
	obfuscator: SecretObfuscator,
	nativePrompt: unknown,
	sharedRegexSecretValues: ReadonlySet<string>,
): unknown {
	if (typeof nativePrompt !== "object" || nativePrompt === null || !isPlainRecord(nativePrompt)) return nativePrompt;
	const instructions =
		typeof nativePrompt.instructions === "string"
			? obfuscator.obfuscate(nativePrompt.instructions, sharedRegexSecretValues)
			: nativePrompt.instructions;
	const developerFragments = obfuscateCodexNativePromptFragments(
		obfuscator,
		nativePrompt.developerFragments,
		sharedRegexSecretValues,
	);
	const contextualUserFragments = obfuscateCodexNativePromptFragments(
		obfuscator,
		nativePrompt.contextualUserFragments,
		sharedRegexSecretValues,
	);
	const modelMessages = obfuscateCodexNativePromptModelMessages(
		obfuscator,
		nativePrompt.modelMessages,
		sharedRegexSecretValues,
	);
	if (
		instructions === nativePrompt.instructions &&
		developerFragments === nativePrompt.developerFragments &&
		contextualUserFragments === nativePrompt.contextualUserFragments &&
		modelMessages === nativePrompt.modelMessages
	) {
		return nativePrompt;
	}
	return {
		...nativePrompt,
		...(instructions === nativePrompt.instructions ? {} : { instructions }),
		...(developerFragments === nativePrompt.developerFragments ? {} : { developerFragments }),
		...(contextualUserFragments === nativePrompt.contextualUserFragments ? {} : { contextualUserFragments }),
		...(modelMessages === nativePrompt.modelMessages ? {} : { modelMessages }),
	};
}

function collectMessageRegexSecretValues(obfuscator: SecretObfuscator, messages: Message[]): Set<string> {
	const values = new Set<string>();
	const addText = (text: string | undefined): void => {
		if (text === undefined) return;
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
			values.add(value);
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") addText(block.text);
				else if (block.type === "thinking") addText(block.thinking);
				else if (block.type === "toolCall") {
					for (const value of collectJsonRegexSecretValues(obfuscator, block.arguments as JsonValue)) {
						values.add(value);
					}
					addText(block.intent);
					addText(block.rawBlock);
				}
			}
			continue;
		}
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			continue;
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			addText(target.content);
			continue;
		}
		for (const block of target.content) {
			if (block.type === "text") addText(block.text);
		}
	}
	return values;
}

function obfuscateMessagesWithSharedRegexSecretValues(
	obfuscator: SecretObfuscator,
	messages: Message[],
	sharedRegexSecretValues: ReadonlySet<string>,
): Message[] {
	let changed = false;
	const result = messages.map((message): Message => {
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			if (message.role !== "assistant") return message;
			const content = obfuscateAssistantContentForReplay(obfuscator, message.content, sharedRegexSecretValues);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			const content = obfuscator.obfuscate(target.content, sharedRegexSecretValues);
			if (content === target.content) return message;
			changed = true;
			return { ...target, content } as Message;
		}
		const content = obfuscateTextBlocks(obfuscator, target.content, sharedRegexSecretValues);
		if (content === target.content) return message;
		changed = true;
		return { ...target, content } as Message;
	});
	return changed ? result : messages;
}

/**
 * Redact secrets from outbound messages. User messages, tool results, and
 * user-authored developer messages (e.g. `@file` mentions) are obfuscated.
 * Assistant replay content is re-obfuscated too, because session restoration
 * expands keyed placeholders locally before the next provider request. Inline
 * image bytes are never walked.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.hasSecrets()) return messages;
	return obfuscateMessagesWithSharedRegexSecretValues(
		obfuscator,
		messages,
		collectMessageRegexSecretValues(obfuscator, messages),
	);
}

/**
 * Redact outbound provider context. Conversation messages and the native Codex
 * sidecar's provider-visible text are rewritten together so regex discoveries
 * cannot make a friendly placeholder unsafe across their shared request.
 * Static system prompts and tool schemas stay byte-identical.
 */
export function obfuscateProviderContext(obfuscator: SecretObfuscator | undefined, context: Context): Context {
	if (!obfuscator?.hasSecrets()) return context;
	const nativePrompt = context.codexNativePrompt;
	const sharedRegexSecretValues = collectMessageRegexSecretValues(obfuscator, context.messages);
	for (const value of collectCodexNativePromptRegexSecretValues(obfuscator, nativePrompt)) {
		sharedRegexSecretValues.add(value);
	}
	const messages = obfuscateMessagesWithSharedRegexSecretValues(obfuscator, context.messages, sharedRegexSecretValues);
	const obfuscatedNativePrompt = obfuscateCodexNativePrompt(obfuscator, nativePrompt, sharedRegexSecretValues);
	if (messages === context.messages && obfuscatedNativePrompt === nativePrompt) return context;
	return {
		...context,
		...(messages === context.messages ? {} : { messages }),
		...(obfuscatedNativePrompt === nativePrompt ? {} : { codexNativePrompt: obfuscatedNativePrompt }),
	} as Context;
}
