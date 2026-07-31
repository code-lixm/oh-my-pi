/**
 * Session-bound file snapshot store.
 *
 * Used by `read` and `search` to record exactly what the model saw, and by
 * the hashline patcher to verify or recover from stale section tags (file
 * changed externally between read and edit, or a prior in-session edit
 * advanced the tag). The store is the {@link InMemorySnapshotStore}
 * from `@oh-my-pi/hashline`; the only coding-agent-specific concern here
 * is wiring it onto the per-session owner object.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	InMemorySnapshotStore,
} from "@oh-my-pi/hashline";
import { normalizeToLF } from "./normalize";

/**
 * Upper bound on the file size we snapshot. A section tag is a content hash of
 * the *whole* file, so minting one means holding the full normalized text in
 * the store. Files above this cap emit no `[path#tag]` header — line-anchored
 * editing of multi-megabyte files is out of scope under the full-content model.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

interface FileSnapshotStoreOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

/**
 * Look up (or lazily create) the file snapshot store attached to a session.
 * Storage lives on `session.fileSnapshotStore` so it ages out exactly with
 * the session itself.
 */
export function getFileSnapshotStore(session: FileSnapshotStoreOwner): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}

/**
 * Canonicalize an absolute path into the stable key the snapshot store uses.
 *
 * Different code paths reach the snapshot store via different path forms:
 * `read local://foo.md` records under the file's `fs.realpath` (the local
 * protocol handler resolves symlinks); a subsequent `edit` may address the
 * same artifact via `local://foo.md`, whose resolver does NOT realpath, or
 * via the absolute path returned in the `[path#tag]` header. macOS adds the
 * same hazard at the working-tree level (`/tmp/...` vs `/private/tmp/...`).
 * Collapsing every key through `realpath` makes those forms fuse onto one
 * snapshot entry, so a freshly-minted tag is never rejected as stale just
 * because the lookup spelled the same file differently.
 *
 * Non-existent paths (new-file writes) fall back to a realpath of the parent
 * directory + basename, then to the input. This keeps creates and updates on
 * the same canonical key.
 */
export function canonicalSnapshotKey(absolutePath: string): string {
	let candidate = absolutePath;
	const missingSegments: string[] = [];
	for (;;) {
		try {
			const canonical = fs.realpathSync.native(candidate);
			return missingSegments.length > 0 ? path.join(canonical, ...missingSegments.reverse()) : canonical;
		} catch {
			const parent = path.dirname(candidate);
			if (parent === candidate) return absolutePath;
			missingSegments.push(path.basename(candidate));
			candidate = parent;
		}
	}
}

/**
 * Read the full text of `absolutePath` (within {@link SNAPSHOT_MAX_BYTES}),
 * record it as a version snapshot, and return its content-hash tag. Returns
 * `undefined` when the file exceeds the cap or cannot be read — callers then
 * omit the section header so the model never sees a tag it can't anchor against.
 *
 * Producers that only displayed a slice of the file (range reads, search hits)
 * use this to mint a whole-file tag: the displayed lines stay partial, but the
 * tag fingerprints the entire file so a follow-up edit anchored at any line
 * validates whenever the live file is byte-identical to what was read. Raw
 * reads pass `seenLines` even though they do not emit a header, letting a prior
 * or later same-content hashline tag inherit the raw range's provenance.
 */
export async function recordFileSnapshot(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	seenLines?: Iterable<number>,
): Promise<string | undefined> {
	try {
		const file = Bun.file(absolutePath);
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const normalized = normalizeToLF(await file.text());
		return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized, seenLines);
	} catch {
		return undefined;
	}
}

/** Format an already-minted snapshot tag for a model-visible source section. */
export function formatHashlineSourceHeader(anchor: string, tag: string): string {
	return formatHashlineHeader(anchor, tag);
}

/** A whole-current-source snapshot and its model-visible hashline header. */
export interface HashlineSourceSnapshot {
	tag: string;
	header: string;
	/** Normalized current disk text used to mint {@link tag}. */
	fullText: string;
}

/** Inputs for minting a hashline snapshot from text the caller already has. */
export interface RecordHashlineSourceSnapshotOptions {
	absolutePath: string;
	/** Exact path text to place in `[PATH#TAG]`; callers choose its resolution semantics. */
	anchor: string;
	fullText: string;
	seenLines?: Iterable<number>;
}

function recordNormalizedHashlineSourceSnapshot(
	session: FileSnapshotStoreOwner,
	options: RecordHashlineSourceSnapshotOptions,
	fullText: string,
): HashlineSourceSnapshot | undefined {
	if (!path.isAbsolute(options.absolutePath) || Buffer.byteLength(fullText) > SNAPSHOT_MAX_BYTES) return undefined;
	const tag = getFileSnapshotStore(session).record(
		canonicalSnapshotKey(options.absolutePath),
		fullText,
		options.seenLines,
	);
	return { tag, header: formatHashlineSourceHeader(options.anchor, tag), fullText };
}

/**
 * Mint a hashline snapshot from current full source text already loaded by a
 * tool. This keeps every producer on the same store/key/normalization path and
 * records exactly the source lines made visible to the model.
 */
export function recordHashlineSourceSnapshot(
	session: FileSnapshotStoreOwner,
	options: RecordHashlineSourceSnapshotOptions,
): HashlineSourceSnapshot | undefined {
	return recordNormalizedHashlineSourceSnapshot(session, options, normalizeToLF(options.fullText));
}

/** Inputs for formatting one current-source section for model use. */
export interface FormatHashlineSourceSectionOptions {
	absolutePath: string;
	anchor: string;
	fullText: string;
	startLine: number;
	endLine: number;
	/** Exact original lines for outline/window sections; omitted means the full contiguous range. */
	lineNumbers?: readonly number[];
}

/** Current-source section with raw line numbers and an editable snapshot header when eligible. */
export interface FormattedHashlineSourceSection {
	text: string;
	displayText: string;
	startLine: number;
	endLine: number;
	lineNumbers: number[];
	snapshot?: HashlineSourceSnapshot;
}

/**
 * Render a source section with its original file line numbers. The whole file
 * is snapshotted once; only the displayed lines are marked seen, so a following
 * hashline edit needs no extra `read` call.
 */
export function formatHashlineSourceSection(
	session: FileSnapshotStoreOwner,
	options: FormatHashlineSourceSectionOptions,
): FormattedHashlineSourceSection {
	const fullText = normalizeToLF(options.fullText);
	const allLines = fullText.split("\n");
	const requestedLines =
		options.lineNumbers ??
		Array.from(
			{ length: Math.max(0, Math.floor(options.endLine) - Math.floor(options.startLine) + 1) },
			(_, index) => Math.floor(options.startLine) + index,
		);
	const lineNumbers: number[] = [];
	const displayLines: string[] = [];
	const seen = new Set<number>();
	for (const requestedLine of requestedLines) {
		const line = Math.floor(requestedLine);
		if (!Number.isFinite(line) || line < 1 || line > allLines.length || seen.has(line)) continue;
		seen.add(line);
		lineNumbers.push(line);
		displayLines.push(allLines[line - 1] ?? "");
	}
	const startLine = lineNumbers[0] ?? Math.max(1, Math.floor(options.startLine));
	const endLine = lineNumbers[lineNumbers.length - 1] ?? Math.max(startLine, Math.floor(options.endLine));
	const displayText = displayLines.join("\n");
	if (lineNumbers.length === 0) {
		return { text: "", displayText, startLine, endLine, lineNumbers };
	}
	const snapshot = recordNormalizedHashlineSourceSnapshot(session, { ...options, seenLines: lineNumbers }, fullText);
	const contiguous = lineNumbers.every((line, index) => index === 0 || line === (lineNumbers[index - 1] ?? 0) + 1);
	const body = contiguous
		? formatNumberedLines(displayText, startLine)
		: displayLines.map((line, index) => formatNumberedLine(lineNumbers[index] ?? startLine, line)).join("\n");
	return {
		text: snapshot ? `${snapshot.header}\n${body}` : body,
		displayText,
		startLine,
		endLine,
		lineNumbers,
		...(snapshot ? { snapshot } : {}),
	};
}

/**
 * Leading line-number prefix the hashline/summary/grep formatters stamp on
 * every displayed body line: `NN:` or a collapsed summary `NN-MM:` from `read`,
 * optionally preceded by a grep `*` (match) / space (context) marker from
 * `search`/`ast-grep`. Anchored at line start, so source content after the
 * colon never matches.
 */
const HASHLINE_LINE_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

/**
 * The 1-indexed file lines a hashline-formatted body actually displayed.
 * Single `NN:` rows contribute that line; a collapsed summary `NN-MM:` row
 * (a `{ … }` brace pair) contributes only its boundary lines `NN` and `MM` —
 * the elided interior was never shown, so editing inside it must be rejected.
 */
export function parseSeenLinesFromHashlineBody(body: string): number[] {
	const seen: number[] = [];
	for (const row of body.split("\n")) {
		const match = HASHLINE_LINE_PREFIX.exec(row);
		if (!match) continue;
		seen.push(Number(match[1]));
		if (match[2] !== undefined) seen.push(Number(match[2]));
	}
	return seen;
}

/** Merge explicit 1-indexed displayed lines into a recorded hashline snapshot. */
export function recordSeenLines(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	lines: readonly number[],
): void {
	if (lines.length === 0) return;
	getFileSnapshotStore(session).recordSeenLines(canonicalSnapshotKey(absolutePath), tag, lines);
}

/**
 * Attach the lines a read displayed to the snapshot it minted, so the patcher's
 * (opt-in) seen-line guard can reject edits anchored on lines the model never
 * saw. Best-effort: a no-op when the body has no numbered rows or the snapshot
 * already aged out. `tag` must be the tag returned when this exact content was
 * recorded. Every displayed `NN:` row counts as seen, including column-clipped
 * rows — the guard no longer distinguishes full-width from truncated display.
 */
export function recordSeenLinesFromBody(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	body: string,
): void {
	recordSeenLines(session, absolutePath, tag, parseSeenLinesFromHashlineBody(body));
}
