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
import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import {
	type CodeGraphExploreMode,
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
import { formatHashlineSourceSection } from "../edit/file-snapshot-store";
import { selectPrompt } from "../prompts/prompt-locale";
import codegraphDescription from "../prompts/tools/codegraph.md" with { type: "text" };
import codegraphDescriptionZh from "../prompts/tools/codegraph.zh-CN.md" with { type: "text" };
import {
	type CodeGraphCoverageLedgerOwner,
	type CodeGraphCoverageLedgerSnapshot,
	getCodeGraphCoverageLedger,
	invalidateCodeGraphCoverage,
} from "./codegraph-coverage-ledger";
import { drainPendingFileMutations, type FileMutationCollectorHost } from "./file-mutation-hook";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { replaceTabs, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

/**
 * Structural subset of `ToolSession` consumed by this tool. The full type
 * lives in `./index.ts`; importing it directly would close a circular
 * module edge (`./index.ts` re-exports `./codegraph`). Real sessions satisfy
 * this duck-typed contract.
 */
export interface CodeGraphToolSession extends FileMutationCollectorHost, CodeGraphCoverageLedgerOwner {
	cwd: string;
	fileSnapshotStore?: InMemorySnapshotStore;
}

const codegraphSchema = type({
	query: type("string").describe("Natural-language question or topic for the semantic explorer."),
	"mode?": type("'auto' | 'locate' | 'understand' | 'flow' | 'impact' | 'edit'").describe(
		"Explore intent; auto infers from query.",
	),
	"projectPath?": type("string").describe("Project path whose Git-root CodeGraph index should be queried."),
	"path?": type("string").describe("Optional file or directory inside the selected project; limits scoped sync."),
	"maxFiles?": type("number > 0").describe("Cap on entry-point file count returned by explore."),
});

export type CodeGraphToolInput = typeof codegraphSchema.infer;

export interface CodeGraphToolDetails {
	query: string;
	mode?: CodeGraphExploreMode;
	projectPath?: string;
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
	sourceSections?: CodeGraphExploreResult["sourceSections"];
	edges?: CodeGraphExploreResult["edges"];
	flow?: CodeGraphExploreResult["flow"];
	blastRadius?: CodeGraphExploreResult["blastRadius"];
	testCandidates?: CodeGraphExploreResult["testCandidates"];
	coverage?: CodeGraphExploreResult["coverage"];
	freshness?: CodeGraphExploreResult["freshness"];
	budget?: CodeGraphExploreResult["budget"];
	coverageLedger?: CodeGraphCoverageLedgerSnapshot;
	fallback?: string;
	meta?: OutputMeta;
	indexState?: CodeGraphProgress["state"];
	progress?: CodeGraphProgress;
}

const DEFAULT_MAX_FILES = 8;
const ABSOLUTE_MAX_FILES = 200;
const MODEL_OUTPUT_HARD_CEILING = 25_000;

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

	static async createIf(session: CodeGraphToolSession): Promise<CodeGraphTool> {
		try {
			const location = await resolveCodeGraphIndexLocation(path.resolve(session.cwd));
			if (location.available) return new CodeGraphTool(session, location);
			logger.debug("CodeGraph workspace will use fallback until a projectPath is supplied", {
				cwd: session.cwd,
				reason: location.reason,
			});
		} catch (error) {
			logger.debug("CodeGraph tool availability check failed", {
				cwd: session.cwd,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return new CodeGraphTool(session);
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
			if (query.length === 0) throw new ToolError("`query` is required.");

			const maxFiles = Math.min(ABSOLUTE_MAX_FILES, Math.max(1, params.maxFiles ?? DEFAULT_MAX_FILES));
			const sessionCwd = path.resolve(this.session.cwd);
			const resolved = await this.#resolveLocationAndScope(sessionCwd, params.projectPath, params.path);
			if (resolved.kind === "fallback") return this.#fallbackResult(params, maxFiles, resolved.fallback);

			const { location, runtimeSourceRoot, syncPaths } = resolved;
			const effectiveSyncPaths = new Set<string>(syncPaths);
			for (const event of drainPendingFileMutations(this.session)) {
				invalidateCodeGraphCoverage(this.session, [event.previousPath, event.path]);
				for (const absolutePath of [event.previousPath, event.path]) {
					if (!absolutePath) continue;
					const relative = path.relative(runtimeSourceRoot, absolutePath);
					if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
					effectiveSyncPaths.add(relative.split(path.sep).join("/"));
				}
			}
			const paths = [...effectiveSyncPaths];

			this.#scheduleIndex(location);
			const supervisor = await probeSlot(location);
			if (supervisor.active || supervisor.progress.state !== "ready") {
				const persisted = await this.#readProgressFor(location);
				const progress = supervisor.active && persisted?.state === "ready" ? undefined : persisted;
				return this.#indexingFallback(params, maxFiles, location, supervisor.progress, progress);
			}

			let runtime: CodeGraphRuntime | null = null;
			try {
				runtime = await openCodeGraphRuntime({ sourceRoot: runtimeSourceRoot, location });
				let pendingSyncFailed = false;
				const syncTargets = new Set(paths);
				try {
					const freshness = await runtime.inspectFreshness();
					for (const stalePath of freshness.stalePaths) syncTargets.add(stalePath);
				} catch (error) {
					logger.debug("CodeGraph freshness inspection failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				if (syncTargets.size > 0) {
					try {
						await runtime.sync({ paths: [...syncTargets] });
					} catch (error) {
						pendingSyncFailed = true;
						logger.debug("CodeGraph scoped mutation sync failed", {
							paths: [...syncTargets],
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				const exploreOpts: CodeGraphExploreOptions = { maxFiles, mode: params.mode };
				let exploreResult = await runtime.explore(query, exploreOpts);
				if (exploreResult.freshness.stalePaths.length > 0) {
					try {
						await runtime.sync({ paths: exploreResult.freshness.stalePaths });
						exploreResult = await runtime.explore(query, exploreOpts);
					} catch (error) {
						logger.debug("CodeGraph candidate freshness sync failed", {
							paths: exploreResult.freshness.stalePaths,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				if (pendingSyncFailed) {
					exploreResult.freshness.state = "partial-stale";
					exploreResult.freshness.stalePaths = [
						...new Set([...exploreResult.freshness.stalePaths, ...syncTargets]),
					];
					exploreResult.freshness.sync = { state: "required", paths: exploreResult.freshness.stalePaths };
				}
				return await this.#shapeResult(params, runtimeSourceRoot, location, paths, exploreResult, {
					state: "ready",
					phase: "ready",
					current: 0,
					total: 0,
					updatedAt: new Date().toISOString(),
					workerId: supervisor.progress.workerId,
					attempt: supervisor.progress.attempt,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return this.#fallbackResult(params, maxFiles, {
					sourceRoot: runtimeSourceRoot,
					indexDir: location.indexDir,
					reason: this.#standardFallback(`CodeGraph runtime error — ${message}`),
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

	#standardFallback(reason: string): string {
		return `${reason}. Fallback: use \`grep\`/\`glob\`/\`read\`. Use \`lsp\` for symbol intelligence. Do not wait for or retry CodeGraph for this project in this task.`;
	}

	async #resolveLocationAndScope(
		sessionCwd: string,
		rawProjectPath: string | undefined,
		rawPath: string | undefined,
	): Promise<ResolvedLocationState> {
		const requestedProjectPath =
			rawProjectPath && rawProjectPath.length > 0 ? resolveToCwd(rawProjectPath, sessionCwd) : sessionCwd;
		const projectRealpath = await realpathOrUndefined(requestedProjectPath);
		if (!projectRealpath) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: sessionCwd,
					reason: `Project path does not exist on disk: ${rawProjectPath ?? sessionCwd}`,
					isError: rawProjectPath !== undefined,
				},
			};
		}
		const projectStat = await fs.stat(projectRealpath).catch(() => undefined);
		if (!projectStat) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: sessionCwd,
					reason: `Project path is not readable: ${rawProjectPath ?? sessionCwd}`,
					isError: rawProjectPath !== undefined,
				},
			};
		}
		const projectBase = projectStat.isDirectory() ? projectRealpath : path.dirname(projectRealpath);
		let location: CodeGraphIndexLocation;
		try {
			location = await resolveCodeGraphIndexLocation(projectBase);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: projectBase,
					reason: this.#standardFallback(`CodeGraph location resolution failed — ${message}`),
				},
			};
		}
		if (!location.available) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: projectBase,
					indexDir: location.indexDir,
					reason: this.#standardFallback(`CodeGraph unavailable — ${location.reason ?? "location unavailable"}`),
				},
			};
		}

		const runtimeSourceRoot = location.identity.sourceRoot || projectBase;
		if (!rawPath || rawPath.length === 0) return { kind: "ready", location, runtimeSourceRoot, syncPaths: [] };
		const requestedScope = resolveToCwd(rawPath, runtimeSourceRoot);
		const scopeRealpath = await realpathOrUndefined(requestedScope);
		if (!scopeRealpath) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: runtimeSourceRoot,
					indexDir: location.indexDir,
					reason: `Path does not exist on disk: ${rawPath}`,
					isError: true,
				},
			};
		}
		if (!(await isInsideSourceRoot(scopeRealpath, runtimeSourceRoot))) {
			return {
				kind: "fallback",
				fallback: {
					sourceRoot: runtimeSourceRoot,
					indexDir: location.indexDir,
					reason: `Path is outside the active source root selected by projectPath: ${rawPath}`,
					isError: true,
				},
			};
		}
		const relative = path.relative(runtimeSourceRoot, scopeRealpath) || ".";
		return {
			kind: "ready",
			location,
			runtimeSourceRoot,
			syncPaths: [relative.split(path.sep).join("/")],
		};
	}

	async #shapeResult(
		params: typeof codegraphSchema.infer,
		sourceRoot: string,
		location: CodeGraphIndexLocation,
		syncPaths: string[],
		explore: CodeGraphExploreResult,
		progress: CodeGraphProgress,
	): Promise<AgentToolResult<CodeGraphToolDetails>> {
		const formatted = await formatCodeGraphText(this.session, sourceRoot, explore, params, syncPaths);
		const ledger = getCodeGraphCoverageLedger(this.session);
		ledger.beginTurn();
		const included = new Set(formatted.includedSectionIds);
		ledger.record(
			explore.sourceSections
				.filter(section => included.has(section.id))
				.map(section => ({
					absolutePath: path.resolve(sourceRoot, section.filePath),
					displayPath: section.filePath,
					completeness: explore.freshness.stalePaths.includes(section.filePath) ? "partial" : section.completeness,
					symbol: section.symbol?.qualifiedName || section.symbol?.name,
					startLine: section.startLine,
					endLine: section.endLine,
				})),
		);
		const details: CodeGraphToolDetails = {
			query: explore.query,
			mode: explore.mode,
			projectPath: params.projectPath,
			sourceRoot,
			indexDir: location.indexDir,
			maxFiles: explore.maxFiles,
			pathScope: syncPaths[0],
			scopeApplied: syncPaths.length > 0,
			fileCount: explore.files.length,
			entryCount: explore.entries.length,
			confidence: explore.confidence,
			truncated: explore.budget.exhausted || formatted.omittedSections > 0,
			files: explore.files,
			entries: explore.entries,
			sourceSections: explore.sourceSections,
			edges: explore.edges,
			flow: explore.flow,
			blastRadius: explore.blastRadius,
			testCandidates: explore.testCandidates,
			coverage: explore.coverage,
			freshness: explore.freshness,
			budget: explore.budget,
			coverageLedger: ledger.snapshot(),
			indexState: progress.state,
			progress,
		};
		return toolResult<CodeGraphToolDetails>(details).text(formatted.text).done();
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
		const reason = this.#standardFallback(
			progress.state === "failed"
				? `CodeGraph indexing failed — ${progress.error ?? progress.phase}`
				: `CodeGraph is ${stateLabel} (${progress.phase}, ${progress.current}/${progress.total}); the worker is still preparing the index`,
		);
		const details: CodeGraphToolDetails = {
			query: params.query,
			sourceRoot: location.identity.sourceRoot || location.identity.worktreeRoot,
			mode: params.mode,
			projectPath: params.projectPath,
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
			mode: params.mode,
			projectPath: params.projectPath,
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

interface FormattedCodeGraphText {
	text: string;
	includedSectionIds: string[];
	omittedSections: number;
}

async function formatCodeGraphText(
	session: CodeGraphToolSession,
	sourceRoot: string,
	result: CodeGraphExploreResult,
	params: typeof codegraphSchema.infer,
	syncPaths: string[],
): Promise<FormattedCodeGraphText> {
	const lines: string[] = [
		"CodeGraph exploration",
		`Query: ${truncateToWidth(replaceTabs(params.query), 200)}`,
		`Mode: ${result.mode} · Confidence: ${result.confidence ?? "low"}`,
		`Coverage: ${result.coverage.complete.length} complete · ${result.coverage.partial.length} partial · ${result.coverage.omitted.length} omitted`,
		`Budget: ${result.budget.charactersUsed}/${result.budget.maxCharacters} source chars · ${result.budget.filesUsed}/${result.budget.effectiveMaxFiles} files`,
	];
	if (syncPaths.length > 0) lines.push(`Sync scope: ${syncPaths.map(value => replaceTabs(value)).join(", ")}`);
	if (result.freshness.state === "partial-stale") {
		lines.push(`Freshness: partial-stale — ${result.freshness.stalePaths.slice(0, 10).join(", ")}`);
		lines.push("Current-disk source below is authoritative; relationships involving those paths may be stale.");
	} else {
		lines.push("Freshness: fresh");
	}
	if (result.entries.length === 0) {
		lines.push("No semantic matches found.");
		return { text: lines.join("\n"), includedSectionIds: [], omittedSections: 0 };
	}

	const names = new Map<string, string>();
	for (const entry of result.entries) names.set(entry.node.id, entry.node.qualifiedName || entry.node.name);
	for (const relevant of result.relevance)
		names.set(relevant.node.id, relevant.node.qualifiedName || relevant.node.name);
	for (const impact of result.blastRadius?.entries ?? [])
		names.set(impact.node.id, impact.node.qualifiedName || impact.node.name);
	for (const test of result.testCandidates) names.set(test.id, test.qualifiedName || test.name);
	const displayName = (id: string): string => names.get(id) ?? id;

	if ((result.mode === "flow" || result.mode === "understand" || result.mode === "edit") && result.flow.length > 0) {
		lines.push("", "Flow:");
		for (const chain of result.flow.slice(0, 5)) {
			const pathText = chain.hops
				.map(hop => `${displayName(hop.from)} -[${hop.edgeKind}]-> ${displayName(hop.to)}`)
				.join(" · ");
			lines.push(`- ${pathText}`);
		}
	}
	if ((result.mode === "understand" || result.mode === "edit") && result.edges.length > 0) {
		lines.push("", "Relationships:");
		for (const edge of result.edges.slice(0, 12)) {
			lines.push(`- ${displayName(edge.source)} -[${edge.kind}]-> ${displayName(edge.target)}`);
		}
		if (result.edges.length > 12) lines.push(`- +${result.edges.length - 12} more relationships`);
	}
	if ((result.mode === "impact" || result.mode === "edit") && result.blastRadius) {
		lines.push("", `Impact from ${result.blastRadius.focal.qualifiedName || result.blastRadius.focal.name}:`);
		for (const impact of result.blastRadius.entries.slice(0, 20)) {
			lines.push(`- depth ${impact.depth}: ${impact.node.qualifiedName || impact.node.name} via ${impact.via.kind}`);
		}
		if (result.blastRadius.entries.length > 20)
			lines.push(`- +${result.blastRadius.entries.length - 20} more dependents`);
	}
	if ((result.mode === "impact" || result.mode === "edit") && result.testCandidates.length > 0) {
		lines.push("", "Test candidates:");
		for (const test of result.testCandidates.slice(0, 10))
			lines.push(`- ${test.filePath}:${test.startLine} · ${test.qualifiedName || test.name}`);
		if (result.testCandidates.length > 10) lines.push(`- +${result.testCandidates.length - 10} more tests`);
	}

	lines.push("", "Source sections:");
	const includedSectionIds: string[] = [];
	const fullTextByPath = new Map<string, string | undefined>();
	let omittedSections = 0;
	for (const section of result.sourceSections) {
		const absolutePath = path.resolve(sourceRoot, section.filePath);
		let fullText = fullTextByPath.get(section.filePath);
		if (!fullTextByPath.has(section.filePath)) {
			try {
				fullText = await Bun.file(absolutePath).text();
			} catch {
				fullText = undefined;
			}
			fullTextByPath.set(section.filePath, fullText);
		}
		if (fullText === undefined) {
			omittedSections++;
			continue;
		}
		const formatted = formatHashlineSourceSection(session, {
			absolutePath,
			anchor: section.filePath,
			fullText,
			startLine: section.startLine,
			endLine: section.endLine,
			lineNumbers: section.lineNumbers,
		});
		const label = section.symbol?.qualifiedName || section.symbol?.name || section.role;
		const sectionText = [
			`## ${replaceTabs(section.filePath)} · ${replaceTabs(label)} [${section.role}/${section.completeness}]`,
			formatted.text,
		].join("\n");
		const candidate = [...lines, sectionText].join("\n");
		if (candidate.length > MODEL_OUTPUT_HARD_CEILING) {
			omittedSections++;
			continue;
		}
		lines.push(sectionText);
		includedSectionIds.push(section.id);
	}
	if (omittedSections > 0) {
		const note = `Omitted ${omittedSections} source section(s) at the 25,000-character boundary; query the named missing symbol or use an exact system-tool range.`;
		if ([...lines, note].join("\n").length <= MODEL_OUTPUT_HARD_CEILING) lines.push(note);
	}
	return { text: lines.join("\n"), includedSectionIds, omittedSections };
}
