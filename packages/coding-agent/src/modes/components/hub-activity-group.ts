import { type Component, Container, truncateToWidth } from "@oh-my-pi/pi-tui";
import { tSettingsUi } from "../../i18n/settings-locale";
import type { IrcDeliveryReceipt, IrcMessage } from "../../irc/bus";
import { bodyLines, ircGlyph, messageAge } from "../../tools/hub/messaging";
import type { CoordinationDetails, HubRenderArgs } from "../../tools/hub/types";
import { replaceTabs } from "../../tools/render-utils";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../../tui";
import { type ThemeColor, theme } from "../theme/theme";
import type { ToolExecutionHandle } from "./tool-execution";

type HubActivityResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
};

type HubToolActivityEntry = {
	kind: "tool";
	id: string;
	args: HubRenderArgs;
	result?: HubActivityResult;
	partial: boolean;
	messageAges?: string[];
};

export type HubIrcActivityEvent = {
	kind: "incoming" | "autoreply" | "relay";
	from?: string;
	to?: string;
	body?: string;
	replyTo?: string;
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

function isEmptyMessageWaitResult(entry: HubToolActivityEntry, result: HubActivityResult): boolean {
	if (entry.args.op !== "wait" || Array.isArray(entry.args.ids) || result.isError) return false;
	const details = result.details as Partial<CoordinationDetails> | undefined;
	return details?.waited === null;
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
		return { color: "success", text: tSettingsUi(receipts[0]!.outcome) };
	}
	return { color: "success", text: tSettingsUi("{count} delivered", { count: receipts.length }) };
}
function activityStatus(status: string): { color: ThemeColor; text: string } {
	switch (status) {
		case "running":
			return { color: "accent", text: tSettingsUi("running") };
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

/** Whether a hub call belongs to the compact transcript activity stream. */
export function isHubGroupedActivityArgs(value: unknown): value is HubRenderArgs {
	if (!isRecord(value)) return false;
	if (value.op === "inbox" || value.op === "list") return true;
	if (value.op === "send") return typeof value.name !== "string";
	return (
		value.op === "wait" &&
		typeof value.name !== "string" &&
		(typeof value.from === "string" || Array.isArray(value.ids))
	);
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
	#finalized = false;
	#sealed = false;
	#customSequence = 0;
	#settledRows = 0;
	readonly #frame: Component;

	#version = 0;
	constructor() {
		super();
		this.#frame = framedBlock(theme, width => this.#buildFrame(width));
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

	updateResult(result: HubActivityResult, isPartial = false, toolCallId?: string): void {
		if (!toolCallId) return;
		const entry = this.#toolEntries.get(toolCallId);
		if (!entry) return;
		entry.result = result;
		entry.partial = isPartial;
		const details = result.details as Partial<CoordinationDetails> | undefined;
		const messages = details?.inbox ?? (details?.waited ? [details.waited] : []);
		entry.messageAges = messages.map(message => messageAge(message.ts));
		this.#invalidate();
	}

	discardEmptyMessageWait(result: HubActivityResult, toolCallId?: string): boolean {
		if (!toolCallId) return false;
		const entry = this.#toolEntries.get(toolCallId);
		if (!entry || !isEmptyMessageWaitResult(entry, result)) return false;
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

	#buildFrame(width: number) {
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
					? entry.result !== undefined && !entry.partial && (this.#finalized || !isWaitingPollEntry(entry))
					: entry.settled;
			if (stablePrefix && settled) settledContentRows += entryRows.length;
			else stablePrefix = false;
		}

		// The top/header row is stable because it never includes a live count or age.
		// The moving bottom border is deliberately excluded.
		this.#settledRows = settledContentRows > 0 ? 1 + settledContentRows : 0;
		return {
			header: renderStatusLine({ iconOverride: ircGlyph(theme), title: tSettingsUi("IRC") }, theme),
			sections: [{ lines: rows.length > 0 ? rows : [theme.fg("dim", tSettingsUi("pending"))] }],
			borderColor: "borderMuted" as const,
			applyBg: false,
			width,
		};
	}

	#entryLines(entry: HubActivityEntry, expanded: boolean): string[] {
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
		const peer = details.to ?? entry.args.to?.trim() ?? "?";
		const receipts = details.receipts ?? [];
		const status = entry.result
			? receiptStatus(receipts, entry.result.isError === true)
			: { color: "dim" as const, text: tSettingsUi("pending") };
		const head = `  ${theme.fg("accent", theme.nav.selected)} ${theme.fg("customMessageLabel", replaceTabs(peer))} ${theme.fg(status.color, status.text)}`;
		const body = entry.args.message?.trim() || (entry.result?.isError ? resultText(entry.result) : "");
		const lines = activityBodyLines(head, body, expanded, "dim");
		const waited = details.waited;
		if (waited) lines.push(...this.#receivedMessageLines(waited, expanded, entry.messageAges?.[0]));
		else if (waited === null) lines.push(`  ${theme.fg("warning", tSettingsUi("no reply"))}`);
		return lines;
	}

	#waitLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		if (Array.isArray(entry.args.ids)) return this.#jobWaitLines(entry, expanded);
		const details = (entry.result?.details ?? {}) as Partial<CoordinationDetails>;
		if (!entry.result) {
			const peer = entry.args.from?.trim() || tSettingsUi("anyone");
			return [
				`  ${theme.fg("accent", theme.nav.back)} ${theme.fg("customMessageLabel", peer)} ${theme.fg("dim", tSettingsUi("pending"))}`,
			];
		}
		if (details.waited) return this.#receivedMessageLines(details.waited, expanded, entry.messageAges?.[0]);
		const color: ThemeColor = entry.result.isError ? "error" : "warning";
		return [`  ${theme.fg(color, entry.result.isError ? tSettingsUi("failed") : tSettingsUi("no reply"))}`];
	}

	#inboxLines(entry: HubToolActivityEntry, expanded: boolean): string[] {
		const details = (entry.result?.details ?? {}) as Partial<CoordinationDetails>;
		if (!entry.result) return [`  ${theme.fg("dim", tSettingsUi("pending"))}`];
		if (entry.result.isError) return [`  ${theme.fg("error", resultText(entry.result) || tSettingsUi("failed"))}`];
		const messages = details.inbox ?? [];
		if (messages.length === 0) return [`  ${theme.fg("dim", tSettingsUi("empty"))}`];
		return messages.flatMap((message, index) =>
			this.#receivedMessageLines(message, expanded, entry.messageAges?.[index]),
		);
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
			const head = `  ${theme.fg(status.color, theme.status[peer.status === "running" ? "running" : "enabled"])} ${theme.fg("customMessageLabel", replaceTabs(peer.displayName || peer.id))} ${theme.fg(status.color, status.text)}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			return activityBodyLines(head, peer.activity ?? "", expanded, "dim");
		});
		if (visiblePeers.length < peers.length) {
			lines.push(
				theme.fg("dim", tSettingsUi("… {count} more agents", { count: peers.length - visiblePeers.length })),
			);
		}
		return lines;
	}

	#receivedMessageLines(message: IrcMessage, expanded: boolean, age = ""): string[] {
		const reply = message.replyTo ? ` ${theme.fg("dim", tSettingsUi("reply"))}` : "";
		const head = `  ${theme.fg("accent", theme.nav.back)} ${theme.fg("customMessageLabel", replaceTabs(message.from))}${age ? ` ${theme.fg("dim", age)}` : ""}${reply}`;
		return activityBodyLines(head, message.body, expanded);
	}

	#ircLines(entry: HubIrcActivityEntry, expanded: boolean): string[] {
		const age = entry.age;
		if (entry.kind === "incoming") {
			const head = `  ${theme.fg("accent", theme.nav.back)} ${theme.fg("customMessageLabel", replaceTabs(entry.from?.trim() || "?"))}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			return activityBodyLines(head, entry.body ?? "", expanded);
		}
		if (entry.kind === "autoreply") {
			const head = `  ${theme.fg("accent", theme.nav.selected)} ${theme.fg("customMessageLabel", replaceTabs(entry.to?.trim() || "?"))} ${theme.fg("dim", tSettingsUi("auto"))}`;
			return activityBodyLines(head, entry.body ?? "", expanded, "dim");
		}
		const head = `  ${theme.fg("customMessageLabel", replaceTabs(entry.from?.trim() || "?"))} ${theme.fg("accent", theme.nav.selected)} ${theme.fg("customMessageLabel", replaceTabs(entry.to?.trim() || "?"))}${age ? ` ${theme.fg("dim", age)}` : ""}`;
		return activityBodyLines(head, entry.body ?? "", expanded);
	}
}
