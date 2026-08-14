/** FFF-backed `omp grep` command handler. */
import * as path from "node:path";
import type { GrepMatch, GrepResult } from "@ff-labs/fff-bun";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { tSettingsUi } from "../i18n/settings-locale";
import { createFffFinderManager, type FffFinderManager, resolveFffScope } from "../tools/fff-manager";
import { normalizeFffPathConstraint } from "../tools/fff-query";
import { expandPath } from "../tools/path-utils";

export const GREP_OUTPUT_MODES = {
	Content: "content",
	FilesWithMatches: "files",
	Count: "count",
} as const;

export type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[keyof typeof GREP_OUTPUT_MODES];

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
}

export interface GrepCommandRuntime {
	cwd?: string;
	agentDir?: string;
	manager?: FffFinderManager;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 1) {
		throw new Error(tSettingsUi("{name} must be a positive integer", { name }));
	}
	return Math.floor(value);
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(tSettingsUi("{name} must be a non-negative integer", { name }));
	}
	return Math.floor(value);
}

function buildCliQuery(
	root: string,
	pathConstraint: string | undefined,
	glob: string | undefined,
	pattern: string,
): string {
	const constraints: string[] = [];
	for (const value of [pathConstraint, glob]) {
		if (!value) continue;
		const normalized = normalizeFffPathConstraint(value, root);
		if (normalized) constraints.push(normalized);
	}
	return [...constraints, pattern].join(" ");
}

function absoluteDisplayPath(root: string, match: GrepMatch): string {
	return path.resolve(root, match.relativePath).replaceAll("\\", "/");
}

function printContentMatches(root: string, matches: readonly GrepMatch[]): void {
	for (const match of matches) {
		const displayPath = absoluteDisplayPath(root, match);
		match.contextBefore?.forEach((line, index) => {
			const lineNumber = match.lineNumber - match.contextBefore!.length + index;
			console.log(chalk.dim(`${displayPath}-${lineNumber}- ${line}`));
		});
		console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.lineContent}`);
		match.contextAfter?.forEach((line, index) => {
			console.log(chalk.dim(`${displayPath}-${match.lineNumber + index + 1}- ${line}`));
		});
		console.log("");
	}
}

function printFileMatches(root: string, matches: readonly GrepMatch[]): void {
	const seen = new Set<string>();
	for (const match of matches) {
		const displayPath = absoluteDisplayPath(root, match);
		if (seen.has(displayPath)) continue;
		seen.add(displayPath);
		console.log(chalk.cyan(displayPath));
	}
}

function printMatchCounts(root: string, matches: readonly GrepMatch[]): void {
	const counts = new Map<string, number>();
	for (const match of matches) {
		const displayPath = absoluteDisplayPath(root, match);
		counts.set(displayPath, (counts.get(displayPath) ?? 0) + 1);
	}
	for (const [displayPath, count] of counts) {
		console.log(tSettingsUi("{path}: {count} matches", { path: chalk.cyan(displayPath), count }));
	}
}

function printSummary(result: GrepResult): void {
	const files = new Set(result.items.map(match => match.relativePath));
	console.log(chalk.green(tSettingsUi("Total matches: {count}", { count: result.items.length })));
	console.log(chalk.green(tSettingsUi("Files with matches: {count}", { count: files.size })));
	console.log(chalk.green(tSettingsUi("Files searched: {count}", { count: result.totalFilesSearched })));
	if (result.nextCursor) console.log(chalk.yellow(tSettingsUi("Limit reached: true")));
	if (result.regexFallbackError) {
		console.log(
			chalk.yellow(
				tSettingsUi("Invalid regex: {error}; used literal matching", { error: result.regexFallbackError }),
			),
		);
	}
	console.log("");
}

export async function runGrepCommand(cmd: GrepCommandArgs, runtime: GrepCommandRuntime = {}): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red(tSettingsUi("Error: {message}", { message: tSettingsUi("Pattern is required") })));
		process.exitCode = 1;
		return;
	}

	const cwd = path.resolve(runtime.cwd ?? process.cwd());
	const searchPath = path.resolve(cwd, expandPath(cmd.path));
	const limit = positiveInteger(cmd.limit, "limit");
	const context = nonNegativeInteger(cmd.context, "context");
	const manager = runtime.manager ?? createFffFinderManager(runtime.agentDir ?? getAgentDir(), cwd);
	const ownsManager = runtime.manager === undefined;

	console.log(chalk.dim(tSettingsUi("Searching in: {path}", { path: searchPath })));
	console.log(chalk.dim(tSettingsUi("Pattern: {pattern}", { pattern: cmd.pattern })));
	console.log(
		chalk.dim(
			tSettingsUi("Mode: {mode}, Limit: {limit}, Context: {context}, Engine: FFF", {
				mode: cmd.mode,
				limit,
				context,
			}),
		),
	);
	console.log("");

	try {
		const scope = await resolveFffScope(manager, cwd, searchPath);
		const query = buildCliQuery(scope.root, scope.pathConstraint, cmd.glob, cmd.pattern);
		const searched = scope.finder.grep(query, {
			mode: "regex",
			smartCase: true,
			maxMatchesPerFile: cmd.mode === GREP_OUTPUT_MODES.FilesWithMatches ? 1 : limit,
			pageSize: limit,
			beforeContext: cmd.mode === GREP_OUTPUT_MODES.Content ? context : 0,
			afterContext: cmd.mode === GREP_OUTPUT_MODES.Content ? context : 0,
		});
		if (!searched.ok) throw new Error(searched.error);

		printSummary(searched.value);
		switch (cmd.mode) {
			case GREP_OUTPUT_MODES.Content:
				printContentMatches(scope.root, searched.value.items);
				break;
			case GREP_OUTPUT_MODES.Count:
				printMatchCounts(scope.root, searched.value.items);
				break;
			case GREP_OUTPUT_MODES.FilesWithMatches:
				printFileMatches(scope.root, searched.value.items);
				break;
		}
	} catch (err) {
		console.error(
			chalk.red(tSettingsUi("Error: {message}", { message: err instanceof Error ? err.message : String(err) })),
		);
		process.exitCode = 1;
	} finally {
		if (ownsManager) manager.dispose();
	}
}
