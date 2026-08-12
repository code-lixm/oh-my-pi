/**
 * Agent Hub overlay component.
 *
 * - Task-only roster: Main and advisors remain routing/observability nodes, never selectable rows.
 * - Rows use lifecycle priority, newest creation, then stable identity; activity heartbeats only refresh display.
 * - Enter opens a fullscreen read-only transcript; `f` focuses a live subagent, `m` sends
 *   it a message, and `p`/`r`/`x` switch, resume, or terminate a task.
 * - The fullscreen projection keeps persisted history metadata, tree-safe lineage, bounded paint,
 *   rich-content transcript links/images, and local or collab-host history without changing the ambient runtime.
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import type { Clipboard, SnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	Container,
	Input,
	matchesKey,
	type OverlayHandle,
	padding,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatAge, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { Settings } from "../../config/settings";
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
import { previewLine, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { formatLocalDateTimeWithOffset } from "../../utils/local-date";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { resolveAgentTerminalStatus, selectAgentActivity } from "./agent-activity-display";
import { type AgentMetrics, progressMetrics, projectAgentTree } from "./agent-hub-projection";
import {
	clampHubLine,
	contextGauge,
	formatChildIds,
	formatMetricDuration,
	formatMetrics,
	formatRoleBadge,
	modelBadge,
	type RosterRender,
	sanitizeDisplayText,
	sanitizeLine,
	statusGlyph,
	treeBranch,
} from "./agent-hub-renderer";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";

type HubViewMode = "roster" | "tree";

/** Refresh cadence for relative time and fallback transcript metrics. */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

const HUB_STATUS_WIDTH = 16;
const HUB_DURATION_WIDTH = 12;
const HUB_MODEL_WIDTH = 52;
/**
 * Width of the per-row Detail column that explains status (failure cause,
 * completion gist, current tool/intent). Truncated with `…` past this width
 * so the column stays bounded; longer detail belongs in the focused
 * inspector. The Model column was widened (26 → 52) for fallback-aware
 * identifiers (`fallback → <provider>/<id>`), which raised the fixed-column
 * layout threshold to {@link HUB_FIXED_COLUMNS_MIN_WIDTH} cells.
 */
const HUB_DETAIL_WIDTH = 30;
const HUB_COLUMN_GAP = " ";
const HUB_MIN_AGENT_WIDTH = 21;
/** Cap the agent-name column so Duration/Model columns stay readable on wide terminals. */
const HUB_MAX_AGENT_WIDTH = 40;
const HUB_FIXED_COLUMNS_MIN_WIDTH =
	4 +
	HUB_MIN_AGENT_WIDTH +
	HUB_STATUS_WIDTH +
	HUB_DURATION_WIDTH +
	HUB_MODEL_WIDTH +
	HUB_DETAIL_WIDTH +
	HUB_COLUMN_GAP.length * 4;
/**
 * Small rosters may collect live observer state for every row; larger rosters
 * keep the registry fallback so the observer map never grows unbounded.
 */
const HUB_OBSERVER_COLLECT_LIMIT = 32;

function fixedCell(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	return `${clipped}${padding(Math.max(0, width - visibleWidth(clipped)))}`;
}

type HubTaskStatus =
	| "not-started"
	| "queued"
	| "running"
	| "waiting-user"
	| "idle"
	| "parked"
	| "completed"
	| "failed"
	| "stopped";

const UUID_LABEL = /^(?:top-level:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Activity labels that duplicate the Status column; the title row skips them. */
const HUB_STATUS_WORDS = new Set([
	"idle",
	"yield",
	"read",
	"running",
	"queued",
	"waiting",
	"parked",
	"stopped",
	"failed",
	"completed",
]);

function isHubStatusWord(text: string): boolean {
	return HUB_STATUS_WORDS.has(text.trim().toLowerCase());
}

/**
 * Built-in agent profile names whose Hub label is owned by the runtime; the
 * i18n layer translates them so the title row follows the active display
 * language. Names that do not appear here stay verbatim (user-defined labels,
 * third-party agent profiles, or task labels from `task` tool calls).
 */
const BUILTIN_AGENT_NAMES: Record<string, true> = {
	task: true,
	scout: true,
	librarian: true,
	reviewer: true,
	designer: true,
	"security-reviewer": true,
	sonic: true,
	advisor: true,
};

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
	/** Production settings used to resolve textual model-role tags. */
	settings?: Settings;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: (reason?: "preserve-focus") => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup scoped to the target agent transcript. */
	getTool?: (agentId: string, name: string) => AgentTool | undefined;
	/** Whether the target agent's active registry entry came from a built-in factory. */
	isBuiltInTool?: (agentId: string, name: string) => boolean;
	/** Extension message renderers scoped to the target agent transcript. */
	getMessageRenderer?: (agentId: string, customType: string) => MessageRenderer | undefined;
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

export class AgentHubOverlayComponent extends Container implements SelectListMouseTarget {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#settings: Settings | undefined;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: (reason?: "preserve-focus") => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#dataChangeUrgent = false;
	#remote: AgentHubRemote | undefined;
	#mouseTracking: boolean;
	#disposed = false;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;
	/** Prevent the async persisted-session scan from flashing a false empty state. */
	#loadingPersistedSubagents = false;

	// Table state
	#rows: AgentRef[] = [];
	#statusCounts: Record<AgentStatus, number> = { running: 0, waiting: 0, idle: 0, parked: 0, aborted: 0 };
	#selectedRow = 0;
	#hoveredRow: number | null = null;
	/** Per-render screen-line to agent-row map, shared by click and hover routing. */
	#hitRows: Array<number | undefined> = [];
	#notice: string | undefined;
	#messageAgentId: string | undefined;
	#messageInput: Input | undefined;
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;
	/** Operational ordering by default; tree mode groups descendants under their spawner. */
	#viewMode: HubViewMode = "roster";
	#treeDepthById = new Map<string, number>();
	#treeParentById = new Map<string, string>();
	#treeLastSiblingById = new Map<string, boolean>();
	/** Current observer index and summary data, rebuilt on source changes rather than every paint. */
	#observedById = new Map<string, ObservableSession>();
	#childrenByParent = new Map<string, AgentRef[]>();
	/** Transcript-derived fallback stats are sampled only on the bounded age cadence. */
	#sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
	/** On narrow terminals Tab replaces the roster with the selected-agent inspector. */
	#narrowDetailsOpen = false;
	#lastRenderWasSplit = false;
	#lastSplitRosterWidth: number | undefined;
	/** Scroll offset for the selected-agent inspector when its content overflows. */
	#detailScrollOffset = 0;
	#detailAgentId: string | undefined;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((agentId: string, name: string) => AgentTool | undefined) | undefined;
	#isBuiltInTool: ((agentId: string, name: string) => boolean) | undefined;
	#getMessageRenderer: ((agentId: string, customType: string) => MessageRenderer | undefined) | undefined;
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
		this.#settings = deps.settings;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#mouseTracking = deps.mouseTracking ?? false;
		this.#loadingPersistedSubagents = !this.#remote && Boolean(deps.sessionFile?.endsWith(".jsonl"));
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#isBuiltInTool = deps.isBuiltInTool;
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
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		this.#ageTimer = setInterval(() => {
			this.#requestRender();
		}, AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile, {
					shouldContinue: () => !this.#disposed,
				})
					.then(() => {
						if (!this.#disposed) this.#refreshRows();
					})
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.finally(() => {
						this.#loadingPersistedSubagents = false;
						if (!this.#disposed) this.#requestRender();
					});
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
	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
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
		const termHeight = this.#ui.terminal?.rows || process.stdout.rows || 40;
		const frame = this.#renderTable(width, termHeight).map(line => clampHubLine(line, width));
		if (frame.length <= termHeight) return frame;

		// A tiny terminal can leave less room than the fixed chrome needs. Keep
		// the title and footer visible instead of spilling into scrollback.
		const footerLines = Math.min(3, frame.length);
		const bodyEnd = Math.max(0, termHeight - footerLines);
		return [...frame.slice(0, bodyEnd), ...frame.slice(-footerLines)].slice(0, termHeight);
	}

	handleInput(keyData: string): void {
		if (
			routeSgrMouseInput(keyData, event => {
				const split = this.#lastSplitRosterWidth;
				if (split !== undefined && event.wheel === null && event.col > split + 2) return false;
				return routeSelectListMouse(this, event, event.row);
			})
		) {
			return;
		}

		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (keyData.startsWith("\x1b[<")) return;
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
		if (this.#disposed || !this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		let viewer: AgentTranscriptViewer;
		viewer = new AgentTranscriptViewer({
			agentId: id,
			getVisibleAgentIds: () => this.#rows.map(row => row.id),
			onAgentChange: agentId => {
				const rowIndex = this.#rows.findIndex(row => row.id === agentId);
				if (rowIndex >= 0) this.#selectedRow = rowIndex;
			},
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			ui: this.#ui,
			getTool: this.#getTool,
			isBuiltInTool: this.#isBuiltInTool,
			getMessageRenderer: this.#getMessageRenderer,
			getSnapshots: this.#getSnapshots,
			getClipboard: this.#getClipboard,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(viewer),
			onHubClose: () => {
				if (this.#disposed) return;
				this.#closeTranscriptOverlay(viewer);
				if (!this.#disposed) this.#onDone();
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
	#closeTranscriptOverlay(expectedViewer?: AgentTranscriptViewer): void {
		if (expectedViewer && this.#transcriptViewer !== expectedViewer) return;
		const overlay = this.#transcriptOverlay;
		const viewer = this.#transcriptViewer;
		if (!overlay && !viewer) return;
		overlay?.hide();
		this.#transcriptOverlay = undefined;
		viewer?.dispose();
		this.#transcriptViewer = undefined;
		if (!this.#disposed) {
			if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
			this.#requestRender();
		}
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
		const selectedId = this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.kind === "sub");
		this.#observedById =
			refs.length <= HUB_OBSERVER_COLLECT_LIMIT ? this.#collectObserved(refs) : new Map<string, ObservableSession>();
		// Partition by creation timestamp: rows with a known createdAt are sorted
		// ascending; rows missing the timestamp are pushed to the end, in id
		// order, so a row that loses its timestamp mid-session can never reorder
		// the list above peers it was already below.
		const withTimestamp: typeof refs = [];
		const withoutTimestamp: typeof refs = [];
		for (const ref of refs) {
			if (Number.isFinite(ref.createdAt)) withTimestamp.push(ref);
			else withoutTimestamp.push(ref);
		}
		withTimestamp.sort((left, right) => {
			if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
			return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
		});
		withoutTimestamp.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
		const rosterRows = withTimestamp.concat(withoutTimestamp);

		if (this.#viewMode === "tree") {
			const tree = projectAgentTree(rosterRows);
			this.#rows = tree.rows;
			this.#treeDepthById = tree.depthById;
			this.#treeParentById = tree.parentById;
			this.#treeLastSiblingById = tree.lastSiblingById;
		} else {
			this.#rows = rosterRows;
			this.#treeDepthById.clear();
			this.#treeParentById.clear();
			this.#treeLastSiblingById.clear();
		}
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		const detailAgentId = this.#rows[this.#selectedRow]?.id;
		if (detailAgentId !== this.#detailAgentId) {
			this.#detailAgentId = detailAgentId;
			this.#detailScrollOffset = 0;
		}

		this.#childrenByParent.clear();
		for (const ref of rosterRows) {
			const parent = ref.parentId ?? MAIN_AGENT_ID;
			const children = this.#childrenByParent.get(parent);
			if (children) children.push(ref);
			else this.#childrenByParent.set(parent, [ref]);
		}
		this.#statusCounts = { running: 0, waiting: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of rosterRows) {
			const taskStatus = this.#taskStatus(ref, this.#observedById.get(ref.id));
			const status = this.#agentStatusFor(taskStatus);
			this.#statusCounts[status]++;
		}
	}

	#collectObserved(refs: readonly AgentRef[]): Map<string, ObservableSession> {
		const observedById = new Map(this.#observers.getSessions().map(observed => [observed.id, observed] as const));
		for (const ref of refs) {
			const tracked = this.#observers.getSession(ref.id);
			if (tracked) observedById.set(ref.id, tracked);
		}
		return observedById;
	}

	#taskStatus(ref: AgentRef, observed: ObservableSession | undefined): HubTaskStatus {
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		const terminalStatus = resolveAgentTerminalStatus({
			progressStatus: progress?.status,
			observedStatus: observed?.status,
			registryStatus: ref.status,
			terminalStatus: ref.terminalStatus,
		});
		if (terminalStatus === "failed") return "failed";
		if (terminalStatus === "aborted") return "stopped";
		if (terminalStatus === "completed") return "completed";
		if (ref.status === "running" && activity?.phase === "queued") return "queued";
		if (progress?.status === "pending") return "not-started";
		if (ref.status === "waiting" || activity?.phase === "waiting-user" || activity?.phase === "waiting-peer") {
			return "waiting-user";
		}
		if (
			progress?.status === "running" ||
			observed?.status === "active" ||
			ref.status === "running" ||
			(activity !== undefined && activity.phase !== "idle")
		) {
			return "running";
		}
		if (ref.status === "parked") return "parked";
		return "idle";
	}

	#agentStatusFor(status: HubTaskStatus): AgentStatus {
		switch (status) {
			case "not-started":
			case "queued":
			case "running":
				return "running";
			case "waiting-user":
				return "waiting";
			case "parked":
				return "parked";
			case "failed":
				return "aborted";
			case "stopped":
			case "idle":
			case "completed":
				return "idle";
		}
	}

	#taskGlyph(taskStatus: HubTaskStatus): string {
		if (taskStatus === "failed") return statusGlyph("aborted");
		if (taskStatus === "stopped") return theme.fg("muted", theme.status.aborted);
		return statusGlyph(this.#agentStatusFor(taskStatus));
	}

	#renderTaskStatus(status: HubTaskStatus): string {
		switch (status) {
			case "not-started":
				return theme.fg("warning", tSettingsUi("Not started"));
			case "queued":
				return theme.fg("warning", tSettingsUi("Queued"));
			case "running":
				return theme.fg("success", tSettingsUi("Running"));
			case "waiting-user":
				return theme.fg("warning", tSettingsUi("Waiting for user"));
			case "idle":
				return theme.fg("accent", tSettingsUi("idle"));
			case "parked":
				return theme.fg("muted", tSettingsUi("parked"));
			case "completed":
				return theme.fg("success", tSettingsUi("Completed"));
			case "failed":
				return theme.fg("error", tSettingsUi("Failed"));
			case "stopped":
				return theme.fg("muted", tSettingsUi("Stopped"));
		}
	}

	#displayLabel(ref: AgentRef): string {
		const label = sanitizeDisplayText(agentDisplayLabel(ref)).trim();
		if (!label || UUID_LABEL.test(label)) return tSettingsUi("Subagent");
		// Named advisors register as `advisor:<slug>`; translate the base name and
		// keep the slug verbatim so every advisor row follows the display language.
		if (label.startsWith("advisor:")) return `${tSettingsUi("advisor")}:${label.slice("advisor:".length)}`;
		return BUILTIN_AGENT_NAMES[label] ? tSettingsUi(label) : label;
	}

	#metricsFor(ref: AgentRef, observed: ObservableSession | undefined): AgentMetrics | undefined {
		if (observed?.progress) return progressMetrics(observed);
		if (ref.history?.metrics) return ref.history.metrics;
		const session = this.#fallbackStatsSession(ref, observed);
		return session ? this.#sessionMetrics.get(session)?.metrics : undefined;
	}

	#fallbackStatsSession(
		ref: AgentRef,
		observed: ObservableSession | undefined,
	): NonNullable<AgentRef["session"]> | undefined {
		if (observed?.progress) return undefined;
		const session = ref.session;
		return session && typeof session.getSessionStats === "function" ? session : undefined;
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const contentRows = Math.max(1, termHeight - 4);
		if (this.#rows.length <= HUB_OBSERVER_COLLECT_LIMIT) {
			this.#observedById = this.#collectObserved(this.#rows);
			this.#statusCounts = { running: 0, waiting: 0, idle: 0, parked: 0, aborted: 0 };
			for (const ref of this.#rows) {
				const taskStatus = this.#taskStatus(ref, this.#observedById.get(ref.id));
				const status = this.#agentStatusFor(taskStatus);
				this.#statusCounts[status]++;
			}
		}
		const observedById = this.#observedById;
		const split = this.#splitRosterWidth(width);
		this.#lastRenderWasSplit = split !== undefined;
		this.#lastSplitRosterWidth = split;
		const selected = this.#rows[this.#selectedRow];
		const lines: string[] = [];

		if (split !== undefined) {
			const detailWidth = splitBodyWidth(width, split);
			const roster = this.#renderRosterPanel(split, contentRows, observedById);
			const details = this.#renderDetailPanel(selected, detailWidth, contentRows, observedById);
			lines.push(topBorderSplit(width, tSettingsUi("Agent Hub"), split));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(splitRow(roster.lines[i] ?? "", details[i] ?? "", width, split));
			}
			lines.push(dividerSplit(width, split));
			lines.push(row(this.#footer(false, Math.max(1, width - 4)), width));
			lines.push(bottomBorder(width));
			return lines;
		}

		const innerWidth = Math.max(1, width - 4);
		if (this.#narrowDetailsOpen && selected) {
			const details = this.#renderDetailPanel(selected, innerWidth, contentRows, observedById);
			lines.push(topBorder(width, `${tSettingsUi("Agent Hub")}${theme.sep.dot}${this.#displayLabel(selected)}`));
			for (const detail of details) lines.push(row(detail, width));
		} else {
			const roster = this.#renderRosterPanel(innerWidth, contentRows, observedById);
			lines.push(topBorder(width, tSettingsUi("Agent Hub")));
			for (let i = 0; i < contentRows; i++) {
				const hit = roster.hitRows[i];
				if (hit !== undefined) this.#hitRows[lines.length] = hit;
				lines.push(row(roster.lines[i] ?? "", width));
			}
		}
		lines.push(divider(width));
		lines.push(row(this.#footer(this.#narrowDetailsOpen, innerWidth), width));
		lines.push(bottomBorder(width));
		return lines;
	}

	#splitRosterWidth(_width: number): number | undefined {
		// The Hub is intentionally a flat roster. Details are opened as a
		// fullscreen transcript, not rendered beside the list.
		return undefined;
	}

	#footer(showingNarrowDetails: boolean, availableWidth: number): string {
		if (this.#messageInput) return theme.fg("dim", tSettingsUi("Enter:send message · Esc:cancel message"));
		const controls = [
			tSettingsUi("j/k:select · {enterAction} · Esc/←←:close", {
				enterAction: tSettingsUi("Enter:open transcript"),
			}),
		];
		if (!showingNarrowDetails && !this.#lastRenderWasSplit) controls.push("Tab");
		controls.push(
			tSettingsUi("f:focus"),
			tSettingsUi("m:message"),
			tSettingsUi("p:Main"),
			tSettingsUi("r:revive"),
			tSettingsUi("x:kill"),
			`t:${this.#viewMode === "roster" ? tSettingsUi("By parent") : tSettingsUi("Flat")}`,
		);
		return theme.fg("dim", truncateToWidth(controls.join(theme.sep.dot), Math.max(1, availableWidth)));
	}
	#renderRosterPanel(width: number, rows: number, observedById: ReadonlyMap<string, ObservableSession>): RosterRender {
		const lines = this.#summaryLines(width);
		const hitRows: Array<number | undefined> = Array.from({ length: lines.length });
		if (rows >= 8 && lines.length + this.#rows.length + 1 <= rows) {
			lines.push("");
			hitRows.push(undefined);
		}

		const messageLines: string[] = [];
		if (this.#messageInput && this.#messageAgentId) {
			const target = this.#registry.get(this.#messageAgentId);
			const label = target ? this.#displayLabel(target) : tSettingsUi("Subagent");
			const prefix = `m → ${label}: `;
			const input = this.#messageInput.render(Math.max(1, width - visibleWidth(prefix)))[0] ?? "";
			messageLines.push(truncateToWidth(`${theme.fg("muted", prefix)}${input}`, Math.max(1, width)));
		}
		const noticeLines = [
			...messageLines,
			...(this.#notice ? [theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width)))] : []),
		];
		const budget = Math.max(0, rows - lines.length - noticeLines.length);
		if (this.#rows.length === 0) {
			if (budget > 0) {
				const empty = this.#loadingPersistedSubagents
					? `${statusGlyph("running")} ${tSettingsUi("Loading saved agents")}`
					: `${theme.fg("muted", theme.status.shadowed)} ${theme.bold(tSettingsUi("No tasks yet"))}`;
				lines.push(empty);
				hitRows.push(undefined);
			}
			if (!this.#loadingPersistedSubagents && budget > 1) {
				lines.push(theme.fg("dim", tSettingsUi("no subagents yet — task spawns appear here")));
				hitRows.push(undefined);
			}
		} else if (budget > 0) {
			const window = this.#renderRosterWindow(width, budget, observedById);
			lines.push(...window.lines);
			hitRows.push(...window.hitRows);
		}
		for (const notice of noticeLines) {
			lines.push(notice);
			hitRows.push(undefined);
		}
		while (lines.length < rows) {
			lines.push("");
			hitRows.push(undefined);
		}
		return { lines: lines.slice(0, rows), hitRows: hitRows.slice(0, rows) };
	}

	#renderRosterWindow(
		width: number,
		budget: number,
		_observedById: ReadonlyMap<string, ObservableSession>,
	): RosterRender {
		const lines: string[] = [];
		const hitRows: Array<number | undefined> = [];
		const rendered = new Map<number, string[]>();
		const entryAt = (index: number): string[] => {
			const cached = rendered.get(index);
			if (cached) return cached;
			const entry = this.#renderEntry(
				this.#rows[index],
				index === this.#selectedRow,
				width,
				this.#observableFor(this.#rows[index].id),
				index === this.#hoveredRow,
			);
			rendered.set(index, entry);
			return entry;
		};
		const appendEntry = (index: number, entry = entryAt(index)): void => {
			for (const line of entry) {
				lines.push(line);
				hitRows.push(index);
			}
		};

		let start = this.#selectedRow;
		let end = this.#selectedRow + 1;
		let used = entryAt(this.#selectedRow).length;
		if (used > budget) {
			appendEntry(this.#selectedRow, entryAt(this.#selectedRow).slice(0, budget));
			return { lines, hitRows };
		}
		for (let grew = true; grew; ) {
			grew = false;
			if (end < this.#rows.length) {
				const next = entryAt(end);
				if (used + next.length <= budget) {
					used += next.length;
					end++;
					grew = true;
				}
			}
			if (start > 0) {
				const previous = entryAt(start - 1);
				if (used + previous.length <= budget) {
					start--;
					used += previous.length;
					grew = true;
				}
			}
		}
		for (
			let markerRows = Number(start > 0) + Number(end < this.#rows.length);
			used + markerRows > budget && start < end;
			markerRows = Number(start > 0) + Number(end < this.#rows.length)
		) {
			if (end - 1 > this.#selectedRow) {
				end--;
				used -= entryAt(end).length;
			} else if (start < this.#selectedRow) {
				used -= entryAt(start).length;
				start++;
			} else {
				break;
			}
		}
		const showTopOverflow = start > 0 && used < budget;
		const showBottomOverflow = end < this.#rows.length && used + Number(showTopOverflow) < budget;
		if (showTopOverflow) {
			lines.push(theme.fg("dim", `… ${tSettingsUi("{count} more", { count: start })}`));
			hitRows.push(undefined);
		}
		for (let i = start; i < end; i++) appendEntry(i);
		if (showBottomOverflow) {
			lines.push(theme.fg("dim", `… ${tSettingsUi("{count} more", { count: this.#rows.length - end })}`));
			hitRows.push(undefined);
		}
		return { lines, hitRows };
	}

	#summaryLines(width: number): string[] {
		const active = (label: string): string => theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)));
		const inactive = (label: string): string => theme.fg("muted", ` ${label} `);
		const projection =
			this.#viewMode === "roster"
				? `${active(tSettingsUi("Flat"))}${theme.fg("dim", "/")}${inactive(tSettingsUi("By parent"))}`
				: `${inactive(tSettingsUi("Flat"))}${theme.fg("dim", "/")}${active(tSettingsUi("By parent"))}`;
		const counts = this.#statusSummary();
		const max = Math.max(1, width);
		const header = `${theme.bold(tSettingsUi("Roster"))}${theme.fg("dim", theme.sep.dot)}${projection}${counts ? theme.fg("dim", theme.sep.dot) + counts : ""}`;
		const lines = wrapTextWithAnsi(header, max);
		if (this.#viewMode === "roster" && width >= HUB_FIXED_COLUMNS_MIN_WIDTH) lines.push(this.#columnHeader(width));
		return lines;
	}

	#columnHeader(width: number): string {
		const max = Math.max(1, width);
		const nameWidth = Math.min(
			HUB_MAX_AGENT_WIDTH,
			Math.max(
				HUB_MIN_AGENT_WIDTH,
				max -
					4 -
					HUB_STATUS_WIDTH -
					HUB_DURATION_WIDTH -
					HUB_MODEL_WIDTH -
					HUB_DETAIL_WIDTH -
					HUB_COLUMN_GAP.length * 4,
			),
		);
		return theme.fg(
			"dim",
			`    ${[
				fixedCell(tSettingsUi("Agent"), nameWidth),
				fixedCell(tSettingsUi("Status"), HUB_STATUS_WIDTH),
				fixedCell(tSettingsUi("Duration"), HUB_DURATION_WIDTH),
				fixedCell(tSettingsUi("Model"), HUB_MODEL_WIDTH),
				fixedCell(tSettingsUi("Detail"), HUB_DETAIL_WIDTH),
			].join(HUB_COLUMN_GAP)}`,
		);
	}
	#statusSummary(): string {
		const parts: string[] = [];
		for (const status of ["running", "waiting", "idle", "parked", "aborted"] as const) {
			const count = this.#statusCounts[status];
			if (count > 0) parts.push(`${statusGlyph(status)} ${count} ${tSettingsUi(status)}`);
		}
		return parts.join(theme.sep.dot);
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observedById.get(id) ?? this.#observers.getSession(id);
	}

	#renderDetailPanel(
		ref: AgentRef | undefined,
		width: number,
		rows: number,
		_observedById: ReadonlyMap<string, ObservableSession>,
	): string[] {
		if (!ref) return [theme.fg("dim", tSettingsUi("No tasks yet")), ...Array.from({ length: rows - 1 }, () => "")];
		const observed = this.#observableFor(ref.id);
		const progress = observed?.progress;
		const taskStatus = this.#taskStatus(ref, observed);
		const label = this.#displayLabel(ref);
		const metrics = this.#metricsFor(ref, observed);
		const children = this.#childrenByParent.get(ref.id) ?? [];
		const lines: string[] = [];
		const add = (line = ""): void => {
			lines.push(truncateToWidth(line, width));
		};
		const addWrapped = (text: string, maxRows = 2): void => {
			for (const wrapped of wrapTextWithAnsi(sanitizeLine(text), Math.max(1, width)).slice(0, maxRows)) add(wrapped);
		};
		const section = (label: string, contentRows = 0): void => {
			if (lines.length > 0 && lines.length + 1 + contentRows < rows) add();
			add(theme.bold(theme.fg("accent", label)));
		};

		add(`${this.#taskGlyph(taskStatus)} ${theme.bold(label)}`);
		if (label !== sanitizeDisplayText(ref.id)) add(theme.fg("dim", sanitizeDisplayText(ref.id)));
		const lifecycleDetails = [
			metrics ? formatMetricDuration(metrics) : undefined,
			formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000))),
		].filter(Boolean);
		add(
			`${this.#renderTaskStatus(taskStatus)}${theme.fg("dim", `${theme.sep.dot}${lifecycleDetails.join(theme.sep.dot)}`)}`,
		);
		const modelDetails: string[] = [];
		const modelRole = progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) modelDetails.push(formatRoleBadge(modelRole, this.#settings));
		const badge = modelBadge(ref, observed);
		if (badge) modelDetails.push(badge);
		if (modelDetails.length > 0) add(modelDetails.join(theme.sep.dot));

		const task = observed?.description ?? progress?.task ?? ref.activity;
		if (task) {
			section(tSettingsUi("Task"));
			addWrapped(task);
		}

		const current = progress?.currentTool
			? `${progress.currentTool}${progress.currentToolArgs ? `${theme.sep.dot}${progress.currentToolArgs}` : ""}`
			: (progress?.lastIntent ?? ref.activity);
		if (current) {
			section(tSettingsUi("Current tool"));
			addWrapped(current);
			if (progress?.retryState) {
				add(
					theme.fg(
						"warning",
						`${tSettingsUi("Retry")} ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`,
					),
				);
			}
		}

		section(tSettingsUi("Usage"), 1);
		if (metrics) {
			addWrapped(formatMetrics(metrics), 3);
			if (metrics.contextTokens !== undefined && metrics.contextWindow) {
				add(contextGauge(metrics.contextTokens, metrics.contextWindow));
			}
		} else {
			add(theme.fg("dim", tSettingsUi("not reported")));
		}

		section(tSettingsUi("Owner"));
		add(sanitizeDisplayText(ref.parentId ?? MAIN_AGENT_ID));
		if (children.length > 0) add(theme.fg("dim", formatChildIds(children, width)));
		add(theme.fg("dim", `Registered ${formatLocalDateTimeWithOffset(new Date(ref.createdAt))}`));

		const artifacts = ref.history;
		if (artifacts?.readOnly) add(theme.fg("warning", tSettingsUi("read-only")));
		if (artifacts?.outputPath) addWrapped(`${tSettingsUi("Output")} ${shortenPath(artifacts.outputPath)}`);
		if (artifacts?.patchPath) addWrapped(`${tSettingsUi("Patch")} ${shortenPath(artifacts.patchPath)}`);
		if (artifacts?.branchName) addWrapped(`${tSettingsUi("Branch")} ${artifacts.branchName}`);

		const maxScroll = Math.max(0, lines.length - rows);
		this.#detailScrollOffset = Math.min(this.#detailScrollOffset, maxScroll);
		const visible = lines.slice(this.#detailScrollOffset, this.#detailScrollOffset + rows);
		while (visible.length < rows) visible.push("");
		return visible;
	}

	/** One physical roster row per task; detailed task and usage content stays in the inspector. */
	#renderEntry(
		ref: AgentRef,
		selected: boolean,
		width: number,
		observed: ObservableSession | undefined,
		hovered = false,
	): string[] {
		const max = Math.max(1, width);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const branch =
			this.#viewMode === "tree"
				? treeBranch(ref, max, this.#treeDepthById, this.#treeParentById, this.#treeLastSiblingById)
				: "";
		const taskStatus = this.#taskStatus(ref, observed);
		const label = this.#displayLabel(ref);
		const styledLabel = selected ? theme.bold(theme.fg("accent", label)) : theme.bold(label);
		const unread = this.#irc.unreadCount(ref.id);
		const unreadText = unread > 0 ? ` ${theme.fg("warning", `⧉ ${unread}`)}` : "";
		const agent = `${branch}${styledLabel}${unreadText}`;
		const metrics = this.#metricsFor(ref, observed);
		const duration = metrics ? (formatMetricDuration(metrics) ?? "—") : "—";
		const modelParts: string[] = [];
		const modelRole = observed?.progress?.modelRole ?? ref.history?.modelRole;
		if (modelRole && this.#settings) modelParts.push(formatRoleBadge(modelRole, this.#settings));
		const badge = modelBadge(ref, observed);
		if (badge) modelParts.push(badge);
		const model = modelParts.join(theme.sep.dot) || "—";
		let line: string;
		const nameWidth = Math.min(
			HUB_MAX_AGENT_WIDTH,
			Math.max(
				HUB_MIN_AGENT_WIDTH,
				max -
					4 -
					HUB_STATUS_WIDTH -
					HUB_DURATION_WIDTH -
					HUB_MODEL_WIDTH -
					HUB_DETAIL_WIDTH -
					HUB_COLUMN_GAP.length * 4,
			),
		);
		const useFixedColumns = this.#viewMode === "roster" && width >= HUB_FIXED_COLUMNS_MIN_WIDTH;
		if (useFixedColumns) {
			line = `${cursor} ${this.#taskGlyph(taskStatus)} ${[
				fixedCell(agent, nameWidth),
				fixedCell(this.#renderTaskStatus(taskStatus), HUB_STATUS_WIDTH),
				fixedCell(theme.fg("dim", duration), HUB_DURATION_WIDTH),
				fixedCell(model, HUB_MODEL_WIDTH),
				fixedCell(this.#renderEntryDetail(ref, taskStatus, observed), HUB_DETAIL_WIDTH),
			].join(HUB_COLUMN_GAP)}`;
		} else {
			line = `${cursor} ${this.#taskGlyph(taskStatus)} ${agent} ${theme.fg("dim", theme.sep.dot)} ${this.#renderTaskStatus(taskStatus)}`;
		}
		const clipped = truncateToWidth(line.replace(/[\r\n]+/g, " "), max);
		if (!selected && !hovered) return [clipped];
		return [theme.bg("selectedBg", `${clipped}${padding(Math.max(0, max - visibleWidth(clipped)))}`)];
	}

	/**
	 * One-line, status-aware description for the Detail column. Every terminal
	 * status (failed, completed, stopped) carries a concrete reason; transient
	 * states (running, queued, waiting) point to the live activity, the
	 * current tool, or a registry gist. Output is sanitized and clipped to
	 * {@link HUB_DETAIL_WIDTH} so the column never spills into adjacent
	 * columns; longer detail stays in the focused inspector.
	 */
	#renderEntryDetail(ref: AgentRef, taskStatus: HubTaskStatus, observed: ObservableSession | undefined): string {
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		const liveLabel = activity?.label;
		const liveTool = progress?.currentTool
			? progress.currentTool +
				(progress.currentToolArgs
					? `${theme.sep.dot}${previewLine(sanitizeDisplayText(progress.currentToolArgs), 24)}`
					: "")
			: undefined;
		const liveIntent = progress?.lastIntent;
		const stored = ref.activity;
		const filteredActivity = liveLabel && !isHubStatusWord(liveLabel) ? liveLabel : undefined;
		const filteredTool = liveTool && !isHubStatusWord(liveTool) ? liveTool : undefined;
		const filteredIntent = liveIntent && !isHubStatusWord(liveIntent) ? liveIntent : undefined;
		const filteredStored = stored && !isHubStatusWord(stored) ? stored : undefined;
		const resultText = progress?.resultText;
		const retryFailure = progress?.retryFailure;
		const preview = (text: string): string => previewLine(sanitizeDisplayText(text), HUB_DETAIL_WIDTH);
		const tint = (color: "muted" | "dim" | "warning" | "error", text: string): string => theme.fg(color, text);
		switch (taskStatus) {
			case "failed":
				return tint(
					"error",
					retryFailure
						? tSettingsUi("Failed: {error}", { error: preview(retryFailure.errorMessage) })
						: resultText
							? tSettingsUi("Failed: {error}", { error: preview(resultText) })
							: tSettingsUi("Failed"),
				);
			case "completed":
				return tint(
					"muted",
					resultText
						? tSettingsUi("Completed: {summary}", { summary: preview(resultText) })
						: liveIntent
							? tSettingsUi("Completed: {summary}", { summary: preview(liveIntent) })
							: tSettingsUi("Completed"),
				);
			case "stopped":
				return tint(
					"muted",
					retryFailure
						? tSettingsUi("Stopped: {reason}", { reason: preview(retryFailure.errorMessage) })
						: resultText
							? tSettingsUi("Stopped: {reason}", { reason: preview(resultText) })
							: tSettingsUi("Stopped"),
				);
			case "queued":
				return tint("muted", tSettingsUi("Queued: waiting for runnable slot"));
			case "not-started":
				return tint("muted", tSettingsUi("Not started: pending prompt"));
			case "waiting-user":
				return tint("warning", tSettingsUi("Waiting for user input"));
			case "running":
				return tint(
					"muted",
					filteredActivity
						? tSettingsUi("Running: {activity}", { activity: preview(filteredActivity) })
						: filteredTool
							? tSettingsUi("Running: {activity}", { activity: preview(filteredTool) })
							: filteredIntent
								? tSettingsUi("Running: {activity}", { activity: preview(filteredIntent) })
								: filteredStored
									? tSettingsUi("Running: {activity}", { activity: preview(filteredStored) })
									: tSettingsUi("Running"),
				);
			case "parked":
				return tint(
					"muted",
					filteredStored
						? tSettingsUi("Parked: {note}", { note: preview(filteredStored) })
						: tSettingsUi("Parked"),
				);
			case "idle":
				return tint(
					"muted",
					filteredStored ? tSettingsUi("Idle: {note}", { note: preview(filteredStored) }) : tSettingsUi("Idle"),
				);
		}
	}

	#scrollDetails(direction: -1 | 1): void {
		this.#detailScrollOffset = Math.max(0, this.#detailScrollOffset + direction * 5);
		this.#requestRender();
	}

	#selectRow(index: number): void {
		if (index !== this.#selectedRow) {
			this.#detailScrollOffset = 0;
			this.#detailAgentId = this.#rows[index]?.id;
		}
		this.#selectedRow = index;
	}

	handleWheel(delta: -1 | 1): void {
		this.#hoveredRow = null;
		if (this.#rows.length > 0) {
			this.#selectRow(Math.max(0, Math.min(this.#selectedRow + delta, this.#rows.length - 1)));
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		if (index === this.#hoveredRow) return;
		this.#hoveredRow = index;
		this.#requestRender();
	}

	clickItem(index: number): void {
		const selected = this.#rows[index];
		if (!selected) return;
		this.#hoveredRow = index;
		this.#selectRow(index);
		this.#requestRender();
		this.openChat(selected.id);
	}

	#handleTableInput(keyData: string): void {
		if (this.#messageInput) {
			this.#handleMessageInput(keyData);
			return;
		}
		if (matchesKey(keyData, "escape")) {
			if (this.#narrowDetailsOpen && !this.#lastRenderWasSplit) {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if ((matchesKey(keyData, "tab") || keyData === "\t") && !this.#lastRenderWasSplit) {
			if (this.#rows.length > 0) this.#narrowDetailsOpen = !this.#narrowDetailsOpen;
			this.#requestRender();
			return;
		}
		if (this.#lastRenderWasSplit || this.#narrowDetailsOpen) {
			if (matchesKey(keyData, "pageUp")) {
				this.#scrollDetails(-1);
				return;
			}
			if (matchesKey(keyData, "pageDown")) {
				this.#scrollDetails(1);
				return;
			}
		}
		if (keyData === "t") {
			this.#hoveredRow = null;
			this.#viewMode = this.#viewMode === "roster" ? "tree" : "roster";
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "left")) {
			if (this.#narrowDetailsOpen && !this.#lastRenderWasSplit) {
				this.#narrowDetailsOpen = false;
				this.#requestRender();
				return;
			}
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		this.#hoveredRow = null;
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) this.#selectRow((this.#selectedRow + 1) % this.#rows.length);
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) this.#selectRow((this.#selectedRow - 1 + this.#rows.length) % this.#rows.length);
			this.#requestRender();
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
		if (!row) {
			this.#notice = tSettingsUi("Select a subagent to message.");
			this.#requestRender();
			return;
		}
		const ref = row;
		if (ref.status === "aborted") {
			this.#notice = tSettingsUi('"{label}" was aborted and cannot be messaged.', {
				label: this.#displayLabel(ref),
			});
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
			this.#notice = tSettingsUi("Type a message before sending.");
			this.#requestRender();
			return;
		}
		const target = this.#registry.get(agentId);
		if (target?.kind !== "sub" || target.status === "aborted") {
			this.#messageInput = undefined;
			this.#messageAgentId = undefined;
			this.#notice = target
				? tSettingsUi('"{label}" cannot receive a message.', { label: this.#displayLabel(target) })
				: tSettingsUi("The selected subagent is no longer available.");
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
				if (receipt.outcome === "failed") {
					this.#notice = receipt.error ?? tSettingsUi("Message delivery failed.");
				}
				this.#requestRender();
			})
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#activateSelected(): void {
		const selected = this.#rows[this.#selectedRow];
		if (!selected) return;
		this.#notice = undefined;
		this.openChat(selected.id);
	}

	#focusSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row;
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
				this.#onDone("preserve-focus");
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#switchToMain(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const root = resolveTopLevelAgent(this.#registry, row.id);
		if (!root) {
			this.#notice = `${tSettingsUi("Main unavailable")}: ${this.#displayLabel(row)}`;
			this.#requestRender();
			return;
		}
		if (root.id === this.#activeTopLevelId) {
			this.#onDone();
			return;
		}
		const switchTopLevel = this.#switchTopLevel;
		if (!switchTopLevel) {
			this.#notice = tSettingsUi('Switching to "{label}" is unavailable in this Agent Hub.', {
				label: this.#displayLabel(root),
			});
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		void switchTopLevel(root.id)
			.then(() => this.#onDone("preserve-focus"))
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
	}

	#reviveSelected(): void {
		const row = this.#rows[this.#selectedRow];
		if (!row) return;
		const ref = row;
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
		const ref = row;
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
