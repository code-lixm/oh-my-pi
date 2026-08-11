import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";
import type { ApiKey, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { selectPrompt } from "../prompts/prompt-locale";
import autoReviewRequestPrompt from "../prompts/refinement/auto-review-request.md" with { type: "text" };
import autoReviewRequestPromptZh from "../prompts/refinement/auto-review-request.zh-CN.md" with { type: "text" };
import autoReviewSystemPrompt from "../prompts/refinement/auto-review-system.md" with { type: "text" };
import autoReviewSystemPromptZh from "../prompts/refinement/auto-review-system.zh-CN.md" with { type: "text" };
import refinementRequestPrompt from "../prompts/refinement/refinement-request.md" with { type: "text" };
import refinementRequestPromptZh from "../prompts/refinement/refinement-request.zh-CN.md" with { type: "text" };
import refinementSystemPrompt from "../prompts/refinement/refinement-system.md" with { type: "text" };
import refinementSystemPromptZh from "../prompts/refinement/refinement-system.zh-CN.md" with { type: "text" };
import { convertToLlm } from "../session/messages";
import type {
	AppliedRefinementEdit,
	HarnessEntry,
	HarnessScope,
	HarnessState,
	RefinementAction,
	RefinementEdit,
	RefinementKind,
	RefinementProposal,
	RefinementResult,
} from "./types";

const REFINEMENT_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];
const REFINEMENT_ACTIONS: readonly RefinementAction[] = ["create", "update", "delete"];
const MAX_OVERVIEW_ENTRIES = 40;
const MAX_OVERVIEW_CONTENT = 240;
const MAX_HISTORY_ENTRIES = 20;
const MAX_TRAJECTORY_CHARS = 80_000;
const MAX_REFINEMENT_OUTPUT_TOKENS = 32_000;
const MAX_REVIEW_OUTPUT_TOKENS = 4_096;
const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

const ENTRY_CONTROL_FIELDS = new Set([
	"action",
	"kind",
	"id",
	"title",
	"content",
	"path",
	"reference",
	"arguments",
	"metadata",
	"scope",
	"source",
	"version",
	"created_at",
	"updated_at",
]);

const BASE_SYSTEM_PROMPT_IDENTITIES: Record<string, true> = {
	base: true,
	system: true,
	basesystemprompt: true,
	baseprompt: true,
	systemprompt: true,
	rootsystemprompt: true,
	rootprompt: true,
	mainsystemprompt: true,
	primarysystemprompt: true,
	coresystemprompt: true,
	systeminstruction: true,
	systeminstructions: true,
	baseinstruction: true,
	baseinstructions: true,
};

type ScopedHarnessEntry = HarnessEntry & { scope?: HarnessScope };

export interface RefinementPlanningOptions {
	instructions?: string;
	scope?: HarnessScope;
}

export interface AutoRefinementReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

export interface AutoRefinementReviewContext {
	reason: string;
	turnsSinceLastReview: number;
}

function isKind(value: unknown): value is RefinementKind {
	return typeof value === "string" && REFINEMENT_KINDS.includes(value as RefinementKind);
}

function isAction(value: unknown): value is RefinementAction {
	return typeof value === "string" && REFINEMENT_ACTIONS.includes(value as RefinementAction);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function isBaseSystemPromptIdentity(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const normalized = value
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	return (
		normalized.length > 0 &&
		(BASE_SYSTEM_PROMPT_IDENTITIES[normalized] === true ||
			normalized.startsWith("basesystemprompt") ||
			normalized.startsWith("systemprompt"))
	);
}

function referencesImmutableBaseSystemPrompt(entry: Record<string, unknown>): boolean {
	const metadata = asRecord(entry.metadata);
	const identityValues: unknown[] = [
		entry.id,
		entry.slug,
		entry.title,
		entry.name,
		entry.key,
		entry.alias,
		entry.aliases,
		entry.target,
		entry.targetId,
		entry.target_id,
		metadata?.id,
		metadata?.slug,
		metadata?.title,
		metadata?.alias,
		metadata?.aliases,
		metadata?.target,
		metadata?.targetId,
		metadata?.target_id,
	];
	for (const value of identityValues) {
		const aliases = Array.isArray(value) ? value : [value];
		if (aliases.some(isBaseSystemPromptIdentity)) return true;
	}
	return (
		isBaseSystemPromptIdentity(entry.scope) ||
		isBaseSystemPromptIdentity(entry.type) ||
		isBaseSystemPromptIdentity(metadata?.scope) ||
		isBaseSystemPromptIdentity(metadata?.type)
	);
}

function resolveEditId(edit: RefinementEdit): string {
	const supplied = typeof edit.id === "string" ? edit.id.trim() : "";
	if (supplied) return supplied;
	return edit.action === "create"
		? slug(typeof edit.title === "string" ? edit.title : String(edit.kind), "entry")
		: "";
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry === undefined ? undefined : structuredClone(entry);
}

function cloneHarnessState(state: HarnessState): HarnessState {
	return structuredClone(state);
}

function entryScope(entry: HarnessEntry | undefined, fallback: HarnessScope): HarnessScope {
	return entry ? asScope((entry as ScopedHarnessEntry).scope, fallback) : fallback;
}

function overviewForPrompt(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of REFINEMENT_KINDS) {
		const entries = Object.values(state.entries[kind]).sort((left, right) => left.id.localeCompare(right.id));
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, MAX_OVERVIEW_ENTRIES)) {
			const scope = entryScope(entry, "local");
			const reference = asRecord(entry.reference);
			const args = asRecord(entry.arguments);
			const referenceText =
				reference && Object.keys(reference).length > 0
					? ` ref=${compactText(JSON.stringify(reference), MAX_OVERVIEW_CONTENT)}`
					: "";
			const argumentsText =
				args && Object.keys(args).length > 0
					? ` args=${compactText(JSON.stringify(args), MAX_OVERVIEW_CONTENT)}`
					: "";
			lines.push(
				`- [${scope}:${entry.id}] ${entry.title} (v${entry.version})${referenceText}${argumentsText}: ${compactText(entry.content, MAX_OVERVIEW_CONTENT)}`,
			);
		}
		if (entries.length > MAX_OVERVIEW_ENTRIES)
			lines.push(`- +${entries.length - MAX_OVERVIEW_ENTRIES} more ${kind} entries`);
	}
	return lines.join("\n");
}

function historyForPrompt(history: readonly RefinementResult[]): string {
	if (history.length === 0) return "No prior refinement history.";
	return history
		.slice(-MAX_HISTORY_ENTRIES)
		.map(item => {
			const edits = item.appliedEdits
				.map(edit => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			return `[${item.id}]${item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : ""} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const character of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{" || character === "[") depth++;
		else if (character === "}" || character === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		if (isIncompleteJson(candidate)) throw new Error(TRUNCATED_JSON_ERROR);
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return parseJsonCandidate(trimmed);
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return parseJsonCandidate(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) throw new Error(TRUNCATED_JSON_ERROR);
	throw new Error("Refiner did not return a JSON object");
}

function parseEdit(value: unknown): RefinementEdit | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		...record,
		action: (typeof record.action === "string" ? record.action : "") as RefinementAction,
		kind: (typeof record.kind === "string" ? record.kind : "") as RefinementKind,
		id: typeof record.id === "string" ? record.id : "",
		...(typeof record.title === "string" ? { title: record.title } : {}),
		...(typeof record.content === "string" ? { content: record.content } : {}),
	};
}

function parseProposal(text: string): RefinementProposal {
	const value = asRecord(extractJsonObject(text));
	if (!value) throw new Error("Refiner JSON must be an object");
	const edits = Array.isArray(value.edits)
		? value.edits.flatMap(edit => {
				const parsed = parseEdit(edit);
				return parsed ? [parsed] : [];
			})
		: [];
	return {
		summary: typeof value.summary === "string" ? value.summary : "Refined continual harness state",
		rationale: typeof value.rationale === "string" ? value.rationale : "",
		expectedOutcome: typeof value.expectedOutcome === "string" ? value.expectedOutcome : "",
		edits,
	};
}

function textFromResponse(content: ReadonlyArray<{ type: string }>): string {
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part.type === "text" && "text" in part && typeof part.text === "string",
		)
		.map(part => part.text)
		.join("\n");
}

function refinementOutputTokens(model: Model): number {
	return Math.min(model.maxTokens ?? 0, MAX_REFINEMENT_OUTPUT_TOKENS);
}

function reviewOutputTokens(model: Model): number {
	return Math.min(model.maxTokens ?? 0, MAX_REVIEW_OUTPUT_TOKENS);
}

/**
 * Ask a side model for a proposal only. It intentionally does not mutate the
 * state, so callers can re-read selected scope state immediately before apply.
 */
export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model,
	apiKey: ApiKey,
	options: RefinementPlanningOptions = {},
): Promise<RefinementProposal> {
	const conversation = serializeConversation(convertToLlm(messages)).slice(-MAX_TRAJECTORY_CHARS);
	const userPrompt = prompt.render(selectPrompt(refinementRequestPrompt, refinementRequestPromptZh), {
		state: overviewForPrompt(state),
		history: historyForPrompt(history),
		conversation,
		scope: options.scope ?? "local",
		instructions: options.instructions ?? "",
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [selectPrompt(refinementSystemPrompt, refinementSystemPromptZh)],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
		},
		{ apiKey, maxTokens: refinementOutputTokens(model), disableReasoning: true },
	);
	if (response.stopReason === "error")
		throw new Error(`Refinement failed: ${response.errorMessage ?? "unknown error"}`);
	if (response.stopReason === "length") throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	return parseProposal(textFromResponse(response.content));
}

/** Ask the cheap automatic review gate whether trajectory evidence justifies a refinement. */
export async function reviewAutoRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model,
	apiKey: ApiKey,
	context: AutoRefinementReviewContext,
): Promise<AutoRefinementReview> {
	const conversation = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const userPrompt = prompt.render(selectPrompt(autoReviewRequestPrompt, autoReviewRequestPromptZh), {
		reason: context.reason,
		turns: String(context.turnsSinceLastReview),
		state: overviewForPrompt(state),
		history: historyForPrompt(history),
		conversation,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [selectPrompt(autoReviewSystemPrompt, autoReviewSystemPromptZh)],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
		},
		{ apiKey, maxTokens: reviewOutputTokens(model), disableReasoning: true },
	);
	if (response.stopReason === "error")
		throw new Error(`Auto-refine review failed: ${response.errorMessage ?? "unknown error"}`);
	if (response.stopReason === "length") throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	const record = asRecord(extractJsonObject(textFromResponse(response.content)));
	if (!record) throw new Error("Auto-refine review JSON must be an object");
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		...(typeof record.instructions === "string" && record.instructions.trim()
			? { instructions: record.instructions }
			: {}),
	};
}

/** Validate an edit against its action, kind, immutable base-prompt boundary, and current target state. */
export function validateEdit(edit: RefinementEdit, state: HarnessState): string | undefined {
	const id = resolveEditId(edit);
	if (referencesImmutableBaseSystemPrompt(edit) || isBaseSystemPromptIdentity(id)) {
		return "base system prompt is immutable";
	}
	if (!isAction(edit.action)) return `unsupported action ${String(edit.action)}`;
	if (!isKind(edit.kind)) return `unsupported kind ${String(edit.kind)}`;
	if (edit.action !== "create" && !id) return `${edit.action} requires id`;
	if (edit.action !== "delete" && (!asNonEmptyString(edit.title) || !asNonEmptyString(edit.content))) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		if (edit.arguments === undefined || !asRecord(edit.arguments)) return `${edit.action} skill requires arguments`;
		const reference = asRecord(edit.reference);
		if (!reference) return `${edit.action} skill requires python reference`;
		if (reference.type !== "python") return `${edit.action} skill reference.type must be python`;
		const hasImport = asNonEmptyString(reference.import) ?? asNonEmptyString(reference.python_import);
		const hasCallable = asNonEmptyString(reference.callable) ?? asNonEmptyString(reference.call_pattern);
		if (!hasImport) return `${edit.action} skill requires python import`;
		if (!hasCallable) return `${edit.action} skill requires callable or call_pattern`;
	}
	const existing = state.entries[edit.kind][id];
	if (
		existing &&
		(referencesImmutableBaseSystemPrompt(existing) ||
			existing.immutable === true ||
			asRecord(existing.metadata)?.immutable === true)
	) {
		return referencesImmutableBaseSystemPrompt(existing) ? "base system prompt is immutable" : "entry is immutable";
	}
	if (edit.action === "create" && existing) return "entry already exists";
	if ((edit.action === "update" || edit.action === "delete") && !existing) return "entry not found";
	return undefined;
}

function editExtras(edit: RefinementEdit): Record<string, unknown> {
	const extras = Object.create(null) as Record<string, unknown>;
	for (const [key, value] of Object.entries(edit)) {
		if (!ENTRY_CONTROL_FIELDS.has(key)) extras[key] = structuredClone(value);
	}
	return extras;
}

function entryExtras(entry: HarnessEntry): Record<string, unknown> {
	const extras = Object.create(null) as Record<string, unknown>;
	for (const [key, value] of Object.entries(entry)) {
		if (!ENTRY_CONTROL_FIELDS.has(key)) extras[key] = structuredClone(value);
	}
	return extras;
}

function stateEntry(
	scope: HarnessScope,
	edit: RefinementEdit,
	id: string,
	before: HarnessEntry | undefined,
): HarnessEntry {
	const now = Date.now();
	const beforeRecord = before ? asRecord(before) : undefined;
	const editPath = asNonEmptyString(edit.path);
	const beforePath = asNonEmptyString(beforeRecord?.path);
	const editReference = asRecord(edit.reference);
	const beforeReference = asRecord(beforeRecord?.reference);
	const editArguments = asRecord(edit.arguments);
	const beforeArguments = asRecord(beforeRecord?.arguments);
	const editMetadata = asRecord(edit.metadata);
	const beforeMetadata = asRecord(beforeRecord?.metadata);
	const merged: Record<string, unknown> = {
		...(before ? entryExtras(before) : {}),
		...editExtras(edit),
		id,
		kind: edit.kind,
		title: edit.title ?? before?.title ?? id,
		content: edit.content ?? before?.content ?? "",
		path: editPath ?? beforePath ?? "general",
		scope,
		reference: editReference ?? beforeReference ?? {},
		arguments: editArguments ?? beforeArguments ?? {},
		metadata: editMetadata ?? beforeMetadata ?? {},
		source: "refine",
		created_at: before?.created_at ?? now,
		updated_at: now,
		version: before ? before.version + 1 : 1,
	};
	// A rollback edit may mark an extras key `undefined` to remove a field the
	// applied entry gained; drop those keys instead of persisting null values.
	for (const key of Object.keys(merged)) {
		if (merged[key] === undefined) delete merged[key];
	}
	return merged as HarnessEntry;
}

/** Apply valid edits in place, retaining independent before/after snapshots for rollback. */
export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	const scope = options.scope ?? "local";
	const appliedEdits: AppliedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	for (const edit of proposal.edits) {
		const id = resolveEditId(edit);
		const validationError = validateEdit(edit, state);
		if (validationError) {
			appliedEdits.push({ ...edit, id, applied: false, error: validationError });
			continue;
		}
		if (!isKind(edit.kind) || !isAction(edit.action)) continue;
		const records = state.entries[edit.kind];
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(before) !== JSON.stringify(baseline)
		) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry changed during refinement planning" });
			continue;
		}
		if (edit.action === "delete") {
			delete records[id];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}
		const after = stateEntry(scope, edit, id, before);
		records[id] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...edit, id, before, after: cloneEntry(after), applied: true });
	}
	state.refinements.push({
		id: options.id,
		summary: proposal.summary,
		timestamp: Date.now(),
		scope,
		...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
	});
	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
		scope,
	};
}

function rollbackEdit(
	entry: HarnessEntry,
	action: "create" | "update",
	clearKeys: readonly string[] = [],
): RefinementEdit {
	const edit: RefinementEdit = {
		...entryExtras(entry),
		action,
		kind: entry.kind,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		...(asNonEmptyString(entry.path) ? { path: entry.path } : {}),
		...(asRecord(entry.reference) ? { reference: structuredClone(entry.reference) } : {}),
		...(asRecord(entry.arguments) ? { arguments: structuredClone(entry.arguments) } : {}),
		...(asRecord(entry.metadata) ? { metadata: structuredClone(entry.metadata) } : {}),
	};
	// Fields the applied edit added must be explicitly removed by the inverse.
	for (const key of clearKeys) {
		if (!(key in edit)) (edit as Record<string, unknown>)[key] = undefined;
	}
	return edit;
}

/** Build rollback edits from entry-level inverse snapshots; it never uses workspace checkpoints. */
export function buildRollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			const clearKeys =
				edit.after && edit.action === "update"
					? Object.keys(edit.after).filter(
							key => !ENTRY_CONTROL_FIELDS.has(key) && !(key in (edit.before as Record<string, unknown>)),
						)
					: [];
			edits.push(rollbackEdit(edit.before, edit.after ? "update" : "create", clearKeys));
		} else if (edit.after) {
			edits.push({ action: "delete", kind: edit.kind, id: edit.id });
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restore entry-level before/after snapshots from refinement ${target.id}.`,
		expectedOutcome: "The selected refinement's applied edits are reverted.",
		edits,
	};
}

/** Exported for controller use: preserve a planning baseline without sharing mutable state. */
export function snapshotHarnessState(state: HarnessState): HarnessState {
	return cloneHarnessState(state);
}
