import { type Component, Container, truncateToWidth } from "@oh-my-pi/pi-tui";
import { tSettingsUi } from "../../i18n/settings-locale";
import { parseXdUrl } from "../../internal-urls/xd-protocol";
import type { IrcDeliveryReceipt } from "../../irc/bus";
import { bodyLines, ircGlyph, messageAge } from "../../tools/hub/messaging";

import type { CoordinationDetails, HubRenderArgs } from "../../tools/hub/types";
import { replaceTabs } from "../../tools/render-utils";
import {
	CachedOutputBlock,
	markFramedBlockComponent,
	type OutputBlockOptions,
	outputBlockContentWidth,
	renderStatusLine,
} from "../../tui";
import { type ThemeColor, theme } from "../theme/theme";
import type { ToolExecutionHandle } from "./tool-execution";

type HubActivityResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
	/** Executor marks a result contextually useless (e.g. clean wait timeout). */
	useless?: boolean;
};

type HubToolActivityEntry = {
	kind: "tool";
	id: string;
	args: HubRenderArgs;
	result?: HubActivityResult;
	partial: boolean;
	hidden?: boolean;
};

export type HubIrcActivityEvent = {
	kind: "incoming" | "autoreply" | "relay";
	from?: string;
	to?: string;
	body?: string;
	replyTo?: string;
	expectsReply?: boolean;
	timestamp?: number;
	sourceId?: string;
};

type HubIrcActivityEntry = HubIrcActivityEvent & {
	kind: HubIrcActivityEvent["kind"];
	id: string;
	age: string;
	settled: boolean;
};
type HubActivityEntry = HubToolActivityEntry | HubIrcActivityEntry;

function resultText(result: HubActivityResult | undefined): string {
	return result?.content.find(part => part.type === "text")?.text?.trim() ?? "";
}
function isWaitingPollEntry(entry: HubToolActivityEntry): boolean {
	if (entry.args.op !== "wait" || !Array.isArray(entry.args.ids) || entry.partial || !entry.result) return false;
	const details = entry.result.details as Partial<CoordinationDetails> | undefined;
	return Boolean(details?.jobs?.length && details.jobs.every(job => job.status === "running"));
}

function receiptStatus(receipts: readonly IrcDeliveryReceipt[], isError: boolean): { color: ThemeColor; text: string } {
	if (isError || receipts.some(receipt => receipt.outcome === "failed")) {
		const failed = receipts.filter(receipt => receipt.outcome === "failed").length;
		return {
			color: "error",
			text: failed > 0 ? tSettingsUi("{count} failed", { count: failed }) : tSettingsUi("failed"),
		};
	}
	if (receipts.length === 1) {
		return { color: "dim", text: tSettingsUi(receipts[0]!.outcome) };
	}
	return { color: "dim", text: tSettingsUi("{count} delivered", { count: receipts.length }) };
}
function activityStatus(status: string): { color: ThemeColor; text: string } {
	switch (status) {
		case "running":
			return { color: "accent", text: tSettingsUi("running") };
		case "waiting":
			return { color: "warning", text: tSettingsUi("waiting") };
		case "idle":
			return { color: "success", text: tSettingsUi("idle") };
		case "completed":
			return { color: "success", text: tSettingsUi("completed") };
		case "failed":
			return { color: "error", text: tSettingsUi("failed") };
		case "cancelled":
			return { color: "muted", text: tSettingsUi("cancelled") };
		case "parked":
			return { color: "muted", text: tSettingsUi("parked") };
		default:
			return { color: "dim", text: replaceTabs(status) };
	}
}
function activityBodyLines(
	head: string,
	body: string,
	expanded: boolean,
	tone: "dim" | "toolOutput" = "toolOutput",
): string[] {
	const lines = bodyLines(body, expanded, theme, { indent: "  ", tone, collapsedLines: 1 });
	if (lines.length === 0) return [head];
	if (expanded) return [head, ...lines];
	return [`${head} ${lines[0]}${lines.length > 1 ? theme.fg("dim", " …") : ""}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Long-running named-process lifecycle activity controlled by `display.showHubProcessActivity`. */
export function isHubProcessActivityArgs(value: unknown): value is HubRenderArgs {
	if (!isRecord(value)) return false;
	if (typeof value.name === "string") return true;
	switch (value.op) {
		case "start":
		case "ps":
		case "logs":
		case "stop":
		case "restart":
		case "describe":
			return true;
		default:
			return false;
	}
}

/** Whether a hub call is peer coordination rather than named-process control. */
export function isHubGroupedActivityArgs(value: unknown): value is HubRenderArgs {
	if (!isRecord(value)) return false;
	if (value.op === "inbox" || value.op === "list") return true;
	if (value.op === "send") return typeof value.name !== "string";
	// A targeted peer wait (`from`) is internal IRC activity. Bare or job-id
	// waits can report jobs and belong in the grouped job-activity renderer.
	return value.op === "wait" && typeof value.name !== "string" && typeof value.from !== "string";
}

/** Peer communication is internal; the anchored subagent HUD surfaces useful feedback. */
export function isHubPeerCommunicationArgs(value: unknown): value is HubRenderArgs {
	if (!isRecord(value) || typeof value.name === "string") return false;
	if (value.op === "inbox" || value.op === "list" || value.op === "send") return true;
	return value.op === "wait" && typeof value.from === "string";
}

/** Whether a direct Hub call or `write xd://hub` carries peer coordination. */
export function isHubPeerCommunicationToolCall(toolName: string, value: unknown): boolean {
	if (toolName === "hub") return isHubPeerCommunicationArgs(value);
	if (toolName !== "write" || !isRecord(value)) return false;
	const rawPath =
		typeof value.path === "string" ? value.path : typeof value.file_path === "string" ? value.file_path : undefined;
	if (rawPath === undefined || parseXdUrl(rawPath)?.name !== "hub" || typeof value.content !== "string") return false;
	try {
		return isHubPeerCommunicationArgs(JSON.parse(value.content));
	} catch {
		return false;
	}
}

/** True while streamed Hub args do not yet carry enough discriminators to choose a renderer. */
export function isHubActivityRoutePending(value: unknown, hasPartialJson: boolean): boolean {
	if (!hasPartialJson) return false;
	if (!isRecord(value)) return true;
	switch (value.op) {
		case "inbox":
		case "list":
		case "jobs":
		case "cancel":
		case "start":
		case "ps":
		case "logs":
		case "stop":
		case "restart":
		case "describe":
			return false;
		case "send":
			return typeof value.name !== "string" && typeof value.to !== "string";
		case "wait":
			return typeof value.name !== "string" && typeof value.from !== "string" && !Array.isArray(value.ids);
		default:
			return true;
	}
}

/**
 * One compact transcript block for an uninterrupted run of hub messaging events.
 * Its header is intentionally byte-stable while open; completed entry rows form
 * a monotone stable prefix that can enter native scrollback without pinning the
 * whole activity run in the live region.
 */
export class HubActivityGroupComponent extends Container implements ToolExecutionHandle {
	#entries: HubActivityEntry[] = [];
	#toolEntries = new Map<string, HubToolActivityEntry>();
	#expanded = false;
	#toolActivityVisible = true;
	#finalized = false;
	#sealed = false;
	#customSequence = 0;
	#settledRows = 0;
	readonly #frame: Component;

	#version = 0;
	constructor() {
		super();
		const block = new CachedOutputBlock();
		this.#frame = markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const options = this.#buildFrame(width);
				return options ? block.render(options, theme) : [];
			},
			invalidate: () => block.invalidate(),
		});
		this.addChild(this.#frame);
	}

	get canAppend(): boolean {
		return !this.#finalized && !this.#sealed;
	}

	get isEmpty(): boolean {
		return this.#entries.length === 0;
	}

	finalize(): void {
		this.#finalized = true;
		this.#invalidate();
	}

	seal(): void {
		this.#sealed = true;
		this.#finalized = true;
		this.#invalidate();
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#sealed) return true;
		if (!this.#finalized) return false;
		return this.#entries.every(entry => entry.kind !== "tool" || (entry.result !== undefined && !entry.partial));
	}

	getTranscriptBlockSettledRows(): number {
		return this.#settledRows;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	#invalidate(): void {
		this.#version++;
		this.#frame.invalidate?.();
	}

	displaceWaitingPoll(nextToolCallId: string): void {
		if (this.#toolEntries.has(nextToolCallId)) return;
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index];
			if (entry?.kind !== "tool" || !isWaitingPollEntry(entry)) continue;
			this.#entries.splice(index, 1);
			this.#toolEntries.delete(entry.id);
			this.#invalidate();
			return;
		}
	}

	updateArgs(args: HubRenderArgs, toolCallId?: string): void {
		if (!toolCallId || !isHubGroupedActivityArgs(args)) return;
		let entry = this.#toolEntries.get(toolCallId);
		if (!entry) {
			if (!this.canAppend) return;
			entry = { kind: "tool", id: toolCallId, args, partial: true };
			this.#toolEntries.set(toolCallId, entry);
			this.#entries.push(entry);
		} else {
			entry.args = args;
		}
		this.#invalidate();
	}

	/** Re-key a streamed hub call without duplicating its existing activity row. */
	renameEntry(oldId: string, newId: string): void {
		if (oldId === newId || !newId) return;
		const entry = this.#toolEntries.get(oldId);
		if (!entry || this.#toolEntries.has(newId)) return;
		this.#toolEntries.delete(oldId);
		entry.id = newId;
		this.#toolEntries.set(newId, entry);
		this.#invalidate();
	}

	updateResult(result: HubActivityResult, isPartial = false, toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#toolEntries.get(toolCallId);
		if (!entry) return;
		entry.result = result;
		entry.partial = isPartial;
		entry.hidden = false;
		if (!isPartial) this.#collapseIdenticalRoster(entry);
		this.#invalidate();
	}

	discardHiddenMessageActivity(result: HubActivityResult, toolCallId?: string): boolean {
		if (!toolCallId) return false;
		const entry = this.#toolEntries.get(toolCallId);
		if (!entry) return false;
		const details = (result.details ?? {}) as Partial<CoordinationDetails>;
		const hidden =
			!result.isError &&
			(entry.args.op === "inbox" ||
				(entry.args.op === "wait" && !entry.args.ids?.length && !(details.jobs?.length ?? 0)));
		if (!hidden) return false;
		const index = this.#entries.indexOf(entry);
		if (index >= 0) this.#entries.splice(index, 1);
		this.#toolEntries.delete(toolCallId);
		this.#invalidate();
		return true;
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#invalidate();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.#invalidate();
	}

	appendIrcEvent(event: HubIrcActivityEvent, settled = true): string | undefined {
		if (!this.canAppend) return undefined;
		const id = `irc:${this.#customSequence++}`;
		this.#entries.push({ ...event, id, age: messageAge(event.timestamp), settled });
		this.#invalidate();
		return id;
	}

	getIrcEventRefs(): Array<{ sourceId: string; eventId: string; timestamp: number | undefined }> {
		return this.#entries.flatMap(entry =>
			entry.kind !== "tool" && entry.sourceId
				? [{ sourceId: entry.sourceId, eventId: entry.id, timestamp: entry.timestamp }]
				: [],
		);
	}

	markIrcEventLive(id: string): boolean {
		const entry = this.#entries.find((item): item is HubIrcActivityEntry => item.kind !== "tool" && item.id === id);
		if (!entry?.settled) return false;
		entry.settled = false;
		this.#invalidate();
		return true;
	}

	settleIrcEvent(id: string): boolean {
		const entry = this.#entries.find((item): item is HubIrcActivityEntry => item.kind !== "tool" && item.id === id);
		if (!entry || entry.settled) return false;
		entry.settled = true;
		this.#invalidate();
		return true;
	}

	removeIrcEvent(id: string): boolean {
		const index = this.#entries.findIndex(entry => entry.kind !== "tool" && entry.id === id);
		if (index < 0) return false;
		this.#entries.splice(index, 1);
		this.#invalidate();
		return true;
	}

	/** Keep one live roster row for an uninterrupted run of equal `list` snapshots. */
	#collapseIdenticalRoster(entry: HubToolActivityEntry): void {
		const result = entry.result;
		if (entry.args.op !== "list" || !result || result.isError || entry.partial) return;
		const index = this.#entries.indexOf(entry);
		if (index < 1) return;

		let previous: HubToolActivityEntry | undefined;
		for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
			const candidate = this.#entries[previousIndex];
			if (candidate?.kind !== "tool" || candidate.args.op !== "list") return;
			if (!candidate.hidden) {
				previous = candidate;
				break;
			}
		}
		if (!previous?.result || previous.partial || previous.result.isError) return;

		const peers = (result.details as Partial<CoordinationDetails> | undefined)?.peers ?? [];
		const previousPeers = (previous.result.details as Partial<CoordinationDetails> | undefined)?.peers ?? [];
		const sameRoster =
			peers.length === previousPeers.length &&
			peers.every((peer, peerIndex) => {
				const prior = previousPeers[peerIndex];
				return (
					prior !== undefined &&
					peer.id === prior.id &&
					peer.displayName === prior.displayName &&
					peer.kind === prior.kind &&
					peer.status === prior.status &&
					peer.parentId === prior.parentId &&
					peer.unread === prior.unread &&
					peer.lastActivity === prior.lastActivity &&
					peer.activity === prior.activity
				);
			});
		if (sameRoster) entry.hidden = true;
	}

	#buildFrame(width: number): OutputBlockOptions | undefined {
		const contentWidth = outputBlockContentWidth(width);
		const renderExpanded = this.#finalized && this.#expanded;
		const rows: string[] = [];
		let stablePrefix = true;
		let settledContentRows = 0;

		for (const entry of this.#entries) {
			const entryRows = this.#entryLines(entry, renderExpanded).map(line => truncateToWidth(line, contentWidth));
			rows.push(...entryRows);
			const settled =
				entry.kind === "tool"
					? entry.result !== undefined &&
						!entry.partial &&
						(this.#finalized || (!isWaitingPollEntry(entry) && entry.args.op !== "list"))
					: entry.settled;
			if (stablePrefix && settled) settledContentRows += entryRows.length;
			else stablePrefix = false;
		}

		if (rows.length === 0) {
			this.#settledRows = 0;
			return undefined;
		}

		// The top/header row is stable because it never includes a live count or age.
		// The moving bottom border is deliberately excluded.
		this.#settledRows = settledContentRows > 0 ? 1 + settledContentRows : 0;
		return {
			header: renderStatusLine({ iconOverride: ircGlyph(theme), title: tSettingsUi("IRC") }, theme),
			sections: [{ lines: rows }],
			borderColor: "borderMuted" as const,
			applyBg: false,
			width,
		};
	}

	#entryLines(entry: HubActivityEntry, expanded: boolean): string[] {
		if (entry.kind === "tool" && (entry.hidden || !this.#toolActivityVisible)) return [];
		if (entry.kind !== "tool") return this.#ircLines(entry, expanded);
		const op = entry.args.op;
		if (op === "send") return this.#sendLines(entry, expanded);
		if (op === "wait") return this.#waitLines(entry, expanded);
		if (op === "inbox") return this.#inboxLines(entry, expanded);
		if (op === "list") return this.#listLines(entry, expanded);
		return [];
	}

	#sendLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		const details = (entry.result?.details ?? {}) as Partial<CoordinationDetails>;
		const from = details.from ?? "?";
		const peer = details.to ?? entry.args.to?.trim() ?? "?";
		const receipts = details.receipts ?? [];
		const status = entry.result
			? receiptStatus(receipts, entry.result.isError === true)
			: { color: "dim" as const, text: tSettingsUi("pending") };
		const head = `  ${theme.fg("customMessageLabel", replaceTabs(from))} ${theme.fg("accent", "→")} ${theme.fg("customMessageLabel", replaceTabs(peer))} ${theme.fg(status.color, status.text)}`;
		const body = entry.args.message?.trim() || (entry.result?.isError ? resultText(entry.result) : "");
		const lines = activityBodyLines(head, body, expanded, "dim");
		if (details.waited === null && entry.result?.isError) {
			lines.push(`  ${theme.fg("warning", tSettingsUi("no reply"))}`);
		}
		for (const receipt of receipts) {
			if (receipt.outcome !== "failed") continue;
			const detail = receipt.error ? ` ${theme.format.dash} ${replaceTabs(receipt.error)}` : "";
			lines.push(`  ${theme.fg("error", `${replaceTabs(receipt.to)}${detail}`)}`);
		}
		return lines;
	}

	#waitLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		const details = (entry.result?.details ?? {}) as Partial<CoordinationDetails>;
		if ((entry.args.ids && entry.args.ids.length > 0) || (details.jobs?.length ?? 0) > 0) {
			return this.#jobWaitLines(entry, expanded);
		}
		if (!entry.result?.isError) return [];
		return [`  ${theme.fg("error", tSettingsUi("failed"))}`];
	}

	#inboxLines(entry: HubToolActivityEntry, _expanded: boolean): string[] {
		if (!entry.result?.isError) return [];
		return [`  ${theme.fg("error", resultText(entry.result) || tSettingsUi("failed"))}`];
	}

	#jobWaitLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		if (!entry.result) {
			const targets = entry.args.ids?.join(", ") || tSettingsUi("jobs");
			return [
				`  ${theme.fg("accent", theme.status.running)} ${theme.fg("customMessageLabel", targets)} ${theme.fg("dim", tSettingsUi("pending"))}`,
			];
		}
		if (entry.result.isError) return [`  ${theme.fg("error", resultText(entry.result) || tSettingsUi("failed"))}`];
		const details = (entry.result.details ?? {}) as Partial<CoordinationDetails>;
		const lines = (details.jobs ?? []).map(job => {
			const status = activityStatus(job.status);
			return `  ${theme.fg(status.color, theme.status[job.status === "running" ? "running" : "enabled"])} ${theme.fg("customMessageLabel", replaceTabs(job.label || job.id))} ${theme.fg(status.color, status.text)}`;
		});
		for (const agent of details.agents ?? []) {
			const head = `  ${theme.fg("accent", theme.status.running)} ${theme.fg("customMessageLabel", replaceTabs(agent.id))} ${theme.fg("accent", tSettingsUi("running"))}`;
			lines.push(...activityBodyLines(head, agent.activity ?? "", expanded, "dim"));
		}
		if (lines.length > 0) return lines;
		return [`  ${theme.fg("dim", resultText(entry.result) || tSettingsUi("empty"))}`];
	}

	#listLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		if (!entry.result) return [`  ${theme.fg("dim", tSettingsUi("pending"))}`];
		if (entry.result.isError) return [`  ${theme.fg("error", resultText(entry.result) || tSettingsUi("failed"))}`];
		const details = (entry.result.details ?? {}) as Partial<CoordinationDetails>;
		const peers = details.peers ?? [];
		if (peers.length === 0) return [`  ${theme.fg("dim", tSettingsUi("empty"))}`];
		const visiblePeers = expanded ? peers : peers.slice(0, 4);
		const lines = visiblePeers.flatMap(peer => {
			const status = activityStatus(peer.status);
			const age = messageAge(peer.lastActivity);
			const glyph = peer.status === "running" || peer.status === "waiting" ? "running" : "enabled";
			const head = `  ${theme.fg(status.color, theme.status[glyph])} ${theme.fg("customMessageLabel", replaceTabs(peer.displayName || peer.id))} ${theme.fg(status.color, status.text)}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			return activityBodyLines(head, peer.activity ?? "", expanded, "dim");
		});
		if (visiblePeers.length < peers.length) {
			lines.push(
				theme.fg("dim", tSettingsUi("… {count} more agents", { count: peers.length - visiblePeers.length })),
			);
		}
		return lines;
	}

	#ircLines(entry: HubIrcActivityEntry, expanded: boolean): string[] {
		const age = entry.age;
		const needsReply = entry.expectsReply ? ` ${theme.fg("warning", tSettingsUi("needs reply"))}` : "";
		if (entry.kind === "incoming") {
			const head = `  ${theme.fg("customMessageLabel", replaceTabs(entry.from?.trim() || "?"))} ${theme.fg("accent", "→")} ${theme.fg("customMessageLabel", replaceTabs(entry.to?.trim() || tSettingsUi("you")))}${needsReply}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			return activityBodyLines(head, entry.body ?? "", expanded);
		}
		if (entry.kind === "autoreply") {
			const head = `  ${theme.fg("customMessageLabel", replaceTabs(entry.from?.trim() || tSettingsUi("you")))} ${theme.fg("accent", "→")} ${theme.fg("customMessageLabel", replaceTabs(entry.to?.trim() || "?"))} ${theme.fg("dim", tSettingsUi("auto"))}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			return activityBodyLines(head, entry.body ?? "", expanded, "dim");
		}
		const head = `  ${theme.fg("customMessageLabel", replaceTabs(entry.from?.trim() || "?"))} ${theme.fg("accent", "→")} ${theme.fg("customMessageLabel", replaceTabs(entry.to?.trim() || "?"))}${needsReply}${age ? ` ${theme.fg("dim", age)}` : ""}`;
		return activityBodyLines(head, entry.body ?? "", expanded);
	}
}
