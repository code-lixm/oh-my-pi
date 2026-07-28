/**
 * Built-in `codegraph` tool.
 *
 * Read-only semantic exploration over the CodeGraph runtime facade
 * (`../codegraph`). The tool:
 *   - resolves an index location from the session cwd or the optional target path,
 *   - schedules the cold work on a Bun Worker (the supervisor in
 *     `../codegraph/supervisor`); cold callers receive an indexing
 *     fallback pointing at the persistent progress state — they never
 *     block on warm initialization,
 *   - on warm slots, performs a scoped sync (explicit `path` argument +
 *     pending file mutations) instead of the unconditional full-project
 *     sync the previous version did,
 *   - returns index state / progress in the tool details so callers can
 *     observe the worker lifecycle.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import {
	type CodeGraphExploreOptions,
	type CodeGraphExploreResult,
	type CodeGraphIndexLocation,
	type CodeGraphRuntime,
	openCodeGraphRuntime,
} from "../codegraph";
import { resolveCodeGraphIndexLocation } from "../codegraph/location";
import { readProgress } from "../codegraph/progress";
import type { CodeGraphProgress } from "../codegraph/runtime-types";
import type { SupervisorProgressView } from "../codegraph/supervisor";
import { probeSlot, scheduleIndex } from "../codegraph/supervisor";
import { selectPrompt } from "../prompts/prompt-locale";
import codegraphDescription from "../prompts/tools/codegraph.md" with { type: "text" };
import codegraphDescriptionZh from "../prompts/tools/codegraph.zh-CN.md" with { type: "text" };
import { drainPendingFileMutations, type FileMutationCollectorHost } from "./file-mutation-hook";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { PREVIEW_LIMITS, replaceTabs, shortenPath, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

/**
 * Structural subset of `ToolSession` consumed by this tool. The full type
 * lives in `./index.ts`; importing it directly would close a circular
 * module edge (`./index.ts` re-exports `./codegraph`). Real sessions satisfy
 * this duck-typed contract.
 */
export interface CodeGraphToolSession extends FileMutationCollectorHost {
	cwd: string;
}

const codegraphSchema = type({
	query: type("string").describe("Natural-language question or topic for the semantic explorer."),
	"path?": type("string").describe(
		"Optional file or directory to resolve location from and scope sync to. Must stay inside the active source root.",
	),
	"maxFiles?": type("number > 0").describe("Cap on entry-point file count returned by explore."),
});

export type CodeGraphToolInput = typeof codegraphSchema.infer;

export interface CodeGraphToolDetails {
	query: string;
	sourceRoot?: string;
	indexDir?: string;
	maxFiles: number;
	pathScope?: string;
	scopeApplied: boolean;
	nativeAvailable?: boolean;
	fileCount: number;
	entryCount: number;
	confidence?: "high" | "low";
	truncated: boolean;
	files: CodeGraphExploreResult["files"];
	entries: CodeGraphExploreResult["entries"];
	fallback?: string;
	meta?: OutputMeta;
	indexState?: CodeGraphProgress["state"];
	progress?: CodeGraphProgress;
}

const DEFAULT_MAX_FILES = 25;
const ABSOLUTE_MAX_FILES = 200;
const PREVIEW_ENTRY_LINE_LEN = 80;
const PREVIEW_ENTRY_LINES = 3;
const PREVIEW_FILE_LINES = 4;

type FallbackContext = {
	sourceRoot: string;
	indexDir?: string;
	reason: string;
	isError?: boolean;
	indexState?: CodeGraphProgress["state"];
	progress?: CodeGraphProgress;
};

type ResolvedLocationState =
	| { kind: "ready"; location: CodeGraphIndexLocation; runtimeSourceRoot: string; syncPaths: string[] }
	| { kind: "fallback"; fallback: FallbackContext };

async function realpathOrUndefined(target: string): Promise<string | undefined> {
	try {
		return await fs.realpath(target);
	} catch {
		return undefined;
	}
}

async function isInsideSourceRoot(absolutePath: string, sourceRoot: string): Promise<boolean> {
	const resolvedTarget = await realpathOrUndefined(absolutePath);
	if (!resolvedTarget) return false;
	const resolvedRoot = await realpathOrUndefined(sourceRoot);
	const compareRoot = resolvedRoot ?? path.resolve(sourceRoot);
	const rel = path.relative(compareRoot, resolvedTarget);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	return !path.isAbsolute(rel);
}

export class CodeGraphTool implements AgentTool<typeof codegraphSchema, CodeGraphToolDetails> {
	readonly name = "codegraph";
	readonly approval = "read" as const;
	readonly label = "CodeGraph";
	readonly summary = "Semantic code exploration over the CodeGraph runtime facade";
	readonly description: string;
	readonly parameters = codegraphSchema;
	readonly loadMode = "essential" as const;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof codegraphSchema.infer>[] = [
		{
			caption: "Trace a cross-file call chain",
			call: { query: "Where is `ToolSession.onFileMutation` consumed?" },
		},
		{
			caption: "Resolve location from a nested target and sync only that file",
			call: { query: "Where is greet defined?", path: "packages/coding-agent/src/tools/codegraph.ts" },
		},
		{
			caption: "Cap breadth for a focused answer",
			call: { query: "Functions exporting a default in the renderer layer", maxFiles: 10 },
		},
	];

	/**
	 * Cold probe — only awaits the cheap location/Git detection. We do NOT
	 * open the runtime or trigger a sync here. The supervisor takes over as
	 * soon as the tool runs `execute`.
	 */
	static async createIf(session: CodeGraphToolSession): Promise<CodeGraphTool | null> {
		try {
			const location = await resolveCodeGraphIndexLocation(path.resolve(session.cwd));
			if (location.available) return new CodeGraphTool(session, location);
			logger.debug("CodeGraph tool unavailable for workspace", { cwd: session.cwd, reason: location.reason });
		} catch (error) {
			logger.debug("CodeGraph tool availability check failed", {
				cwd: session.cwd,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return null;
	}

	readonly #scheduledKeys = new Set<string>();

	constructor(
		private readonly session: CodeGraphToolSession,
		initialLocation?: CodeGraphIndexLocation,
	) {
		this.description = prompt.render(selectPrompt(codegraphDescription, codegraphDescriptionZh));
		if (initialLocation) this.#scheduleIndex(initialLocation);
	}

	#scheduleIndex(location: CodeGraphIndexLocation, forceRebuild = false): void {
		const key = location.identity.key;
		if (this.#scheduledKeys.has(key) && !forceRebuild) return;
		this.#scheduledKeys.add(key);
		try {
			scheduleIndex(location, forceRebuild ? { forceRebuild: true } : {});
		} catch (error) {
			this.#scheduledKeys.delete(key);
			logger.debug("CodeGraph worker schedule failed", {
				key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async execute(
		_toolCallId: string,
		params: typeof codegraphSchema.infer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CodeGraphToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CodeGraphToolDetails>> {
		return untilAborted(signal, async () => {
			const query = params.query.trim();
			if (query.length === 0) {
				throw new ToolError("`query` is required.");
			}

			const maxFiles = Math.min(ABSOLUTE_MAX_FILES, Math.max(1, params.maxFiles ?? DEFAULT_MAX_FILES));
			const sessionCwd = path.resolve(this.session.cwd);
			const resolved = await this.#resolveLocationAndScope(sessionCwd, params.path);
			if (resolved.kind === "fallback") {
				return this.#fallbackResult(params, maxFiles, resolved.fallback);
			}

			const { location, runtimeSourceRoot, syncPaths } = resolved;

			// Build the explicit + mutation-derived scoped path list up
			// front so the indexing-fallback path can echo it back.
			const effectiveSyncPaths = new Set<string>(syncPaths);
			for (const event of drainPendingFileMutations(this.session)) {
				for (const absolutePath of [event.previousPath, event.path]) {
					if (!absolutePath) continue;
					const relative = path.relative(runtimeSourceRoot, absolutePath);
					if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
					effectiveSyncPaths.add(relative.split(path.sep).join("/"));
				}
			}
			const paths = [...effectiveSyncPaths];

			// Cold path: ensure the supervisor has at least spawned the
			// worker, then check `progress.json`. If the slot is not
			// `ready` we return the indexing fallback immediately rather
			// than blocking on warm initialization.
			this.#scheduleIndex(location);
			let supervisor = await probeSlot(location);
			if (!supervisor.active && supervisor.progress.state === "failed") {
				this.#scheduledKeys.delete(location.identity.key);
				this.#scheduleIndex(location, true);
				supervisor = await probeSlot(location);
			}
			if (supervisor.active || supervisor.progress.state !== "ready") {
				const persisted = await this.#readProgressFor(location);
				const progress = supervisor.active && persisted?.state === "ready" ? undefined : persisted;
				return this.#indexingFallback(params, maxFiles, location, supervisor.progress, progress);
			}

			let runtime: CodeGraphRuntime | null = null;
			try {
				runtime = await openCodeGraphRuntime({ sourceRoot: runtimeSourceRoot, location });
				// Worker already performed the warm full sync. Only honour
				// explicit scoped paths (the user-supplied `path` argument
				// + drainPendingFileMutations). No scoped paths → just
				// explore against the worker's warm state.
				if (paths.length > 0) {
					await runtime.sync({ paths });
				}
				const exploreOpts: CodeGraphExploreOptions = { maxFiles };
				const exploreResult = await runtime.explore(query, exploreOpts);
				return this.#shapeResult(params, maxFiles, runtimeSourceRoot, location, paths, exploreResult, {
					state: "ready",
					phase: "ready",
					current: 0,
					total: 0,
					updatedAt: new Date().toISOString(),
					workerId: supervisor.progress.workerId,
					attempt: supervisor.progress.attempt,
				});
			} catch (err) {
				const message = (err as Error).message || String(err);
				return this.#fallbackResult(params, maxFiles, {
					sourceRoot: runtimeSourceRoot,
					indexDir: location.indexDir,
					reason: `CodeGraph runtime error — ${message}. Fallback: use \`grep\`/\`glob\`/\`read\`.`,
				});
			} finally {
				try {
					runtime?.close();
				} catch {
					/* runtime already torn down */
				}
			}
		});
	}

	async #readProgressFor(location: CodeGraphIndexLocation): Promise<CodeGraphProgress | undefined> {
		try {
			return (await readProgress(location)) ?? undefined;
		} catch {
			return undefined;
		}
	}

	async #resolveLocationAndScope(sessionCwd: string, rawPath: string | undefined): Promise<ResolvedLocationState> {
		let syncTargetRealpath: string | undefined;

		if (rawPath && rawPath.length > 0) {
			const absolute = resolveToCwd(rawPath, sessionCwd);
			const realpath = await realpathOrUndefined(absolute);
			if (!realpath) {
				return {
					kind: "fallback",
					fallback: {
						sourceRoot: sessionCwd,
						reason: `Path does not exist on disk: ${rawPath}`,
						isError: true,
					},
				};
			}
			const stat = await fs.stat(realpath).catch(() => undefined);
			if (!stat) {
				return {
					kind: "fallback",
					fallback: {
						sourceRoot: sessionCwd,
						reason: `Path does not exist on disk: ${rawPath}`,
						isError: true,
					},
				};
			}
			syncTargetRealpath = realpath;
		}

		let location: CodeGraphIndexLocation;
		try {
			location = await resolveCodeGraphIndexLocation(sessionCwd);
		} catch (err) {
			const message = (err as Error).message || String(err);
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: sessionCwd,
					reason: `CodeGraph location resolution failed: ${message}`,
				},
			};
		}
		if (!location.available) {
			const reason = location.reason ?? "location unavailable";
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: sessionCwd,
					indexDir: location.indexDir,
					reason: `CodeGraph unavailable — ${reason}. Fallback: use \`grep\`/\`glob\`/\`read\`.`,
				},
			};
		}

		const runtimeSourceRoot = location.identity.sourceRoot || sessionCwd;
		if (!syncTargetRealpath) {
			return { kind: "ready", location, runtimeSourceRoot, syncPaths: [] };
		}
		if (!(await isInsideSourceRoot(syncTargetRealpath, runtimeSourceRoot))) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: runtimeSourceRoot,
					indexDir: location.indexDir,
					reason: `Path is outside the active source root: ${rawPath}`,
					isError: true,
				},
			};
		}
		const relative = path.relative(runtimeSourceRoot, syncTargetRealpath) || ".";
		return {
			kind: "ready",
			location,
			runtimeSourceRoot,
			syncPaths: [relative.replaceAll(path.win32.sep, path.posix.sep)],
		};
	}

	#shapeResult(
		params: typeof codegraphSchema.infer,
		_maxFiles: number,
		sourceRoot: string,
		location: CodeGraphIndexLocation,
		syncPaths: string[],
		explore: CodeGraphExploreResult,
		progress: CodeGraphProgress,
	): AgentToolResult<CodeGraphToolDetails> {
		const truncated = explore.files.length + explore.entries.length > PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const details: CodeGraphToolDetails = {
			query: explore.query,
			sourceRoot,
			indexDir: location.indexDir,
			maxFiles: explore.maxFiles,
			pathScope: syncPaths[0],
			scopeApplied: syncPaths.length > 0,
			fileCount: explore.files.length,
			entryCount: explore.entries.length,
			confidence: explore.confidence,
			truncated,
			files: explore.files,
			entries: explore.entries,
			indexState: progress.state,
			progress,
		};
		return toolResult<CodeGraphToolDetails>(details)
			.text(formatCodeGraphText(explore, params, syncPaths))
			.done();
	}

	#indexingFallback(
		params: typeof codegraphSchema.infer,
		maxFiles: number,
		location: CodeGraphIndexLocation,
		view: SupervisorProgressView,
		persisted: CodeGraphProgress | undefined,
	): AgentToolResult<CodeGraphToolDetails> {
		const progress = persisted ?? {
			state: view.state === "ready" ? "ready" : view.state === "failed" ? "failed" : "indexing",
			phase: view.phase,
			current: view.current,
			total: view.total,
			updatedAt: new Date().toISOString(),
			workerId: view.workerId,
			attempt: view.attempt,
		};
		const stateLabel = progress.state;
		const reason =
			progress.state === "failed"
				? `CodeGraph indexing failed: ${progress.error ?? progress.phase}. Fallback: use \`grep\`/\`glob\`/\`read\`.`
				: `CodeGraph is ${stateLabel} (${progress.phase}, ${progress.current}/${progress.total}); the worker is still preparing the index. Fallback: use \`grep\`/\`glob\`/\`read\`.`;
		const details: CodeGraphToolDetails = {
			query: params.query,
			sourceRoot: location.identity.sourceRoot || location.identity.worktreeRoot,
			indexDir: location.indexDir,
			maxFiles,
			pathScope: params.path,
			scopeApplied: false,
			fileCount: 0,
			entryCount: 0,
			truncated: false,
			files: [],
			entries: [],
			fallback: reason,
			indexState: progress.state,
			progress,
		};
		return toolResult<CodeGraphToolDetails>(details).text(`CodeGraph fallback: ${reason}`).done();
	}

	#fallbackResult(
		params: typeof codegraphSchema.infer,
		maxFiles: number,
		opts: FallbackContext,
	): AgentToolResult<CodeGraphToolDetails> {
		const details: CodeGraphToolDetails = {
			query: params.query,
			sourceRoot: opts.sourceRoot,
			indexDir: opts.indexDir,
			maxFiles,
			pathScope: params.path,
			scopeApplied: false,
			fileCount: 0,
			entryCount: 0,
			truncated: false,
			files: [],
			entries: [],
			fallback: opts.reason,
			...(opts.indexState ? { indexState: opts.indexState } : {}),
			...(opts.progress ? { progress: opts.progress } : {}),
		};
		const result = toolResult<CodeGraphToolDetails>(details).text(`CodeGraph fallback: ${opts.reason}`);
		return opts.isError ? result.error().done() : result.done();
	}
}

function formatCodeGraphText(
	result: CodeGraphExploreResult,
	params: typeof codegraphSchema.infer,
	syncPaths: string[],
): string {
	const lines: string[] = [];
	lines.push("CodeGraph exploration");
	lines.push(`Query: ${truncateToWidth(replaceTabs(params.query), 200)}`);
	if (syncPaths.length > 0) {
		lines.push(`Sync scope: ${truncateToWidth(replaceTabs(syncPaths[0] ?? ""), 200)}`);
	}
	lines.push(`Max files: ${result.maxFiles}`);
	const confidence = result.confidence ?? (result.entries.length > 0 ? "high" : "low");
	lines.push(`Confidence: ${confidence}`);
	lines.push(`Files: ${result.files.length} · Entries: ${result.entries.length}`);
	if (result.entries.length === 0 && result.files.length === 0) {
		lines.push("No semantic matches found.");
		return lines.join("\n");
	}

	if (result.entries.length > 0) {
		lines.push("");
		lines.push("Entries:");
		const entryLimit = Math.min(result.entries.length, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		for (const entry of result.entries.slice(0, entryLimit)) {
			const node = entry.node;
			const pathLabel = shortenPath(node.filePath);
			const header = `• ${node.qualifiedName || node.name} [${node.kind}] — ${pathLabel}:${node.startLine}`;
			lines.push(truncateToWidth(replaceTabs(header), 240));
			const previewLines = entry.lines
				.slice(node.startLine - 1, node.startLine - 1 + PREVIEW_ENTRY_LINES)
				.filter((line): line is string => typeof line === "string")
				.map(line => truncateToWidth(replaceTabs(line), PREVIEW_ENTRY_LINE_LEN));
			for (const preview of previewLines) lines.push(`    ${preview}`);
		}
		if (result.entries.length > entryLimit) {
			lines.push(
				`…${result.entries.length - entryLimit} more entries; refine \`query\` or lower \`maxFiles\` to narrow.`,
			);
		}
	}

	if (result.files.length > 0) {
		lines.push("");
		lines.push("File coverage:");
		const fileLimit = Math.min(result.files.length, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		for (const file of result.files.slice(0, fileLimit)) {
			const pathLabel = shortenPath(file.filePath);
			lines.push(truncateToWidth(replaceTabs(`• ${pathLabel} (${file.language}, ${file.nodeCount} nodes)`), 240));
			if (file.lines) {
				for (const line of file.lines.slice(0, PREVIEW_FILE_LINES)) {
					lines.push(`    ${truncateToWidth(replaceTabs(line), PREVIEW_ENTRY_LINE_LEN)}`);
				}
			}
		}
		if (result.files.length > fileLimit) {
			lines.push(`…${result.files.length - fileLimit} more files.`);
		}
	}

	return lines.join("\n");
}
