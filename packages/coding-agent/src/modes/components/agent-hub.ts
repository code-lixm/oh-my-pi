/**
 * Agent Hub overlay component.
 *
 * One overlay with a grouped table and read-only transcript viewer:
 * - The active Main is header-only. Background Main runtimes are selectable
 *   switch targets; subagents are grouped beneath their owning Main.
 * - Enter/click switches a Main runtime or opens the selected subagent transcript.
 *   `f` focuses a live subagent, `m` sends it a message, `p` returns to its
 *   owning Main, and `r`/`x` revive/kill it. Focusing a background subagent
 *   switches to its owning Main first.
 * - The transcript viewer tails persisted/local or collab-host history without
 *   changing the ambient runtime.
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
import { formatAge, getProjectDir, logger } from "@oh-my-pi/pi-utils";
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
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	renderAgentActivityDisplay,
	renderAgentStatusBadge,
	selectAgentActivity,
	truncateAgentActivityLine,
} from "./agent-activity-display";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";

/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(text).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2), Ellipsis.Omit);
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, waiting: 1, idle: 2, parked: 3, aborted: 4 };

type HubRow = { kind: "main"; ref: AgentRef } | { kind: "subagent"; ref: AgentRef };

interface RootSubagentGroup {
	rootId: string;
	label: string;
	rows: HubRow[];
}

type HubGroup = { kind: "mains"; rows: HubRow[] } | { kind: "subagents"; groups: RootSubagentGroup[] };

interface RenderedHubBlock {
	lines: string[];
	rowIndex?: number;
}

const UUID_LABEL = /^(?:top-level:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status glyph keeps the compact row identity stable; the badge spells out the same status. */
function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.status.running);
		case "waiting":
			return theme.fg("warning", theme.status.running);
		case "idle":
			return theme.fg("success", theme.status.enabled);
		case "parked":
			return theme.fg("muted", theme.status.shadowed);
		case "aborted":
			return theme.fg("error", theme.status.aborted);
	}
}

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false): string {
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
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
	/** Stable Main group order captured when the overlay opens. */
	#rootOrder: Map<string, number> | undefined;
	#groups: HubGroup[] = [];
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
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
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
		const refs = this.#registry.list();

		if (!this.#rowOrder) {
			const initial = [...refs].sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(initial.map((ref, index) => [ref.id, index]));
			this.#rootOrder = new Map();
			const active = initial.find(ref => ref.id === this.#activeTopLevelId);
			this.#rootOrder.set(active?.id ?? this.#activeTopLevelId, 0);
		}

		const rowOrder = this.#rowOrder ?? new Map<string, number>();
		this.#rowOrder = rowOrder;
		for (const ref of refs) {
			if (!rowOrder.has(ref.id)) rowOrder.set(ref.id, rowOrder.size);
		}
		const ordered = [...refs].sort((a, b) => (rowOrder.get(a.id) ?? 0) - (rowOrder.get(b.id) ?? 0));
		const rootOrder = this.#rootOrder ?? new Map<string, number>();
		this.#rootOrder = rootOrder;
		for (const ref of ordered) {
			if (ref.kind === "main" && !rootOrder.has(ref.id)) rootOrder.set(ref.id, rootOrder.size);
		}

		const mainRows: HubRow[] = ordered
			.filter(ref => ref.kind === "main" && ref.id !== this.#activeTopLevelId)
			.map(ref => ({ kind: "main", ref }));
		const grouped = new Map<string, RootSubagentGroup>();
		for (const ref of ordered) {
			if (ref.kind === "main") continue;
			const root = resolveTopLevelAgent(this.#registry, ref.id);
			const rootId = root?.id ?? ref.parentId ?? this.#activeTopLevelId;
			if (!rootOrder.has(rootId)) rootOrder.set(rootId, rootOrder.size);
			let group = grouped.get(rootId);
			if (!group) {
				group = {
					rootId,
					label:
						root !== undefined
							? this.#displayLabel(root)
							: ref.parentId === this.#activeTopLevelId || !ref.parentId
								? this.#activeMainLabel()
								: tSettingsUi("Main"),
					rows: [],
				};
				grouped.set(rootId, group);
			}
			group.rows.push({ kind: "subagent", ref });
		}
		const subagentGroups = [...grouped.values()].sort((left, right) => {
			const leftActive = left.rootId === this.#activeTopLevelId;
			const rightActive = right.rootId === this.#activeTopLevelId;
			if (leftActive !== rightActive) return leftActive ? -1 : 1;
			return (rootOrder.get(left.rootId) ?? 0) - (rootOrder.get(right.rootId) ?? 0);
		});

		this.#groups = [
			...(mainRows.length > 0 ? [{ kind: "mains" as const, rows: mainRows }] : []),
			...(subagentGroups.length > 0 ? [{ kind: "subagents" as const, groups: subagentGroups }] : []),
		];
		this.#rows = [...mainRows, ...subagentGroups.flatMap(group => group.rows)];

		const keptIndex = selectedId ? this.#rows.findIndex(row => row.ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	#displayLabel(ref: AgentRef): string {
		const label = agentDisplayLabel(ref).trim();
		if (!label || UUID_LABEL.test(label)) return ref.kind === "main" ? tSettingsUi("Main") : tSettingsUi("Subagent");
		return replaceTabs(label).replace(/[\r\n]+/g, " ");
	}

	#activeMainLabel(): string {
		const ref = this.#registry.get(this.#activeTopLevelId);
		return ref ? this.#displayLabel(ref) : tSettingsUi("Main");
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(session => session.id === id);
	}

	#activityLines(ref: AgentRef, observed: ObservableSession | undefined, width: number): string[] {
		const progress = observed?.progress;
		const activity = selectAgentActivity(ref.activityState, progress);
		const display = renderAgentActivityDisplay({ activity, progress, width });
		const lines = [display.activityLine, display.statsLine].filter((line): line is string => Boolean(line));
		if (lines.length === 0) {
			const fallback = observed?.description || progress?.task || ref.activity;
			if (fallback) lines.push(theme.fg("muted", sanitizeLine(fallback, width)));
		}
		return lines.map(line => truncateAgentActivityLine(line, width));
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		this.#rowAtScreenLine.clear();
		lines.push(...new DynamicBorder().render(width));
		const counts = this.#statusSummary();
		const activeLabel = this.#activeMainLabel();
		lines.push(
			` ${theme.fg("accent", tSettingsUi("Agent Hub"))}${theme.fg("dim", `${theme.sep.dot}${tSettingsUi("Main")}: `)}${theme.bold(activeLabel)}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`,
		);
		lines.push(...new DynamicBorder().render(width));

		const hintLines = this.#hintLines();
		let messageLine: string | undefined;
		if (this.#messageInput && this.#messageAgentId) {
			const target = this.#registry.get(this.#messageAgentId);
			const label = target ? this.#displayLabel(target) : tSettingsUi("Subagent");
			const prefix = ` ${theme.fg("muted", `m → ${label}: `)}`;
			const input = this.#messageInput.render(Math.max(1, width - 2 - visibleWidth(prefix)))[0] ?? "";
			messageLine = truncateToWidth(`${prefix}${input}`, Math.max(1, width - 2));
		}
		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", tSettingsUi("no subagents yet — task spawns appear here"))}`);
		} else {
			const termHeight = process.stdout.rows || 40;
			const chromeRows = 5 + hintLines.length + (messageLine ? 1 : 0) + (this.#notice ? 1 : 0);
			const budget = Math.max(3, termHeight - chromeRows);
			const blocks = this.#renderBlocks(width);
			const selectedBlock = blocks.findIndex(block => block.rowIndex === this.#selectedRow);
			let start = Math.max(0, selectedBlock);
			let end = Math.min(blocks.length, start + 1);
			let used = blocks[start]?.lines.length ?? 0;
			for (let grew = true; grew; ) {
				grew = false;
				if (end < blocks.length && used + blocks[end]!.lines.length <= budget) {
					used += blocks[end]!.lines.length;
					end++;
					grew = true;
				}
				if (start > 0 && used + blocks[start - 1]!.lines.length <= budget) {
					start--;
					used += blocks[start]!.lines.length;
					grew = true;
				}
			}
			if (start > 0) {
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
			if (end < blocks.length) {
				lines.push(` ${theme.fg("dim", `… ${tSettingsUi("{count} more", { count: blocks.length - end })}`)}`);
			}
		}

		if (messageLine) lines.push(messageLine);
		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		lines.push("");
		lines.push(...hintLines.map(line => ` ${theme.fg("dim", line)}`));
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#renderBlocks(width: number): RenderedHubBlock[] {
		const blocks: RenderedHubBlock[] = [];
		const statusColumnWidth = this.#statusColumnWidth();
		let rowIndex = 0;
		for (const group of this.#groups) {
			if (group.kind === "mains") {
				blocks.push({ lines: [` ${theme.bold(theme.fg("accent", tSettingsUi("Main")))}`] });
				for (const row of group.rows) {
					blocks.push({
						lines: this.#renderEntry(row, rowIndex === this.#selectedRow, width, statusColumnWidth),
						rowIndex,
					});
					rowIndex++;
				}
				continue;
			}
			blocks.push({ lines: [` ${theme.bold(theme.fg("accent", tSettingsUi("Subagents")))}`] });
			for (const rootGroup of group.groups) {
				blocks.push({
					lines: [
						` ${theme.fg("dim", `${theme.sep.dot} ${tSettingsUi("Main")}:`)} ${theme.bold(sanitizeLine(rootGroup.label, Math.max(10, width - 5)))}`,
					],
				});
				for (const row of rootGroup.rows) {
					blocks.push({
						lines: this.#renderEntry(row, rowIndex === this.#selectedRow, width, statusColumnWidth),
						rowIndex,
					});
					rowIndex++;
				}
			}
		}
		return blocks;
	}

	#hintLines(): string[] {
		if (this.#messageInput) return [tSettingsUi("Enter:send message · Esc:cancel message")];
		const selected = this.#rows[this.#selectedRow];
		const enterAction =
			selected?.kind === "main" ? tSettingsUi("Enter:switch session") : tSettingsUi("Enter:open transcript");
		return [
			tSettingsUi("j/k:select · {enterAction} · f:focus live subagent", { enterAction }),
			tSettingsUi("m:message subagent · p:Main"),
			tSettingsUi("r:revive parked subagent · x:kill subagent · Esc/←←:close"),
		];
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

	#statusColumnWidth(): number {
		return this.#rows.reduce(
			(width, row) => Math.max(width, visibleWidth(renderAgentStatusBadge(row.ref.status))),
			0,
		);
	}

	#renderEntry(row: HubRow, selected: boolean, width: number, statusColumnWidth: number): string[] {
		const ref = row.ref;
		const max = Math.max(1, width - 2);
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		let identity = ` ${cursor} ${statusGlyph(ref.status)} ${theme.bold(this.#displayLabel(ref))}`;
		if (row.kind === "main") identity += `  ${theme.fg("dim", tSettingsUi("Main"))}`;
		if (ref.kind === "advisor") identity += `  ${theme.fg("warning", tSettingsUi("read-only"))}`;
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) identity += `  ${theme.fg("warning", `⧉ ${unread}`)}`;

		const status = renderAgentStatusBadge(ref.status);
		const entry: string[] = [];
		if (status && max >= statusColumnWidth + 3) {
			const identityWidth = Math.max(1, max - statusColumnWidth - 2);
			const title = truncateToWidth(identity, identityWidth);
			const statusCell = `${padding(Math.max(0, statusColumnWidth - visibleWidth(status)))}${status}`;
			entry.push(`${title}${padding(max - visibleWidth(title) - statusColumnWidth)}${statusCell}`);
		} else {
			entry.push(truncateToWidth(identity, max));
			if (status) entry.push(`     ${status}`);
		}

		const observed = this.#observableFor(ref.id);
		const badge = modelBadge(ref, observed);
		const age = theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000))));
		const metadata = badge ? `${badge}${theme.sep.dot}${age}` : age;
		entry.push(`     ${truncateToWidth(metadata, Math.max(1, max - 5))}`);

		for (const activityLine of this.#activityLines(ref, observed, Math.max(1, max - 5))) {
			entry.push(`     ${activityLine}`);
		}
		return entry;
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
		if (row?.kind !== "subagent") {
			this.#notice = "Select a subagent to message.";
			this.#requestRender();
			return;
		}
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
		if (selected.kind === "main") {
			this.#switchSelectedMain(selected.ref);
			return;
		}
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
		if (row?.kind !== "subagent") {
			this.#notice = "Select a live subagent to focus.";
			this.#requestRender();
			return;
		}
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
		if (!row || row.kind === "main") {
			this.#notice = "Select a subagent to return to its Main.";
			this.#requestRender();
			return;
		}
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
		if (row.kind === "main") {
			this.#notice = "Main stays live; switch to it with Enter.";
			this.#requestRender();
			return;
		}
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
		if (row.kind === "main") {
			this.#notice = "Main cannot be killed from the Agent Hub.";
			this.#requestRender();
			return;
		}
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
