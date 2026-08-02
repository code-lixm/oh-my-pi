import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { CheckpointSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/checkpoint-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type {
	CustomEntry,
	SessionEntry,
	SessionMessageEntry,
	WorkspaceCheckpointEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { WorkspaceCheckpointAccessResult } from "@oh-my-pi/pi-coding-agent/session/workspace-checkpoint-coordinator";
import type {
	WorkspaceCheckpointCompleteness,
	WorkspaceCheckpointReason,
	WorkspaceCheckpointRecord,
	WorkspaceRestorePlan,
	WorkspaceRestoreResult,
	WorkspaceRestoreScope,
} from "@oh-my-pi/pi-coding-agent/workspace-checkpoints/types";
import { getSettingsUiLocale, type SettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

const ENTRY_TIME = "2026-07-28T12:00:00.000Z";
const DOWN = "\x1b[B";
const ENTER = "\n";
let previousLocale: SettingsUiLocale;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
});

afterEach(() => {
	setSettingsUiLocale(previousLocale);
	vi.restoreAllMocks();
});

function checkpointRecord(options: {
	id: string;
	label: string | null;
	reason: WorkspaceCheckpointReason;
	completeness: WorkspaceCheckpointCompleteness;
	createdAt: string;
}): WorkspaceCheckpointRecord {
	return {
		id: options.id,
		workspaceId: "workspace-test",
		rootPath: "/workspace",
		manifestObjectId: `sha256:${options.id}`,
		parentId: null,
		sessionId: "session-test",
		sessionEntryId: null,
		promptEntryId: null,
		label: options.label,
		reason: options.reason,
		completeness: options.completeness,
		createdAt: options.createdAt,
		fileCount: 1,
		totalBytes: 24,
		pinned: false,
	};
}

function checkpointEntry(
	id: string,
	parentId: string,
	checkpoint: WorkspaceCheckpointRecord,
): WorkspaceCheckpointEntry {
	return {
		type: "workspace_checkpoint",
		id,
		parentId,
		timestamp: ENTRY_TIME,
		checkpointId: checkpoint.id,
		workspaceId: checkpoint.workspaceId,
		rootPath: checkpoint.rootPath,
		reason: checkpoint.reason,
		label: checkpoint.label,
		manifestObjectId: checkpoint.manifestObjectId,
		fileCount: checkpoint.fileCount,
		totalBytes: checkpoint.totalBytes,
		guardCheckpointId: null,
		createdAt: checkpoint.createdAt,
	};
}

function bookkeepingEntry(id: string, parentId: string): CustomEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: ENTRY_TIME,
		customType: "checkpoint-selector-test-bookkeeping",
		data: {},
	};
}

function userEntry(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: ENTRY_TIME,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function branchEntries(
	rootId: string,
	entryId: string,
	checkpoint: WorkspaceCheckpointRecord,
	prompt: string,
): SessionEntry[] {
	const bookkeepingId = `${entryId}-bookkeeping`;
	return [
		checkpointEntry(entryId, rootId, checkpoint),
		bookkeepingEntry(bookkeepingId, entryId),
		userEntry(`${entryId}-user`, bookkeepingId, prompt),
	];
}

function branchableUserMessages(entries: readonly SessionEntry[]): Array<{ entryId: string; text: string }> {
	return entries.flatMap(entry => {
		if (entry.type !== "message" || entry.message.role !== "user" || typeof entry.message.content !== "string") {
			return [];
		}
		return [{ entryId: entry.id, text: entry.message.content }];
	});
}
function restorePlan(checkpointId: string, scope: WorkspaceRestoreScope): WorkspaceRestorePlan {
	return {
		id: `plan-${scope}`,
		checkpointId,
		rootPath: "/workspace",
		scope,
		strategy: "preserve",
		operations: [{ path: "src/restored.ts", kind: "update" }],
		conflicts: [],
		conversationEntryId: null,
		createdAt: ENTRY_TIME,
	};
}

function restoreResult(
	plan: Pick<WorkspaceRestorePlan, "checkpointId" | "scope" | "strategy">,
): WorkspaceRestoreResult {
	return {
		transactionId: `transaction-${plan.checkpointId}`,
		checkpointId: plan.checkpointId,
		guardCheckpointId: null,
		restoredPaths: ["src/restored.ts"],
		skippedPaths: [],
		conversationEntryId: null,
		redoAvailable: true,
		scope: plan.scope,
		strategy: plan.strategy,
	};
}

interface CheckpointSelectorHarness {
	show(): Promise<CheckpointSelectorComponent>;
}

interface CheckpointSelectorHarnessOptions {
	getEntries?: () => SessionEntry[];
	previewWorkspaceRestore?: (request: {
		checkpointId: string;
		scope: WorkspaceRestoreScope;
		strategy: "preserve";
	}) => Promise<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>;
	applyWorkspaceRestore?: (
		planId: string,
		allowConflicts?: boolean,
	) => Promise<WorkspaceCheckpointAccessResult<WorkspaceRestoreResult>>;
	clearTransientSessionUi?: () => void;
	rebuildChatFromMessages?: () => void;
	resetDisplay?: () => void;
	showStatus?: (message: string) => void;
}

function createHarness(
	checkpoints: WorkspaceCheckpointRecord[],
	entries: SessionEntry[],
	options: CheckpointSelectorHarnessOptions = {},
): CheckpointSelectorHarness {
	let selector: CheckpointSelectorComponent | undefined;
	const getEntries = () => options.getEntries?.() ?? entries;
	const ctx = {
		session: {
			listWorkspaceCheckpoints: async () => ({ available: true, value: checkpoints }),
			getUserMessagesForBranching: () => branchableUserMessages(getEntries()),
			previewWorkspaceRestore:
				options.previewWorkspaceRestore ??
				(async () => ({ available: false, reason: "not needed by this list test" })),
			applyWorkspaceRestore:
				options.applyWorkspaceRestore ??
				(async () => ({ available: false, reason: "not needed by this list test" })),
			isBashRunning: false,
			isEvalRunning: false,
			isCompacting: false,
		},
		sessionManager: { getEntries },
		clearTransientSessionUi: options.clearTransientSessionUi ?? (() => {}),
		rebuildChatFromMessages: options.rebuildChatFromMessages ?? (() => {}),
		showError() {},
		showStatus(message: string) {
			options.showStatus?.(message);
		},
		editorContainer: { children: [] },
		editor: {},
		ui: {
			showOverlay(component: CheckpointSelectorComponent) {
				selector = component;
				return { hide() {}, setHidden() {}, isHidden: () => false };
			},
			setFocus() {},
			requestRender() {},
			resetDisplay: options.resetDisplay ?? (() => {}),
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	return {
		async show() {
			await controller.showCheckpointSelector();
			if (!selector) throw new Error("Expected checkpoint selector overlay");
			return selector;
		},
	};
}

function rendered(selector: CheckpointSelectorComponent): string {
	return Bun.stripANSI(selector.render(180).join("\n"));
}

function typeText(selector: CheckpointSelectorComponent, text: string): void {
	for (const char of text) selector.handleInput(char);
}

interface ConversationUiState {
	transientRows: string[];
	transcript: string[];
	display: string[];
}

interface RestoreHarness {
	apply(scope: WorkspaceRestoreScope): Promise<void>;
	previewScopes(): WorkspaceRestoreScope[];
	uiState(): ConversationUiState;
}

function createRestoreHarness(): RestoreHarness {
	const checkpoint = checkpointRecord({
		id: "ckpt-restore-ui",
		label: "Before transcript refresh",
		reason: "manual",
		completeness: "complete",
		createdAt: ENTRY_TIME,
	});
	const staleEntries = [userEntry("stale-root", "", "Stale session branch")];
	const restoredEntries = [userEntry("restored-root", "", "Restored session branch")];
	let activeEntries = staleEntries;
	const transientRows = ["streaming tool output"];
	let transcript = ["Rendered stale transcript"];
	let display = [...transcript];
	let selectedScope: WorkspaceRestoreScope | undefined;
	let previewPlan: WorkspaceRestorePlan | undefined;
	const previewScopes: WorkspaceRestoreScope[] = [];
	const previewStarted = Promise.withResolvers<void>();
	const previewGate = Promise.withResolvers<WorkspaceCheckpointAccessResult<WorkspaceRestorePlan>>();
	const applied = Promise.withResolvers<void>();
	const picker = createHarness([checkpoint], staleEntries, {
		getEntries: () => activeEntries,
		previewWorkspaceRestore: async request => {
			selectedScope = request.scope;
			previewScopes.push(request.scope);
			previewStarted.resolve();
			return previewGate.promise;
		},
		applyWorkspaceRestore: async () => {
			if (!previewPlan) throw new Error("Expected a previewed restore plan");
			if (previewPlan.scope === "conversation" || previewPlan.scope === "all") activeEntries = restoredEntries;
			return { available: true, value: restoreResult(previewPlan) };
		},
		clearTransientSessionUi: () => {
			transientRows.length = 0;
		},
		rebuildChatFromMessages: () => {
			transcript = branchableUserMessages(activeEntries).map(message => message.text);
		},
		resetDisplay: () => {
			display = [...transcript];
		},
		showStatus: () => applied.resolve(),
	});

	return {
		async apply(scope) {
			const selector = await picker.show();
			selector.handleInput(ENTER);
			for (let index = 0; index < ["code", "conversation", "all"].indexOf(scope); index += 1) {
				selector.handleInput(DOWN);
			}
			selector.handleInput(ENTER);
			await previewStarted.promise;
			if (!selectedScope) throw new Error("Expected a restore preview request");
			const plan = restorePlan(checkpoint.id, selectedScope);
			previewPlan = plan;
			previewGate.resolve({ available: true, value: plan });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			selector.handleInput(ENTER);
			await applied.promise;
		},
		previewScopes: () => [...previewScopes],
		uiState: () => ({ transientRows: [...transientRows], transcript: [...transcript], display: [...display] }),
	};
}

describe("SelectorController.showCheckpointSelector applied restores", () => {
	for (const scope of ["conversation", "all"] as const) {
		it(`clears transient UI and rebuilds the display from the switched branch after a ${scope} restore`, async () => {
			const harness = createRestoreHarness();

			await harness.apply(scope);

			expect(harness.previewScopes()).toEqual([scope]);
			expect(harness.uiState()).toEqual({
				transientRows: [],
				transcript: ["Restored session branch"],
				display: ["Restored session branch"],
			});
		});
	}

	it("keeps the conversation UI intact after a code-only restore", async () => {
		const harness = createRestoreHarness();

		await harness.apply("code");

		expect(harness.previewScopes()).toEqual(["code"]);
		expect(harness.uiState()).toEqual({
			transientRows: ["streaming tool output"],
			transcript: ["Rendered stale transcript"],
			display: ["Rendered stale transcript"],
		});
	});
});
describe("SelectorController.showCheckpointSelector prompt summaries", () => {
	it("renders and filters an automatic checkpoint by the user prompt reached through bookkeeping entries", async () => {
		const automatic = checkpointRecord({
			id: "ckpt-auto",
			label: null,
			reason: "turn",
			completeness: "complete",
			createdAt: ENTRY_TIME,
		});
		const unrelated = checkpointRecord({
			id: "ckpt-unrelated",
			label: null,
			reason: "turn",
			completeness: "complete",
			createdAt: ENTRY_TIME,
		});
		const automaticPrompt = "Cobalt river request updates the checkout migration";
		const entries: SessionEntry[] = [
			userEntry("conversation-root", "", "Start the session"),
			...branchEntries("conversation-root", "auto-checkpoint-entry", automatic, automaticPrompt),
			...branchEntries(
				"conversation-root",
				"unrelated-checkpoint-entry",
				unrelated,
				"Amber summit unrelated request",
			),
		];
		const selector = await createHarness([automatic, unrelated], entries).show();

		typeText(selector, "cobalt");
		const output = rendered(selector);

		expect(output).toContain(automaticPrompt);
		expect(output).not.toContain("Amber summit unrelated request");
		expect(output).not.toContain("No matching checkpoints");
	});

	it("keeps prompt searches on their checkpoint branch while labels override prompts and legacy checkpoints keep their id", async () => {
		const alphaLabel = "Alpha checkpoint label";
		const betaLabel = "Beta checkpoint label";
		const alpha = checkpointRecord({
			id: "ckpt-alpha",
			label: alphaLabel,
			reason: "manual",
			completeness: "complete",
			createdAt: ENTRY_TIME,
		});
		const beta = checkpointRecord({
			id: "ckpt-beta",
			label: betaLabel,
			reason: "manual",
			completeness: "complete",
			createdAt: ENTRY_TIME,
		});
		const legacy = checkpointRecord({
			id: "ckpt-legacy-without-prompt",
			label: null,
			reason: "turn",
			completeness: "complete",
			createdAt: ENTRY_TIME,
		});
		const alphaPrompt = "Cobalt river prompt belongs only to alpha";
		const betaPrompt = "Amber summit prompt belongs only to beta";
		const entries: SessionEntry[] = [
			userEntry("conversation-root", "", "Start the session"),
			...branchEntries("conversation-root", "alpha-checkpoint-entry", alpha, alphaPrompt),
			...branchEntries("conversation-root", "beta-checkpoint-entry", beta, betaPrompt),
		];
		const selector = await createHarness([alpha, beta, legacy], entries).show();

		const initialOutput = rendered(selector);
		expect(initialOutput).toContain(alphaLabel);
		expect(initialOutput).toContain(betaLabel);
		expect(initialOutput).toContain(legacy.id);
		expect(initialOutput).not.toContain(alphaPrompt);
		expect(initialOutput).not.toContain(betaPrompt);

		typeText(selector, "cobalt");
		const filteredOutput = rendered(selector);
		expect(filteredOutput).toContain(alphaLabel);
		expect(filteredOutput).not.toContain(betaLabel);
		expect(filteredOutput).not.toContain(legacy.id);
	});

	it("renders checkpoint completeness and relative age in zh-CN without English fallbacks", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-28T12:02:00.000Z"));
		setSettingsUiLocale("zh-CN");
		const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
		const checkpoints = [
			checkpointRecord({
				id: "checkpoint-one",
				label: "条目甲",
				reason: "turn",
				completeness: "complete",
				createdAt: twoMinutesAgo,
			}),
			checkpointRecord({
				id: "checkpoint-two",
				label: "条目乙",
				reason: "turn",
				completeness: "partial",
				createdAt: twoMinutesAgo,
			}),
			checkpointRecord({
				id: "checkpoint-three",
				label: "条目丙",
				reason: "turn",
				completeness: "corrupt",
				createdAt: twoMinutesAgo,
			}),
		];
		const selector = await createHarness(checkpoints, []).show();
		const output = rendered(selector);

		expect(output).toContain("完整");
		expect(output).toContain("不完整");
		expect(output).toContain("损坏");
		expect(output).toContain("前");
		expect(output).not.toContain("complete");
		expect(output).not.toContain("partial");
		expect(output).not.toContain("corrupt");
		expect(output).not.toContain("ago");
	});
});
