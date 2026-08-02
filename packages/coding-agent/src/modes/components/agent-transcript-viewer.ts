/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * Local transcripts tail append-only growth: unchanged file identity plus stable
 * sentinels means only newly appended JSONL is parsed and rendered. Rewrites,
 * truncation, rotation, or sentinel drift fall back to a full rebuild so changed
 * historical entries cannot leave stale components behind. Collab guests use the
 * same append path over the host's byte-capped transcript reads.
 */
import * as fs from "node:fs";
import type { Clipboard, SnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { tSettingsUi } from "../../i18n/settings-locale";
import { type AgentRef, type AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { formatAgentDuration, renderAgentStatusBadge } from "./agent-activity-display";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { rawKeyHint } from "./keybinding-hints";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "./status-line/context-thresholds";

export interface AgentTranscriptViewerDeps {
	agentId: string;
	/** Stable Hub-visible order. Main is excluded; advisors and terminal rows remain viewable. */
	getVisibleAgentIds?: () => readonly string[];
	/** Keeps the Hub selection synchronized after an in-place viewer retarget. */
	onAgentChange?: (agentId: string) => void;
	/** Accepted from existing Hub callers; compact transcripts intentionally omit delivery state. */
	getTaskOutcome?: (agentId: string) => Pick<TranscriptProgressSnapshot, "resultText" | "deliveryStatus"> | undefined;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress snapshot source for compact header metadata. */
	observers?: SessionObserverRegistry;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Resolve snapshot state for a live local agent transcript. */
	getSnapshots?: (agentId: string) => SnapshotStore | undefined;
	/** Resolve the edit register for a live local agent transcript. */
	getClipboard?: (agentId: string) => Clipboard | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
	/**
	 * Forwarded to {@link ChatTranscriptBuilder}: click handler for Markdown link
	 * cells. The viewer host (AgentHubOverlayComponent) derives this from the
	 * ambient InteractiveModeContext.openInBrowser. Optional: omitted leaves
	 * Markdown link cells non-clickable.
	 */
	openLink?: (href: string) => void;
	/**
	 * Forwarded to {@link ChatTranscriptBuilder}: click handler for tool-result
	 * / native assistant images (and the no-protocol text fallback). Host
	 * materializes the original bytes via its session blob store and routes
	 * through openInBrowser. Optional: omitted leaves image cells non-clickable.
	 */
	openImage?: (image: import("@oh-my-pi/pi-ai").ImageContent) => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;

const SENTINEL_BYTES = 4096;
const FIXED_HEADER_ROWS = 1;
const MIN_NAVIGATION_TITLE_WIDTH = 12;

/** Sanitize wire-delivered error text for a single TUI row: tabs/newlines → spaces, strip controls,
 *  absolute paths shortened, truncated to `maxWidth`.
 *  `#remoteError` arrives as `String(err)` from the host — it can carry
 *  multi-line stacks and absolute host paths that would break the frame's
 *  1-row accounting and leak host filesystem layout to guests. */
function sanitizeErrorLine(text: string, maxWidth: number): string {
	const singleLine = sanitizeText(replaceTabs(text).replace(/[\r\n]+/g, " ")).replace(/\/[^\s'")\]]+/g, p =>
		shortenPath(p),
	);
	return truncateToWidth(singleLine, Math.max(1, maxWidth));
}

/** Task timing/status plus legacy result fields retained for the Hub dependency boundary. */
interface TranscriptProgressSnapshot {
	status?: string;
	startedAtMs?: number;
	completedAtMs?: number;
	durationMs?: number;
	resolvedModel?: string;
	resultText?: string;
	deliveryStatus?: "pending" | "delivering" | "delivered" | "dead-letter";
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Normalize arbitrary task/agent text before it reaches one fixed-height TUI row. */
function sanitizeViewerText(value: unknown, maxWidth: number): string {
	if (typeof value !== "string") return "";
	const singleLine = sanitizeText(replaceTabs(value).replace(/[\r\n]+/g, " "))
		.replace(/ +/g, " ")
		.trim();
	return truncateToWidth(singleLine, Math.max(1, maxWidth));
}

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	pending: string;
	sentinels: LocalTranscriptSentinel[];
}

function readFileRangeSync(file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromBuffer(buffer: Buffer): LocalTranscriptSentinel[] {
	const size = buffer.byteLength;
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({
		offset,
		bytes: Buffer.from(buffer.subarray(offset, offset + length)),
	}));
}

function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}

export class AgentTranscriptViewer implements Component {
	#agentId: string;
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#followBottom = true;
	#expanded = false;

	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#model: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#agentId = deps.agentId;
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			getMessageRenderer: deps.getMessageRenderer,
			getSnapshots: () => deps.getSnapshots?.(this.#agentId),
			getClipboard: () => deps.getClipboard?.(this.#agentId),
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
			openLink: deps.openLink,
			openImage: deps.openImage,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "always",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		this.#refresh();
		this.#startPolling();
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#remoteToken++;
		this.#builder.dispose();
	}

	/** Current target, which may change while the fullscreen overlay stays mounted. */
	get agentId(): string {
		return this.#agentId;
	}

	/**
	 * Change the displayed agent without recreating the fullscreen overlay.
	 * Existing async remote reads are invalidated before the new source is loaded.
	 */
	retarget(agentId: string): boolean {
		if (this.#disposed || !agentId || agentId === MAIN_AGENT_ID || agentId === this.#agentId) return false;
		this.#agentId = agentId;
		this.#resetTranscriptState();
		this.deps.onAgentChange?.(agentId);
		this.#startPolling();
		this.#refresh();
		this.deps.requestRender();
		return true;
	}

	#resetTranscriptState(): void {
		this.#localState = undefined;
		this.#localUnavailable = "";
		this.#remoteToken++;
		this.#remoteBytes = 0;
		this.#remoteFetchInFlight = false;
		this.#remoteUnavailable = false;
		this.#remoteError = "";
		this.#hasRemoteData = false;
		this.#model = undefined;
		this.#builder.rebuild([]);
		this.#scrollView.setLines([]);
		this.#scrollView.scrollToTop();
		this.#followBottom = true;
	}

	#startPolling(): void {
		if (this.#pollTimer || this.#disposed) return;
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	#stopPolling(): void {
		if (!this.#pollTimer) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Refresh the transcript from a local file or remote host. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.#agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#localState;
		if (state && this.#canAppendLocal(sessionFile, stat, state)) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
			if (stat.size > state.size) {
				this.#appendLocal(sessionFile, stat, state);
				return;
			}
		}
		this.#loadLocalFull(sessionFile, stat);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#rebuild([]);
	}

	#canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(sessionFile, sentinel.offset, sentinel.bytes.byteLength);
			} catch (err) {
				// The file can be unlinked/rotated between statSync and this read.
				// Treat as not-appendable so #refresh falls back to a guarded full load.
				logger.debug("transcript viewer: sentinel read failed", { err: String(err) });
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	#loadLocalFull(sessionFile: string, stat: fs.Stats): void {
		let data: Buffer;
		try {
			data = fs.readFileSync(sessionFile);
		} catch (err) {
			// Leave #localState unchanged so a transient read error retries next poll.
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		// The file may have grown between the earlier `statSync` and this read.
		// Anchor the tail cursor to what we actually consumed so the next poll's
		// `#appendLocal` never re-renders bytes already in the rebuilt transcript;
		// re-stat for mtime/identity so the post-read clock matches what's on disk.
		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
		} catch {
			post = stat;
		}
		// A reader that opens the file mid-append sees a trailing partial line
		// (no terminating newline). Carry those bytes as `pending` so the next
		// poll's `#appendLocal` joins them with the completion bytes instead of
		// parsing a headless line fragment and dropping the entry.
		const text = data.toString("utf-8");
		const lastNewline = text.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
		const pending = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			dev: post.dev,
			ino: post.ino,
			size: data.byteLength,
			mtimeMs: post.mtimeMs,
			offset: data.byteLength,
			pending,
			sentinels: sentinelsFromBuffer(data),
		};
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(parseSessionEntries(complete)));
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let chunk: string;
		try {
			chunk = readFileRangeSync(sessionFile, state.offset, stat.size - state.offset).toString("utf-8");
		} catch (err) {
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		const combined = state.pending + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline + 1) : "";
		const previousModel = this.#model;
		const parsed = complete ? this.#extractMessages(parseSessionEntries(complete)) : [];
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			// File unlinked/rotated mid-poll: fall back to a guarded full reload
			// instead of letting the open escape the poll timer.
			logger.debug("transcript viewer: sentinel recompute failed", { err: String(err) });
			this.#loadLocalFull(sessionFile, stat);
			return;
		}
		this.#localState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: stat.size,
			pending: lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined,
			sentinels,
		};
		if (parsed.length > 0) {
			this.#append(parsed);
		} else if (this.#model !== previousModel) {
			this.deps.requestRender();
		}
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.#agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.deps.requestRender();
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — drop the stale rendered rows
					// before restarting; otherwise the post-rotation fetch would stack
					// new content under the pre-rotation history.
					this.#remoteBytes = 0;
					this.#remoteError = "";
					this.#hasRemoteData = false;
					this.#model = undefined;
					this.#rebuild([]);
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				this.#remoteError = "";
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const completeChunk = result.text.slice(0, lastNewline + 1);
					this.#remoteBytes = fromByte + Buffer.byteLength(completeChunk, "utf-8");
					const previousModel = this.#model;
					const parsed = this.#extractMessages(parseSessionEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
					if (this.#model !== previousModel) {
						this.deps.requestRender();
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		const messages: SessionMessageEntry[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#builder.rebuild(entries);
		this.deps.requestRender();
	}

	#append(entries: SessionMessageEntry[]): void {
		this.#builder.append(entries);
		this.deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#syncFollow();
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}

		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}

		if (matchesKey(data, "alt+k")) {
			this.#cycleAgent(-1);
			return;
		}

		if (matchesKey(data, "alt+j")) {
			this.#cycleAgent(1);
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.deps.onHubClose();
				return;
			}
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		this.#handleScroll(data);
	}

	/** Returns true when the key was a scroll command. ScrollView owns the offset. */
	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.deps.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#visibleAgentIds(): string[] {
		const visible = this.deps.getVisibleAgentIds?.() ?? this.deps.registry.list().map(ref => ref.id);
		const ids: string[] = [];
		const seen = new Set<string>();
		for (const id of visible) {
			if (!id || id === MAIN_AGENT_ID || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	}

	#cycleAgent(delta: -1 | 1): void {
		const ids = this.#visibleAgentIds();
		if (ids.length === 0) return;
		const current = ids.indexOf(this.#agentId);
		const next = current < 0 ? (delta < 0 ? ids.length - 1 : 0) : (current + delta + ids.length) % ids.length;
		this.retarget(ids[next]!);
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// Header row shares the transcript's single-column gutter. ScrollView keeps
		// the final column for its scrollbar, so the body receives no extra pad.
		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.#agentId);
		const observed = this.#observed();
		const headerLine = this.#headerLine(ref, observed, innerWidth);
		const viewportHeight = Math.max(3, termHeight - FIXED_HEADER_ROWS - 2);
		const transcriptLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder(Math.max(1, contentWidth - 1)))}`]
			: this.#builder.container.render(contentWidth);
		// A terminal remote-read error must remain visible after earlier transcript rows,
		// without restoring the removed multi-row status panel.
		const contentLines =
			this.#remoteError && !this.#builder.isEmpty
				? [
						...transcriptLines,
						` ${theme.fg("error", sanitizeErrorLine(this.#remoteError, Math.max(1, contentWidth - 1)))}`,
					]
				: transcriptLines;
		this.#scrollView.setLines(contentLines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		lines.push(` ${truncateToWidth(headerLine, innerWidth)}`);
		for (const row of this.#scrollView.render(width)) lines.push(row);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLine(ref: AgentRef | undefined, observed: ObservableSession | undefined, width: number): string {
		const progress: TranscriptProgressSnapshot | undefined = observed?.progress;
		const terminal = this.#isTerminal(ref, progress);
		const previous = rawKeyHint("Alt+K", tSettingsUi("previous"));
		const next = rawKeyHint("Alt+J", tSettingsUi("next"));
		const metadata = [
			this.#metadataValue("Model", this.#modelValue(observed)),
			this.#metadataValue("Context", this.#contextValue(observed)),
			this.#metadataValue("Duration", this.#runtimeValue(ref, progress, terminal)),
			this.#metadataValue("Status", this.#statusValue(ref, progress)),
		].filter((value): value is string => value !== undefined);
		const separator = theme.fg("dim", theme.sep.dot);
		const minimumNavigationWidth = visibleWidth(previous) + visibleWidth(next) + 2 + MIN_NAVIGATION_TITLE_WIDTH;

		// Keep task identity, both cycle controls, and current status while dropping
		// progressively less essential metadata for narrow terminal widths.
		while (metadata.length > 1) {
			const metadataText = metadata.join(separator);
			const reservedWidth = visibleWidth(metadataText) + visibleWidth(separator);
			if (width - reservedWidth >= minimumNavigationWidth) break;
			metadata.shift();
		}

		const metadataText = metadata.join(separator);
		const metadataWidth = metadataText ? visibleWidth(metadataText) + visibleWidth(separator) : 0;
		const navigation = this.#navigationLine(ref, observed, Math.max(1, width - metadataWidth), previous, next);
		return metadataText
			? truncateToWidth(`${navigation}${separator}${metadataText}`, Math.max(1, width))
			: navigation;
	}

	#navigationLine(
		ref: AgentRef | undefined,
		observed: ObservableSession | undefined,
		width: number,
		previous: string,
		next: string,
	): string {
		const ids = this.#visibleAgentIds();
		const index = ids.indexOf(this.#agentId);
		const ordinal = `${index >= 0 ? index + 1 : 1}/${Math.max(1, ids.length)}`;
		const name =
			sanitizeViewerText(
				observed?.description ?? observed?.label ?? ref?.displayName ?? this.#agentId,
				Math.max(1, width),
			) || "—";
		const title = [theme.fg("dim", ordinal), theme.bold(name)].join(theme.fg("dim", theme.sep.dot));
		return this.#centerWithControls(previous, title, next, width);
	}

	#centerWithControls(left: string, title: string, right: string, width: number): string {
		const maxWidth = Math.max(1, width);
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (maxWidth < leftWidth + rightWidth + 2) return truncateToWidth(`${left} ${right}`, maxWidth);
		const titleWidth = Math.max(1, maxWidth - leftWidth - rightWidth - 2);
		const clippedTitle = truncateToWidth(title, titleWidth);
		const clippedWidth = visibleWidth(clippedTitle);
		const rightStart = maxWidth - rightWidth;
		const centeredStart = Math.floor((maxWidth - clippedWidth) / 2);
		const start = Math.min(Math.max(leftWidth + 1, centeredStart), rightStart - clippedWidth - 1);
		return `${left}${padding(start - leftWidth)}${clippedTitle}${padding(rightStart - start - clippedWidth)}${right}`;
	}

	#metadataValue(label: string, value: string | undefined): string | undefined {
		if (!value) return undefined;
		return `${theme.fg("dim", `${tSettingsUi(label)}:`)} ${value}`;
	}

	#statusValue(ref: AgentRef | undefined, progress: TranscriptProgressSnapshot | undefined): string | undefined {
		if (ref?.status) return renderAgentStatusBadge(ref.status) || undefined;
		const status = progress?.status;
		switch (status) {
			case "pending":
			case "running":
			case "completed":
			case "failed":
			case "aborted":
				return renderAgentStatusBadge(status) || undefined;
			default:
				return undefined;
		}
	}

	#contextValue(observed: ObservableSession | undefined): string | undefined {
		const tokens = observed?.progress?.contextTokens;
		if (!isFiniteNumber(tokens) || tokens < 0) return undefined;
		const window = observed?.progress?.contextWindow;
		const contextWindow = isFiniteNumber(window) && window > 0 ? window : 0;
		const percent = contextWindow > 0 ? (tokens / contextWindow) * 100 : undefined;
		const usage = formatContextUsage(percent, contextWindow, tokens).replace(/\.0%(?=\/)/, "%");
		if (percent === undefined) return theme.fg("dim", usage);
		return theme.fg(getContextUsageThemeColor(getContextUsageLevel(percent, contextWindow)), usage);
	}

	#runtimeValue(
		ref: AgentRef | undefined,
		progress: TranscriptProgressSnapshot | undefined,
		terminal: boolean,
	): string | undefined {
		const durationMs = progress?.durationMs;
		const startedAtMs = progress?.startedAtMs;
		const completedAtMs = progress?.completedAtMs;
		const frozenAtMs = ref?.lastActivity;
		const storedDuration = isFiniteNumber(durationMs) ? Math.max(0, durationMs) : undefined;
		let elapsedMs: number | undefined;
		if (terminal && isFiniteNumber(startedAtMs) && isFiniteNumber(completedAtMs)) {
			elapsedMs = Math.max(0, completedAtMs - startedAtMs);
		} else if (terminal && storedDuration !== undefined) {
			elapsedMs = storedDuration;
		} else if (isFiniteNumber(startedAtMs)) {
			const endMs = !terminal ? Date.now() : isFiniteNumber(frozenAtMs) ? frozenAtMs : startedAtMs;
			elapsedMs = Math.max(0, endMs - startedAtMs);
		} else if (storedDuration !== undefined) {
			elapsedMs = storedDuration;
		}
		return elapsedMs === undefined ? undefined : theme.fg("muted", formatAgentDuration(elapsedMs));
	}

	#modelValue(observed: ObservableSession | undefined): string | undefined {
		return (
			sanitizeViewerText(observed?.progress?.resolvedModel ?? observed?.resolvedModel ?? this.#model, 48) ||
			undefined
		);
	}

	#isTerminal(ref: AgentRef | undefined, progress: TranscriptProgressSnapshot | undefined): boolean {
		return (
			progress?.status === "completed" ||
			progress?.status === "failed" ||
			progress?.status === "aborted" ||
			ref?.status === "idle" ||
			ref?.status === "parked" ||
			ref?.status === "aborted"
		);
	}

	#observed(): ObservableSession | undefined {
		return this.deps.observers?.getSessions().find(session => session.id === this.#agentId);
	}

	#placeholder(maxWidth: number): string {
		if (this.deps.remote) {
			if (this.#remoteError) return sanitizeErrorLine(this.#remoteError, maxWidth);
			if (this.#remoteUnavailable) return tSettingsUi("Transcript lives on the host — not available.");
			return this.#hasRemoteData ? tSettingsUi("No messages yet.") : tSettingsUi("Loading transcript from host…");
		}
		if (!this.deps.registry.get(this.#agentId)?.sessionFile) return tSettingsUi("No session file available yet.");
		return tSettingsUi("No messages yet.");
	}
}
