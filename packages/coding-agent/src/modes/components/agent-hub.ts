/**
 * Agent Hub overlay component.
 *
 * - Main and advisors are internal routing/observability nodes, never selectable rows.
 * - Rows use shared status priority and newest creation first; activity heartbeats never reorder a group.
 * - Enter opens a fullscreen transcript; `f` focuses a live subagent, and
 *   `r`/`x` resume/terminate a task.
 * - The transcript viewer cycles the same rows in place and tails persisted/local
 *   or collab-host history without changing the ambient runtime.
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import type { Clipboard, SnapshotStore } from "@oh-my-pi/hashline";
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	Ellipsis,
	matchesKey,
	type OverlayHandle,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatAge, getProjectDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	agentDisplayLabel,
	compareAgentNavigationOrder,
	MAIN_AGENT_ID,
	resolveTopLevelAgent,
} from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { AgentProgress } from "../../task";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { formatAgentClockTime, formatAgentDuration, selectAgentActivity } from "./agent-activity-display";
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
const HUB_STATUS_WIDTH = 26;
const HUB_DURATION_WIDTH = 8;
const HUB_MODEL_WIDTH = 28;
const HUB_ACTIVITY_WIDTH = 8;
const HUB_COLUMN_GAP = "  ";

function fixedCell(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	return `${clipped}${padding(Math.max(0, width - visibleWidth(clipped)))}`;
}

type HubTaskStatus = "not-started" | "running" | "waiting-user" | "completed" | "failed" | "stopped";

type HubRow = { ref: AgentRef };

/** Maps existing Hub presentation statuses to the shared navigation comparator's status model. */
const HUB_NAVIGATION_STATUS: Record<HubTaskStatus, AgentStatus | AgentProgress["status"]> = {
	"not-started": "pending",
	running: "running",
	"waiting-user": "waiting",
	completed: "completed",
	failed: "failed",
	stopped: "aborted",
};

interface RenderedHubEntry {
	lines: string[];
	rowIndex?: number;
}

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
	const resolved = progress?.resolvedModel ?? observed?.resolvedModel;
	const resolvedIsFallback = progress?.resolvedModelIsFallback ?? observed?.resolvedModelIsFallback;
	// Prefer the live session's own resolved fallback selector; else honor the
	// executor-reported fallback flag. The latter covers observer-only rows (no
	// live session) AND live rows whose fallback armed no session retry state —
	// e.g. the Fireworks Fast → base degrade, which emits `retry_fallback_applied`
	// without populating `#activeRetryFallback`, so `retryFallbackModel` is undefined.
	const fallbackSelector = ref.session?.retryFallbackModel ?? (resolvedIsFallback ? resolved : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", `${tSettingsUi("fallback")} →`)} ${formatResolvedModelBadge(fallbackSelector, true)}`;
	}
	const model = ref.session?.model;
	if (model) {
		const level = model.thinking ? ref.session?.thinkingLevel : undefined;
		return formatModelBadge(model.id, level);
	}
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
	/** Resolve snapshot state for the selected live local agent. */
	getSnapshots?: (agentId: string) => SnapshotStore | undefined;
	/** Resolve the edit register for the selected live local agent. */
	getClipboard?: (agentId: string) => Clipboard | undefined;
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
	/**
	 * Click handler for Markdown link cells inside the fullscreen transcript
	 * viewer. The host typically derives this from the ambient
	 * InteractiveModeContext.openInBrowser; omit to leave Markdown link cells
	 * non-clickable in the viewer.
	 */
	openLink?: (href: string) => void;
	/**
	 * Click handler for tool-result / native assistant images (and the
	 * no-protocol text fallback) inside the fullscreen transcript viewer. The
	 * host materializes original bytes via its session blob store and routes
	 * through openInBrowser; omit to leave image cells non-clickable.
	 */
	openImage?: (image: import("@oh-my-pi/pi-ai").ImageContent) => void;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#dataChangeUrgent = false;
	#remote: AgentHubRemote | undefined;
	#mouseTracking: boolean;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;

	// Table state
	#observedById = new Map<string, ObservableSession>();
	#rows: HubRow[] = [];
	#selectedRow = 0;
	#notice: string | undefined;
	/** Screen rows from the latest render that activate a concrete hub row. */
	#rowAtScreenLine = new Map<number, number>();
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#getSnapshots: ((agentId: string) => SnapshotStore | undefined) | undefined;
	#getClipboard: ((agentId: string) => Clipboard | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;
	#activeTopLevelId: string;
	#switchTopLevel: ((id: string) => Promise<void>) | undefined;
	// Rich-content click handlers the hub forwards into AgentTranscriptViewer so the
	// fullscreen transcript stays clickable for Markdown links / images.
	#openLink: ((href: string) => void) | undefined;
	#openImage: ((image: import("@oh-my-pi/pi-ai").ImageContent) => void) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
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
		this.#getSnapshots = deps.getSnapshots;
		this.#getClipboard = deps.getClipboard;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;
		this.#activeTopLevelId = deps.activeTopLevelId ?? MAIN_AGENT_ID;
		this.#switchTopLevel = deps.switchTopLevel;
		this.#openLink = deps.openLink;
		this.#openImage = deps.openImage;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange(true)));
		this.#unsubscribers.push(this.#observers.onChange(kind => this.#scheduleDataChange(kind !== "progress")));
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
	 * Hub rows are task subagents only. Main, advisors, and other internal
	 * registry nodes remain routing targets but never occupy dashboard rows.
	 * Because persisted rows register asynchronously, callers that need a
	 * settled empty-state decision must await {@link persistedSubagentsReady}.
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
		this.#dataChangeUrgent = false;
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
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			getSnapshots: this.#getSnapshots,
			getClipboard: this.#getClipboard,
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
			openLink: this.#openLink,
			openImage: this.#openImage,
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

	#scheduleDataChange(urgent = false): void {
		if (this.#dataChangeTimer) {
			if (!urgent || this.#dataChangeUrgent) return;
			clearTimeout(this.#dataChangeTimer);
		}
		this.#dataChangeUrgent = urgent;
		this.#dataChangeTimer = setTimeout(
			() => {
				this.#dataChangeTimer = undefined;
				this.#dataChangeUrgent = false;
				this.#onDataChange();
			},
			urgent ? 0 : DATA_CHANGE_RENDER_COALESCE_MS,
		);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.ref.id;
		this.#observedById = new Map(this.#observers.getSessions().map(observed => [observed.id, observed]));
		const rows = this.#registry
			.list()
			.filter(ref => ref.kind === "sub")
			.map(ref => ({ ref, status: this.#taskStatus(ref, this.#observedById.get(ref.id)) }))
			.sort((left, right) =>
				compareAgentNavigationOrder(
					left.ref,
					right.ref,
					HUB_NAVIGATION_STATUS[left.status],
					HUB_NAVIGATION_STATUS[right.status],
				),
			)
			.map(({ ref }) => ({ ref }));
		this.#rows = rows;

		const keptIndex = selectedId ? this.#rows.findIndex(row => row.ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	#taskStatus(ref: AgentRef, observed: ObservableSession | undefined): HubTaskStatus {
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		if (progress?.status === "failed" || observed?.status === "failed") return "failed";
		if (progress?.status === "aborted" || observed?.status === "aborted" || ref.status === "aborted")
			return "stopped";
		if (progress?.status === "completed" || observed?.status === "completed") return "completed";
		if (progress?.status === "pending" || activity?.phase === "queued") return "not-started";
		if (ref.status === "waiting" || activity?.phase === "waiting-user" || activity?.phase === "waiting-peer")
			return "waiting-user";
		if (
			progress?.status === "running" ||
			observed?.status === "active" ||
			ref.status === "running" ||
			(activity !== undefined && activity.phase !== "idle")
		) {
			return "running";
		}
		return "completed";
	}

	#renderTaskStatus(status: HubTaskStatus): string {
		switch (status) {
			case "not-started":
				return theme.fg("warning", tSettingsUi("Not started"));
			case "running":
				return theme.fg("success", tSettingsUi("Running"));
			case "waiting-user":
				return theme.fg("warning", tSettingsUi("Waiting for user"));
			case "completed":
				return theme.fg("success", tSettingsUi("Completed"));
			case "failed":
				return theme.fg("error", tSettingsUi("Failed"));
			case "stopped":
				return theme.fg("muted", tSettingsUi("Stopped"));
		}
	}

	#displayLabel(ref: AgentRef): string {
		const label = sanitizeText(replaceTabs(agentDisplayLabel(ref)).replace(/[\r\n]+/g, " ")).trim();
		if (!label || UUID_LABEL.test(label)) return ref.kind === "main" ? tSettingsUi("Main") : tSettingsUi("Subagent");
		return label;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observedById.get(id);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		this.#observedById = new Map(this.#observers.getSessions().map(observed => [observed.id, observed]));
		const lines: string[] = [];
		const innerWidth = Math.max(1, width - 2);
		this.#rowAtScreenLine.clear();
		const hintLines = this.#hintLines(width);

		lines.push(...new DynamicBorder().render(width));
		const title = theme.fg("accent", tSettingsUi("Agent Hub"));
		lines.push(` ${truncateToWidth(title, innerWidth)}`);
		for (const hintLine of hintLines) lines.push(` ${truncateToWidth(hintLine, innerWidth)}`);

		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", tSettingsUi("No tasks yet"))}`);
		} else {
			const termHeight = process.stdout.rows || 40;
			const chromeRows = 3 + hintLines.length + (this.#notice ? 1 : 0);
			const budget = Math.max(3, termHeight - chromeRows);
			const entries = this.#renderEntries(width);
			const selectedEntry = Math.max(
				0,
				entries.findIndex(entry => entry.rowIndex === this.#selectedRow),
			);
			const fitEntries = (entryBudget: number): { start: number; end: number; used: number } => {
				let start = selectedEntry;
				let end = Math.min(entries.length, start + 1);
				let used = entries[start]?.lines.length ?? 0;
				for (let grew = true; grew; ) {
					grew = false;
					if (end < entries.length && used + entries[end]!.lines.length <= entryBudget) {
						used += entries[end]!.lines.length;
						end++;
						grew = true;
					}
					if (start > 0 && used + entries[start - 1]!.lines.length <= entryBudget) {
						start--;
						used += entries[start]!.lines.length;
						grew = true;
					}
				}
				return { start, end, used };
			};
			let entryBudget = budget;
			let { start, end, used } = fitEntries(entryBudget);
			for (let pass = 0; pass < 3; pass++) {
				const markerRows = (start > 0 ? 1 : 0) + (end < entries.length ? 1 : 0);
				const nextBudget = Math.max(1, budget - markerRows);
				if (nextBudget === entryBudget) break;
				entryBudget = nextBudget;
				({ start, end, used } = fitEntries(entryBudget));
			}
			const markerCapacity = Math.max(0, budget - used);
			const showStartMarker = start > 0 && markerCapacity > 0;
			const showEndMarker = end < entries.length && markerCapacity > (showStartMarker ? 1 : 0);
			if (showStartMarker) {
				lines.push(` ${theme.fg("dim", `… ${tSettingsUi("{count} more", { count: start })}`)}`);
			}
			for (const entry of entries.slice(start, end)) {
				const lineStart = lines.length;
				lines.push(...entry.lines);
				if (entry.rowIndex !== undefined) {
					for (let offset = 0; offset < entry.lines.length; offset++) {
						this.#rowAtScreenLine.set(lineStart + offset, entry.rowIndex);
					}
				}
			}
			if (showEndMarker) {
				lines.push(` ${theme.fg("dim", `… ${tSettingsUi("{count} more", { count: entries.length - end })}`)}`);
			}
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, innerWidth))}`);
		}
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#renderEntries(width: number): RenderedHubEntry[] {
		const entries: RenderedHubEntry[] = [];
		if (width >= HUB_WIDE_MIN_WIDTH && this.#rows.length > 0) {
			entries.push({ lines: [this.#columnHeader(width)] });
		}
		for (let rowIndex = 0; rowIndex < this.#rows.length; rowIndex++) {
			const row = this.#rows[rowIndex]!;
			entries.push({
				lines: this.#renderEntry(row, rowIndex === this.#selectedRow, width),
				rowIndex,
			});
		}
		return entries;
	}

	#columnHeader(width: number): string {
		const max = Math.max(1, width - 2);
		const nameWidth = Math.max(
			18,
			max -
				3 -
				HUB_STATUS_WIDTH -
				HUB_DURATION_WIDTH -
				HUB_MODEL_WIDTH -
				HUB_ACTIVITY_WIDTH -
				HUB_COLUMN_GAP.length * 4,
		);
		const cells = [
			fixedCell(tSettingsUi("Agent"), nameWidth),
			fixedCell(tSettingsUi("Status"), HUB_STATUS_WIDTH),
			fixedCell(tSettingsUi("Duration"), HUB_DURATION_WIDTH),
			fixedCell(tSettingsUi("Model"), HUB_MODEL_WIDTH),
			fixedCell(tSettingsUi("Last update"), HUB_ACTIVITY_WIDTH),
		];
		return theme.fg("dim", `   ${cells.join(HUB_COLUMN_GAP)}`);
	}

	#hintLines(width: number): string[] {
		const maxWidth = Math.max(1, width - 2);
		const separator = theme.fg("dim", theme.sep.dot);
		const clamp = (line: string): string => truncateToWidth(line, maxWidth);
		const selected = this.#rows[this.#selectedRow];
		const primary = [
			rawKeyHint("j/k", tSettingsUi("select")),
			rawKeyHint("Enter", tSettingsUi("open transcript")),
			rawKeyHint("Esc/←←", tSettingsUi("close")),
		].join(separator);
		if (!selected) return [clamp(primary)];

		const actions: string[] = [];
		const ref = selected.ref;
		const live =
			ref.session !== null && (ref.status === "running" || ref.status === "waiting" || ref.status === "idle");
		if (live) actions.push(rawKeyHint("f", tSettingsUi("focus")));
		if (ref.status === "parked") actions.push(rawKeyHint("r", tSettingsUi("revive")));
		if (ref.status !== "aborted") actions.push(rawKeyHint("x", tSettingsUi("kill")));
		if (actions.length === 0) return [clamp(primary)];
		const secondary = actions.join(separator);
		const combined = `${primary}${separator}${secondary}`;
		return visibleWidth(combined) <= maxWidth ? [combined] : [clamp(primary), clamp(secondary)];
	}

	#renderEntry(row: HubRow, selected: boolean, width: number): string[] {
		const ref = row.ref;
		const max = Math.max(1, width - 2);
		const observed = this.#observableFor(ref.id);
		const progress = observed?.progress;
		const taskStatus = this.#taskStatus(ref, observed);
		const status = this.#renderTaskStatus(taskStatus);
		const label = this.#displayLabel(ref);
		const model = modelBadge(ref, observed) ?? "—";
		const terminal = this.#isTerminal(taskStatus);
		const duration = this.#taskDuration(ref, observed, terminal);
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
					HUB_DURATION_WIDTH -
					HUB_MODEL_WIDTH -
					HUB_ACTIVITY_WIDTH -
					HUB_COLUMN_GAP.length * 4,
			);
			entry.push(
				` ${cursor} ${[
					fixedCell(theme.bold(label), nameWidth),
					fixedCell(status, HUB_STATUS_WIDTH),
					fixedCell(theme.fg("dim", duration), HUB_DURATION_WIDTH),
					fixedCell(model, HUB_MODEL_WIDTH),
					fixedCell(theme.fg("dim", activityTime), HUB_ACTIVITY_WIDTH),
				].join(HUB_COLUMN_GAP)}`,
			);
		} else {
			const suffix = status ? `  ${status}` : "";
			const labelWidth = Math.max(8, max - 3 - visibleWidth(suffix));
			entry.push(` ${cursor} ${fixedCell(theme.bold(label), labelWidth)}${suffix}`);
			entry.push(`   ${truncateToWidth([model, duration, activityTime].join(theme.sep.dot), Math.max(1, max - 3))}`);
		}

		if (!selected) return entry;
		return entry.map(line => {
			const clipped = truncateToWidth(line, max);
			return theme.bg("selectedBg", `${clipped}${padding(Math.max(0, max - visibleWidth(clipped)))}`);
		});
	}

	#isTerminal(status: HubTaskStatus): boolean {
		return status === "completed" || status === "failed" || status === "stopped";
	}

	#taskDuration(ref: AgentRef, observed: ObservableSession | undefined, terminal: boolean): string {
		const progress = observed?.progress;
		const startedAtMs = progress?.startedAtMs ?? observed?.startedAtMs;
		const completedAtMs = progress?.completedAtMs ?? observed?.completedAtMs;
		if (startedAtMs !== undefined) {
			const end = terminal
				? (completedAtMs ??
					(progress?.durationMs !== undefined ? startedAtMs + progress.durationMs : ref.lastActivity))
				: Date.now();
			return formatAgentDuration(Math.max(0, end - startedAtMs));
		}
		return progress?.durationMs !== undefined ? formatAgentDuration(progress.durationMs) : "—";
	}

	#handleTableInput(keyData: string): void {
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

	#handleMouseInput(keyData: string): void {
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

	#focusSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		const isLive =
			ref.session !== null && (ref.status === "running" || ref.status === "waiting" || ref.status === "idle");
		if (!isLive) {
			this.#notice = tSettingsUi('"{label}" is not live; open its transcript or revive it first.', {
				label: this.#displayLabel(ref),
			});
			this.#requestRender();
			return;
		}
		const focusAgent = this.#focusAgent;
		if (!focusAgent) {
			this.#notice = tSettingsUi("Live subagent focus is unavailable in this Agent Hub.");
			this.#requestRender();
			return;
		}
		const root = resolveTopLevelAgent(this.#registry, ref.id);
		const needsSwitch = root !== undefined && root.id !== this.#activeTopLevelId;
		const switchTopLevel = needsSwitch ? this.#switchTopLevel : undefined;
		if (root && needsSwitch && !switchTopLevel) {
			this.#notice = tSettingsUi('Switching to "{label}" is unavailable in this Agent Hub.', {
				label: this.#displayLabel(root),
			});
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

	#reviveSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row.ref;
		if (ref.status !== "parked") {
			this.#notice = tSettingsUi('"{label}" cannot be resumed.', { label: this.#displayLabel(ref) });
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
				await this.#lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
