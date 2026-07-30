/**
 * Agent Hub overlay component.
 *
 * - Main remains an internal routing node and never appears as a selectable row.
 * - Hub rows are the stable, Hub-visible order for subagents and read-only advisors.
 * - Enter opens a fullscreen transcript; `f` focuses a live subagent, `m` sends
 *   it a message, `p` returns to its owning Main, and `r`/`x` revive/kill it.
 * - The transcript viewer cycles the same rows in place and tails persisted/local
 *   or collab-host history without changing the ambient runtime.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	Ellipsis,
	Input,
	matchesKey,
	type OverlayHandle,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatAge, getProjectDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../async/job-manager";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { tSettingsUi } from "../../i18n/settings-locale";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	agentDisplayLabel,
	MAIN_AGENT_ID,
	resolveTopLevelAgent,
} from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { AgentProgress, AsyncJobDeliveryStatus } from "../../task/types";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	formatAgentClockTime,
	formatAgentDuration,
	renderAgentStatusBadge,
	selectAgentActivity,
} from "./agent-activity-display";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";
import { rawKeyHint } from "./keybinding-hints";

/** Refresh cadence for live duration, waiting time, and recent activity. */
const HUB_TICK_MS = 1_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize untrusted text for TUI display: replace tabs/newlines, strip controls, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = sanitizeText(replaceTabs(text).replace(/[\r\n]+/g, " "));
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2), Ellipsis.Omit);
}

const HUB_WIDE_MIN_WIDTH = 120;
const HUB_STATUS_WIDTH = 12;
const HUB_PROGRESS_WIDTH = 22;
const HUB_DURATION_WIDTH = 8;
const HUB_MODEL_WIDTH = 28;
const HUB_ACTIVITY_WIDTH = 8;
const HUB_COLUMN_GAP = "  ";
const HUB_DETAIL_LABEL_WIDTH = 16;

function fixedCell(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	return `${clipped}${padding(Math.max(0, width - visibleWidth(clipped)))}`;
}

function progressBar(completed: number, total: number, width = 11): string {
	const safeTotal = Math.max(1, total);
	const safeCompleted = Math.max(0, Math.min(completed, safeTotal));
	const filled = Math.min(width, Math.floor((safeCompleted / safeTotal) * width));
	return `[${"=".repeat(filled)}${".".repeat(width - filled)}]`;
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, waiting: 1, idle: 2, parked: 3, aborted: 4 };

type HubRow = { ref: AgentRef };

interface RenderedHubBlock {
	lines: string[];
	rowIndex?: number;
}

type HubSection = "running" | "attention" | "queued" | "parked" | "completed" | "stopped";

const HUB_SECTION_ORDER: Record<HubSection, number> = {
	running: 0,
	attention: 1,
	queued: 2,
	parked: 3,
	completed: 4,
	stopped: 5,
};

const HUB_SECTION_LABEL: Record<HubSection, string> = {
	running: "Running tasks",
	attention: "Needs attention",
	queued: "Queued",
	parked: "Parked agents",
	completed: "Recently completed",
	stopped: "Stopped",
};

const UUID_LABEL = /^(?:top-level:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", sanitizeText(replaceTabs(modelId).replace(/[\r\n]+/g, " ")));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false): string {
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const sanitized = sanitizeText(replaceTabs(resolved).replace(/[\r\n]+/g, " "));
	const colon = sanitized.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(sanitized.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? sanitized.slice(0, colon) : sanitized;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return formatModelBadge(label, level);
}

/**
 * Active model + reasoning level for a hub row: live session state when the
 * agent is attached, else the executor-reported `resolvedModel` selector
 * (`provider/id`, optionally `:<level>`). Active retry fallbacks retain their
 * provider and carry an explicit marker. Undefined when no model is known
 * (e.g. a parked historical agent restored from disk).
 */
function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const progress = observed?.progress;
	// Prefer the live session's own resolved fallback selector; else honor the
	// executor-reported fallback flag. The latter covers observer-only rows (no
	// live session) AND live rows whose fallback armed no session retry state —
	// e.g. the Fireworks Fast → base degrade, which emits `retry_fallback_applied`
	// without populating `#activeRetryFallback`, so `retryFallbackModel` is undefined.
	const fallbackSelector =
		ref.session?.retryFallbackModel ?? (progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", "fallback →")} ${formatResolvedModelBadge(fallbackSelector, true)}`;
	}
	const model = ref.session?.model;
	if (model) {
		const level = model.thinking ? ref.session?.thinkingLevel : undefined;
		return formatModelBadge(model.id, level);
	}
	const resolved = progress?.resolvedModel;
	return resolved ? formatResolvedModelBadge(resolved) : undefined;
}

/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). */
	focusAgent?: (id: string) => Promise<void>;
	/** Registry identity of the ambient Main runtime. It is header-only, never a selectable row. */
	activeTopLevelId?: string;
	/** Switch the shared TUI to a live background Main runtime. */
	switchTopLevel?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
	/** Whether the hub and nested transcript capture terminal pointer events. Defaults off for native selection. */
	mouseTracking?: boolean;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#remote: AgentHubRemote | undefined;
	#mouseTracking: boolean;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;

	// Table state
	#rows: HubRow[] = [];
	#selectedRow = 0;
	#notice: string | undefined;
	#messageAgentId: string | undefined;
	#messageInput: Input | undefined;
	/** Captured row order from the first refresh; keeps the hub stable while open. */
	#rowOrder: Map<string, number> | undefined;
	/** Screen rows from the latest render that activate a concrete hub row. */
	#rowAtScreenLine = new Map<number, number>();
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;
	#activeTopLevelId: string;
	#switchTopLevel: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#mouseTracking = deps.mouseTracking ?? false;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;
		this.#activeTopLevelId = deps.activeTopLevelId ?? MAIN_AGENT_ID;
		this.#switchTopLevel = deps.switchTopLevel;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), HUB_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile)
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.then(() => {
						this.#refreshRows();
					})
					.finally(() => this.#requestRender());
		this.#refreshRows();
	}

	/**
	 * Whether the current table view has no agents to show (every registered agent
	 * except Main). Persisted historical rows may arrive later; callers that need
	 * those included must wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		return this.#renderTable(width).map(line => clampHubLine(line, width));
	}

	handleInput(keyData: string): void {
		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouseInput(keyData);
			return;
		}
		this.#handleTableInput(keyData);
	}

	/**
	 * Seed the table's left-left close detector with the current time so a single
	 * subsequent `←` (within {@link LEFT_TAP_WINDOW_MS}) dismisses the hub.
	 *
	 * The editor's own double-tap detector consumes the `←←` that opens the hub,
	 * leaving this detector at its fresh `0` — without this handoff the user would
	 * have to press `←←` a second time to escape. Called by the opener when the hub
	 * was raised by that gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			getVisibleAgentIds: () => this.#rows.map(row => row.ref.id),
			onAgentChange: agentId => {
				const rowIndex = this.#rows.findIndex(row => row.ref.id === agentId);
				if (rowIndex >= 0) this.#selectedRow = rowIndex;
			},
			getTaskOutcome: agentId => this.#taskOutcome(agentId, this.#observableFor(agentId)?.progress),
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, {
			width: "100%",
			margin: 0,
			fullscreen: true,
			mouseTracking: this.#mouseTracking,
		});
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#onDataChange();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.ref.id;
		const refs = this.#registry.list().filter(ref => ref.kind !== "main");

		if (!this.#rowOrder) {
			const initial = [...refs].sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(initial.map((ref, index) => [ref.id, index]));
		}

		const rowOrder = this.#rowOrder ?? new Map<string, number>();
		this.#rowOrder = rowOrder;
		for (const ref of refs) {
			if (!rowOrder.has(ref.id)) rowOrder.set(ref.id, rowOrder.size);
		}
		const ordered = [...refs].sort((a, b) => {
			const statusDelta = HUB_SECTION_ORDER[this.#sectionFor(a)] - HUB_SECTION_ORDER[this.#sectionFor(b)];
			return statusDelta || (rowOrder.get(a.id) ?? 0) - (rowOrder.get(b.id) ?? 0);
		});
		this.#rows = ordered.map(ref => ({ ref }));

		const keptIndex = selectedId ? this.#rows.findIndex(row => row.ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	#sectionFor(ref: AgentRef): HubSection {
		const progress = this.#observableFor(ref.id)?.progress;
		if (progress?.status === "pending" || ref.activityState?.phase === "queued") return "queued";
		if (ref.status === "waiting" || ref.activityState?.phase === "waiting-peer") return "attention";
		if (ref.status === "running") return "running";
		if (ref.status === "parked") return "parked";
		if (progress?.status === "failed" || progress?.status === "aborted" || ref.status === "aborted") return "stopped";
		return "completed";
	}

	#displayLabel(ref: AgentRef): string {
		const label = sanitizeText(replaceTabs(agentDisplayLabel(ref)).replace(/[\r\n]+/g, " ")).trim();
		if (!label || UUID_LABEL.test(label)) return ref.kind === "main" ? tSettingsUi("Main") : tSettingsUi("Subagent");
		return label;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(session => session.id === id);
	}

	#taskOutcome(
		agentId: string,
		progress?: AgentProgress,
	): { resultText?: string; deliveryStatus?: AsyncJobDeliveryStatus } | undefined {
		const job = AsyncJobManager.instance()?.getLatestJobForAgent(agentId);
		let resultText = progress?.resultText;
		if (!resultText && job) {
			const detailProgress = job.latestDetails?.progress;
			const firstProgress = Array.isArray(detailProgress) ? detailProgress[0] : undefined;
			const candidate =
				firstProgress && typeof firstProgress === "object" && "resultText" in firstProgress
					? firstProgress.resultText
					: undefined;
			if (typeof candidate === "string") resultText = candidate;
		}
		const deliveryStatus = job?.deliveryStatus ?? progress?.deliveryStatus;
		return resultText || deliveryStatus ? { resultText, deliveryStatus } : undefined;
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		const innerWidth = Math.max(1, width - 2);
		this.#rowAtScreenLine.clear();
		const hintLines = this.#hintLines(width);
		let messageLine: string | undefined;
		if (this.#messageInput && this.#messageAgentId) {
			const target = this.#registry.get(this.#messageAgentId);
			const label = target ? this.#displayLabel(target) : tSettingsUi("Subagent");
			const prefix = ` ${theme.fg("muted", `m → ${label}: `)}`;
			const input = this.#messageInput.render(Math.max(1, innerWidth - visibleWidth(prefix)))[0] ?? "";
			messageLine = truncateToWidth(`${prefix}${input}`, innerWidth);
		}

		lines.push(...new DynamicBorder().render(width));
		const counts = width >= 100 ? this.#statusSummary() : "";
		const title = `${theme.fg("accent", tSettingsUi("Agent Hub"))}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`;
		lines.push(` ${truncateToWidth(title, innerWidth)}`);
		for (const hintLine of hintLines) lines.push(` ${truncateToWidth(hintLine, innerWidth)}`);
		if (messageLine) lines.push(messageLine);

		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", tSettingsUi("no subagents yet — task spawns appear here"))}`);
		} else {
			const termHeight = process.stdout.rows || 40;
			const chromeRows = 3 + hintLines.length + (messageLine ? 1 : 0) + (this.#notice ? 1 : 0);
			const budget = Math.max(3, termHeight - chromeRows);
			const blocks = this.#renderBlocks(width);
			const selectedBlock = Math.max(
				0,
				blocks.findIndex(block => block.rowIndex === this.#selectedRow),
			);
			const fitBlocks = (blockBudget: number): { start: number; end: number; used: number } => {
				let start = selectedBlock;
				let end = Math.min(blocks.length, start + 1);
				let used = blocks[start]?.lines.length ?? 0;
				for (let grew = true; grew; ) {
					grew = false;
					if (end < blocks.length && used + blocks[end]!.lines.length <= blockBudget) {
						used += blocks[end]!.lines.length;
						end++;
						grew = true;
					}
					if (start > 0 && used + blocks[start - 1]!.lines.length <= blockBudget) {
						start--;
						used += blocks[start]!.lines.length;
						grew = true;
					}
				}
				return { start, end, used };
			};
			let blockBudget = budget;
			let { start, end, used } = fitBlocks(blockBudget);
			for (let pass = 0; pass < 3; pass++) {
				const markerRows = (start > 0 ? 1 : 0) + (end < blocks.length ? 1 : 0);
				const nextBudget = Math.max(1, budget - markerRows);
				if (nextBudget === blockBudget) break;
				blockBudget = nextBudget;
				({ start, end, used } = fitBlocks(blockBudget));
			}
			const markerCapacity = Math.max(0, budget - used);
			const showStartMarker = start > 0 && markerCapacity > 0;
			const showEndMarker = end < blocks.length && markerCapacity > (showStartMarker ? 1 : 0);
			if (showStartMarker) {
				lines.push(` ${theme.fg("dim", `… ${tSettingsUi("{count} more", { count: start })}`)}`);
			}
			for (const block of blocks.slice(start, end)) {
				const lineStart = lines.length;
				lines.push(...block.lines);
				if (block.rowIndex !== undefined) {
					for (let offset = 0; offset < block.lines.length; offset++) {
						this.#rowAtScreenLine.set(lineStart + offset, block.rowIndex);
					}
				}
			}
			if (showEndMarker) {
				lines.push(` ${theme.fg("dim", `… ${tSettingsUi("{count} more", { count: blocks.length - end })}`)}`);
			}
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, innerWidth))}`);
		}
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#renderBlocks(width: number): RenderedHubBlock[] {
		const blocks: RenderedHubBlock[] = [];
		if (width >= HUB_WIDE_MIN_WIDTH && this.#rows.length > 0) {
			blocks.push({ lines: [this.#columnHeader(width)] });
		}
		const counts: Record<HubSection, number> = {
			running: 0,
			attention: 0,
			queued: 0,
			parked: 0,
			completed: 0,
			stopped: 0,
		};
		for (const row of this.#rows) counts[this.#sectionFor(row.ref)]++;
		let section: HubSection | undefined;
		for (let rowIndex = 0; rowIndex < this.#rows.length; rowIndex++) {
			const row = this.#rows[rowIndex]!;
			const nextSection = this.#sectionFor(row.ref);
			if (nextSection !== section) {
				section = nextSection;
				blocks.push({
					lines: [
						theme.bold(theme.fg("accent", `${tSettingsUi(HUB_SECTION_LABEL[section])} (${counts[section]})`)),
					],
				});
			}
			blocks.push({
				lines: this.#renderEntry(row, rowIndex === this.#selectedRow, width),
				rowIndex,
			});
		}
		return blocks;
	}

	#columnHeader(width: number): string {
		const max = Math.max(1, width - 2);
		const nameWidth = Math.max(
			18,
			max -
				3 -
				HUB_STATUS_WIDTH -
				HUB_PROGRESS_WIDTH -
				HUB_DURATION_WIDTH -
				HUB_MODEL_WIDTH -
				HUB_ACTIVITY_WIDTH -
				HUB_COLUMN_GAP.length * 5,
		);
		const cells = [
			fixedCell(tSettingsUi("Agent"), nameWidth),
			fixedCell(tSettingsUi("Status"), HUB_STATUS_WIDTH),
			fixedCell(tSettingsUi("Progress"), HUB_PROGRESS_WIDTH),
			fixedCell(tSettingsUi("Duration"), HUB_DURATION_WIDTH),
			fixedCell(tSettingsUi("Model"), HUB_MODEL_WIDTH),
			fixedCell(tSettingsUi("Activity"), HUB_ACTIVITY_WIDTH),
		];
		return theme.fg("dim", `   ${cells.join(HUB_COLUMN_GAP)}`);
	}

	#hintLines(width: number): string[] {
		const maxWidth = Math.max(1, width - 2);
		const separator = theme.fg("dim", theme.sep.dot);
		const clamp = (line: string): string => truncateToWidth(line, maxWidth);
		if (this.#messageInput) {
			return [
				clamp(
					[
						rawKeyHint("Enter", tSettingsUi("send message")),
						rawKeyHint("Esc", tSettingsUi("cancel message")),
					].join(separator),
				),
			];
		}
		const selected = this.#rows[this.#selectedRow];
		const primary = [
			rawKeyHint("j/k", tSettingsUi("select")),
			rawKeyHint("Enter", tSettingsUi("open transcript")),
			rawKeyHint("Esc/←←", tSettingsUi("close")),
		].join(separator);
		if (!selected) return [clamp(primary)];

		const actions: string[] = [];
		const ref = selected.ref;
		const live = ref.status === "running" || ref.status === "waiting" || ref.status === "idle";
		if (live && ref.kind !== "advisor") actions.push(rawKeyHint("f", tSettingsUi("focus")));
		if (ref.status !== "aborted" && ref.kind !== "advisor") actions.push(rawKeyHint("m", tSettingsUi("message")));
		actions.push(rawKeyHint("p", tSettingsUi("Main")));
		if (ref.status === "parked") actions.push(rawKeyHint("r", tSettingsUi("revive")));
		if (ref.status !== "aborted" && ref.kind !== "advisor") actions.push(rawKeyHint("x", tSettingsUi("kill")));
		const secondary = actions.join(separator);
		const combined = `${primary}${separator}${secondary}`;
		return visibleWidth(combined) <= maxWidth ? [combined] : [clamp(primary), clamp(secondary)];
	}

	#statusSummary(): string {
		const counts: Record<AgentStatus, number> = { running: 0, waiting: 0, idle: 0, parked: 0, aborted: 0 };
		for (const row of this.#rows) {
			counts[row.ref.status]++;
		}
		const parts: string[] = [];
		for (const status of ["running", "waiting", "idle", "parked", "aborted"] as const) {
			const count = counts[status];
			if (count > 0) parts.push(`${count} ${tSettingsUi(status)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#renderEntry(row: HubRow, selected: boolean, width: number): string[] {
		const ref = row.ref;
		const max = Math.max(1, width - 2);
		const observed = this.#observableFor(ref.id);
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		const status =
			ref.kind === "advisor" ? theme.fg("warning", tSettingsUi("read-only")) : renderAgentStatusBadge(ref.status);
		const unread = this.#irc.unreadCount(ref.id);
		const label = `${this.#displayLabel(ref)}${unread > 0 ? `  ⧉ ${unread}` : ""}`;
		const model = modelBadge(ref, observed) ?? "—";
		const summary = sanitizeLine(
			progress?.lastIntent ??
				activity?.detail ??
				progress?.currentToolArgs ??
				observed?.description ??
				progress?.task ??
				ref.activity ??
				"—",
			Math.max(1, max - 3 - HUB_DETAIL_LABEL_WIDTH),
		);
		const duration = this.#taskDuration(ref, observed);
		const progressText = this.#progressCell(ref, observed);
		const terminal =
			progress?.status === "completed" ||
			progress?.status === "failed" ||
			progress?.status === "aborted" ||
			ref.status === "idle" ||
			ref.status === "parked" ||
			ref.status === "aborted";
		const activityTime = terminal
			? formatAgentClockTime(progress?.completedAtMs ?? observed?.completedAtMs ?? ref.lastActivity)
			: formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)));
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const entry: string[] = [];

		if (width >= HUB_WIDE_MIN_WIDTH) {
			const nameWidth = Math.max(
				18,
				max -
					3 -
					HUB_STATUS_WIDTH -
					HUB_PROGRESS_WIDTH -
					HUB_DURATION_WIDTH -
					HUB_MODEL_WIDTH -
					HUB_ACTIVITY_WIDTH -
					HUB_COLUMN_GAP.length * 5,
			);
			entry.push(
				` ${cursor} ${[
					fixedCell(theme.bold(label), nameWidth),
					fixedCell(status, HUB_STATUS_WIDTH),
					fixedCell(progressText, HUB_PROGRESS_WIDTH),
					fixedCell(theme.fg("dim", duration), HUB_DURATION_WIDTH),
					fixedCell(model, HUB_MODEL_WIDTH),
					fixedCell(theme.fg("dim", activityTime), HUB_ACTIVITY_WIDTH),
				].join(HUB_COLUMN_GAP)}`,
			);
		} else {
			const suffix = status ? `  ${status}` : "";
			const labelWidth = Math.max(8, max - 3 - visibleWidth(suffix));
			entry.push(` ${cursor} ${fixedCell(theme.bold(label), labelWidth)}${suffix}`);
			entry.push(
				`   ${fixedCell(progressText, Math.max(18, max - HUB_DURATION_WIDTH - 5))}${HUB_COLUMN_GAP}${theme.fg("dim", duration)}`,
			);
			entry.push(
				`   ${fixedCell(theme.fg("dim", tSettingsUi("Model")), HUB_DETAIL_LABEL_WIDTH)}${truncateToWidth(model, Math.max(1, max - 3 - HUB_DETAIL_LABEL_WIDTH))}`,
			);
		}

		entry.push(`   ${fixedCell(theme.fg("dim", tSettingsUi("Dynamic summary")), HUB_DETAIL_LABEL_WIDTH)}${summary}`);
		const outcome = terminal ? this.#taskOutcome(ref.id, progress) : undefined;
		if (outcome?.resultText) {
			entry.push(
				`   ${fixedCell(theme.fg("dim", tSettingsUi("Task result")), HUB_DETAIL_LABEL_WIDTH)}${sanitizeLine(outcome.resultText, Math.max(1, max - 3 - HUB_DETAIL_LABEL_WIDTH))}`,
			);
		}
		const reportStatus = terminal
			? this.#deliveryLabel(outcome?.deliveryStatus, Boolean(outcome?.resultText))
			: undefined;
		if (reportStatus) {
			entry.push(
				`   ${fixedCell(theme.fg("dim", tSettingsUi("Report status")), HUB_DETAIL_LABEL_WIDTH)}${reportStatus}`,
			);
		}
		if (activity?.phase === "waiting-peer") {
			const waiting = formatAgentDuration(Date.now() - activity.phaseStartedAtMs);
			entry.push(
				`   ${fixedCell(theme.fg("dim", tSettingsUi("Waiting for Main")), HUB_DETAIL_LABEL_WIDTH)}${waiting}${theme.fg("dim", `${theme.sep.dot}${tSettingsUi("Duration {duration}", { duration })}`)}`,
			);
		}

		if (!selected) return entry;
		return entry.map(line => {
			const clipped = truncateToWidth(line, max);
			return theme.bg("selectedBg", `${clipped}${padding(Math.max(0, max - visibleWidth(clipped)))}`);
		});
	}

	#deliveryLabel(status: AsyncJobDeliveryStatus | undefined, hasResult: boolean): string | undefined {
		switch (status) {
			case "pending":
				return theme.fg("warning", tSettingsUi("Delivery pending"));
			case "delivering":
				return theme.fg("accent", tSettingsUi("Delivering to Main"));
			case "delivered":
				return theme.fg("success", tSettingsUi("Delivered to Main"));
			case "dead-letter":
				return theme.fg("error", tSettingsUi("Main unavailable"));
			default:
				return hasResult ? theme.fg("success", tSettingsUi("Delivered to Main")) : undefined;
		}
	}

	#taskDuration(ref: AgentRef, observed: ObservableSession | undefined): string {
		const progress = observed?.progress;
		const startedAtMs = progress?.startedAtMs ?? observed?.startedAtMs;
		const completedAtMs = progress?.completedAtMs ?? observed?.completedAtMs;
		const terminal =
			progress?.status === "completed" ||
			progress?.status === "failed" ||
			progress?.status === "aborted" ||
			ref.status === "idle" ||
			ref.status === "parked" ||
			ref.status === "aborted";
		if (startedAtMs !== undefined) {
			const end = terminal
				? (completedAtMs ??
					(progress?.durationMs !== undefined ? startedAtMs + progress.durationMs : ref.lastActivity))
				: Date.now();
			return formatAgentDuration(Math.max(0, end - startedAtMs));
		}
		return progress?.durationMs !== undefined ? formatAgentDuration(progress.durationMs) : "--:--:--";
	}

	#progressCell(ref: AgentRef, observed: ObservableSession | undefined): string {
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		const determinate = activity?.progress;
		if (determinate && Number.isFinite(determinate.total) && determinate.total > 0) {
			const completed = Math.max(0, Math.min(determinate.completed, determinate.total));
			return `${progressBar(completed, determinate.total)} ${completed}/${determinate.total}`;
		}
		if (progress?.status === "completed" || ref.status === "idle" || ref.status === "parked") {
			return `${progressBar(1, 1)} ${tSettingsUi("completed")}`;
		}
		if (progress?.status === "failed" || progress?.status === "aborted" || ref.status === "aborted") {
			return `${progressBar(1, 1)} ${tSettingsUi(progress?.status ?? "aborted")}`;
		}
		const phase = activity?.label ? tSettingsUi(activity.label) : tSettingsUi(ref.status);
		return `${progressBar(0, 1)} ${phase}`;
	}

	#handleTableInput(keyData: string): void {
		if (this.#messageInput) {
			this.#handleMessageInput(keyData);
			return;
		}
		if (matchesKey(keyData, "escape")) {
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#activateSelected();
			return;
		}
		if (keyData === "f") {
			this.#focusSelected();
			return;
		}
		if (keyData === "m") {
			this.#startMessage();
			return;
		}
		if (keyData === "p") {
			this.#switchToMain();
			return;
		}
		if (keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (keyData === "x") {
			this.#killSelected();
		}
	}

	#moveSelection(delta: -1 | 1): void {
		if (this.#rows.length === 0) return;
		this.#selectedRow = Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1));
		this.#requestRender();
	}

	#handleMessageInput(keyData: string): void {
		const input = this.#messageInput;
		const agentId = this.#messageAgentId;
		if (!input || !agentId) {
			this.#messageInput = undefined;
			this.#messageAgentId = undefined;
			return;
		}
		if (matchesKey(keyData, "escape")) {
			this.#messageInput = undefined;
			this.#messageAgentId = undefined;
			this.#notice = undefined;
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#submitMessage(agentId, input.getValue());
			return;
		}
		input.handleInput(keyData);
		this.#requestRender();
	}

	#startMessage(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		if (ref.kind === "advisor") {
			this.#notice = `"${this.#displayLabel(ref)}" is a read-only advisor transcript and cannot be messaged.`;
			this.#requestRender();
			return;
		}
		if (ref.status === "aborted") {
			this.#notice = `"${this.#displayLabel(ref)}" was aborted and cannot be messaged.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		this.#messageAgentId = ref.id;
		this.#messageInput = new Input();
		this.#requestRender();
	}

	#submitMessage(agentId: string, body: string): void {
		const text = body.trim();
		if (!text) {
			this.#notice = "Type a message before sending.";
			this.#requestRender();
			return;
		}
		const target = this.#registry.get(agentId);
		if (!target || target.kind === "advisor" || target.status === "aborted") {
			this.#messageInput = undefined;
			this.#messageAgentId = undefined;
			this.#notice = target
				? `"${this.#displayLabel(target)}" cannot receive a message.`
				: "The selected subagent is no longer available.";
			this.#requestRender();
			return;
		}
		this.#messageInput = undefined;
		this.#messageAgentId = undefined;
		this.#notice = undefined;
		if (this.#remote) {
			try {
				this.#remote.chat(agentId, text);
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#requestRender();
			return;
		}
		void this.#irc
			.send({ from: this.#activeTopLevelId, to: agentId, body: text })
			.then(receipt => {
				if (receipt.outcome === "failed") this.#notice = receipt.error ?? "Message delivery failed.";
				this.#requestRender();
			})
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#handleMouseInput(keyData: string): void {
		if (this.#messageInput) return;
		routeSgrMouseInput(keyData, (event: SgrMouseEvent) => {
			if (event.wheel !== null) {
				this.#moveSelection(event.wheel);
				return true;
			}
			if (!event.leftClick) return true;
			const rowIndex = this.#rowAtScreenLine.get(event.row);
			if (rowIndex === undefined) return true;
			this.#selectedRow = rowIndex;
			this.#requestRender();
			this.#activateSelected();
			return true;
		});
	}

	#activateSelected(): void {
		const selected = this.#rows[this.#selectedRow];
		if (!selected) return;
		this.#notice = undefined;
		this.openChat(selected.ref.id);
	}

	#switchSelectedMain(ref: AgentRef): void {
		const switchTopLevel = this.#switchTopLevel;
		if (!switchTopLevel) {
			this.#notice = `Cannot switch to "${this.#displayLabel(ref)}" from this Agent Hub.`;
			this.#requestRender();
			return;
		}
		void switchTopLevel(ref.id)
			.then(() => this.#onDone())
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
	}

	#focusSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		const isLive =
			ref.session !== null && (ref.status === "running" || ref.status === "waiting" || ref.status === "idle");
		if (ref.kind === "advisor") {
			this.#notice = `"${this.#displayLabel(ref)}" is a read-only advisor transcript.`;
			this.#requestRender();
			return;
		}
		if (!isLive) {
			this.#notice = `"${this.#displayLabel(ref)}" is not live; open its transcript or revive it first.`;
			this.#requestRender();
			return;
		}
		const focusAgent = this.#focusAgent;
		if (!focusAgent) {
			this.#notice = "Live subagent focus is unavailable in this Agent Hub.";
			this.#requestRender();
			return;
		}
		const root = resolveTopLevelAgent(this.#registry, ref.id);
		const needsSwitch = root !== undefined && root.id !== this.#activeTopLevelId;
		const switchTopLevel = needsSwitch ? this.#switchTopLevel : undefined;
		if (root && needsSwitch && !switchTopLevel) {
			this.#notice = `Switching to "${this.#displayLabel(root)}" is unavailable in this Agent Hub.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		void (async () => {
			try {
				if (root && switchTopLevel) await switchTopLevel(root.id);
				await focusAgent(ref.id);
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#switchToMain(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const parent = resolveTopLevelAgent(this.#registry, row.ref.id);
		if (!parent) {
			this.#notice = `The Main for "${this.#displayLabel(row.ref)}" is unavailable.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (parent.id === this.#activeTopLevelId) {
			this.#onDone();
			return;
		}
		this.#switchSelectedMain(parent);
	}

	#reviveSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		if (ref.kind === "advisor") {
			this.#notice = `"${this.#displayLabel(ref)}" is a read-only advisor transcript — nothing to revive.`;
			this.#requestRender();
			return;
		}
		if (ref.status !== "parked") {
			this.#notice = `"${this.#displayLabel(ref)}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		if (ref.kind === "advisor") {
			this.#notice = `"${this.#displayLabel(ref)}" is a read-only advisor transcript — cannot be killed.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				if ((ref.status === "running" || ref.status === "waiting") && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id, ref);
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
