/**
 * CodeGraph management CLI surface.
 *
 * `omp codegraph <status|clear|prune>` lets the user inspect and clean the
 * external CodeGraph cache rooted at `~/.omp/codegraph/v1/indexes/<key>`.
 *
 * The CLI is a thin argument parser + presenter. Every read, identity check,
 * and filesystem mutation goes through the public Location facade in
 * `../codegraph/location.ts` so the same validated child/identity rules that
 * protect the runtime also protect the management command. Paths shown to
 * the user are formatted via `shortenPath` to match OMP's existing display
 * conventions (e.g. `~/.omp/...`). JSON output preserves the facade's
 * absolute paths verbatim.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";
import {
	type CodeGraphCacheIdentity,
	type CodeGraphIndexLocation,
	type CodeGraphIndexLocationClearResult,
	type CodeGraphIndexPruneEntry,
	type CodeGraphIndexPruneOptions,
	type CodeGraphLocationMetadata,
	clearCodeGraphIndexLocation,
	clearCodeGraphIndexLocationByKey,
	getCodeGraphIndexLocationStatus,
	getCodeGraphStorageRoot,
	pruneCodeGraphIndexes,
	resolveCodeGraphIndexLocation,
} from "../codegraph/location";
import { shortenPath } from "../utils/path-display";

export type CodeGraphStatusOptions = {
	json: boolean;
	cwd?: string;
};

export type CodeGraphClearOptions = {
	json: boolean;
	dryRun: boolean;
	cwd?: string;
	key?: string;
};

export type CodeGraphPruneOptions = {
	json: boolean;
	dryRun: boolean;
	keep?: number;
	olderThanDays?: number;
};

const NON_GIT_REASON_PREFIXES = ["Not inside a Git repository", "Git repository detected"];

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function describeIndexReason(reason: string | undefined): string {
	if (!reason) return chalk.green("available");
	if (NON_GIT_REASON_PREFIXES.some(prefix => reason.startsWith(prefix))) {
		return chalk.yellow(`unavailable: ${reason}`);
	}
	return chalk.yellow(`unavailable: ${reason}`);
}

function displayIdentity(identity: CodeGraphCacheIdentity): string[] {
	const refLine = identity.commit ? `${identity.ref} @ ${identity.commit.slice(0, 12)}` : identity.ref;
	return [
		`  ${chalk.dim("sourceRoot")}  ${shortenPath(identity.sourceRoot)}`,
		`  ${chalk.dim("worktree")}  ${shortenPath(identity.worktreeRoot)}`,
		identity.commonDir ? `  ${chalk.dim("commonDir")}  ${shortenPath(identity.commonDir)}` : null,
		`  ${chalk.dim("ref")}       ${refLine}`,
		`  ${chalk.dim("key")}       ${identity.key}`,
	].filter((line): line is string => line !== null);
}

function displayLocationPaths(location: CodeGraphIndexLocation): string[] {
	return [
		`  ${chalk.dim("indexDir")}     ${shortenPath(location.indexDir)}`,
		`  ${chalk.dim("dbPath")}       ${shortenPath(location.dbPath)}`,
		`  ${chalk.dim("lockPath")}     ${shortenPath(location.lockPath)}`,
		`  ${chalk.dim("metadataPath")} ${shortenPath(location.metadataPath)}`,
	];
}

function displayMetadata(meta: CodeGraphLocationMetadata | null | undefined): string[] {
	if (!meta) return [`  ${chalk.dim("metadata")}    (none)`];
	const lines: string[] = [`  ${chalk.dim("schemaVersion")}  ${meta.schemaVersion}`];
	const synced = typeof meta.lastSyncedAt === "string" ? meta.lastSyncedAt : null;
	const used = typeof meta.lastUsedAt === "string" ? meta.lastUsedAt : null;
	lines.push(`  ${chalk.dim("lastSyncedAt")}  ${synced ?? chalk.dim("(never)")}`);
	lines.push(`  ${chalk.dim("lastUsedAt")}    ${used ?? chalk.dim("(never)")}`);
	if (typeof meta.extractionVersion === "string") {
		lines.push(`  ${chalk.dim("extraction")}    ${meta.extractionVersion}`);
	}
	if (typeof meta.indexSchemaVersion === "string" || typeof meta.indexSchemaVersion === "number") {
		lines.push(`  ${chalk.dim("indexSchema")}   ${String(meta.indexSchemaVersion)}`);
	}
	if (typeof meta.nativeContractVersion === "string") {
		lines.push(`  ${chalk.dim("nativeABI")}     ${meta.nativeContractVersion}`);
	}
	return lines;
}

/**
 * Show the resolved CodeGraph index slot for the current project (or an
 * explicit `--cwd`). Prints identity, paths, and metadata; degrades gracefully
 * when the project is not inside a Git repository or has no index yet.
 */
export async function runCodeGraphStatus(options: CodeGraphStatusOptions): Promise<void> {
	const cwd = options.cwd ?? getProjectDir();
	const status = await getCodeGraphIndexLocationStatus(cwd);
	const { location, exists, metadata, verified, reason } = status;

	if (options.json) {
		writeLine(
			JSON.stringify(
				{
					cwd,
					available: location.available,
					reason: location.reason ?? null,
					exists,
					verified,
					metadata,
					identity: location.identity,
					paths: {
						indexDir: location.indexDir,
						dbPath: location.dbPath,
						lockPath: location.lockPath,
						metadataPath: location.metadataPath,
					},
				},
				null,
				2,
			),
		);
		return;
	}

	writeLine(chalk.bold(`CodeGraph index — ${chalk.cyan(cwd)}`));
	writeLine(
		`  ${chalk.dim("state")}     ${describeIndexReason(reason ?? (location.available ? undefined : "unavailable"))}`,
	);
	writeLine(`  ${chalk.dim("exists")}    ${exists ? chalk.green("yes") : chalk.dim("no")}`);
	writeLine(`  ${chalk.dim("verified")}  ${verified ? chalk.green("ok") : chalk.dim("skipped")}`);
	writeLine(chalk.bold("\nIdentity:"));
	writeLine(displayIdentity(location.identity).join("\n"));
	writeLine(chalk.bold("\nPaths:"));
	writeLine(displayLocationPaths(location).join("\n"));
	writeLine(chalk.bold("\nMetadata:"));
	writeLine(displayMetadata(metadata).join("\n"));

	if (!location.available) {
		writeLine(chalk.dim(`\nNo index can be built for this project (${location.reason ?? "unknown reason"}).`));
		return;
	}
	if (!exists) {
		writeLine(chalk.dim("\nNo index has been built yet. The next `omp` session will populate it."));
	}
}

/**
 * Remove the CodeGraph index slot for the current project, an explicit `--cwd`
 * project, or an explicit `--key`. Strictly limited to validated slots under
 * `~/.omp/codegraph/v1/indexes/` — arbitrary paths are never accepted.
 */
export async function runCodeGraphClear(options: CodeGraphClearOptions): Promise<void> {
	if (options.cwd !== undefined && options.key !== undefined) {
		throw new Error("Use either --cwd or --key, not both.");
	}
	let result: CodeGraphIndexLocationClearResult;
	const resolvedVia: "cwd" | "key" = options.key !== undefined ? "key" : "cwd";
	if (options.key !== undefined) {
		result = await clearCodeGraphIndexLocationByKey(options.key, { dryRun: options.dryRun });
	} else {
		const cwd = options.cwd ?? getProjectDir();
		const location = await resolveCodeGraphIndexLocation(cwd);
		if (!location.available) {
			if (options.json) {
				writeLine(
					JSON.stringify(
						{
							resolvedVia: "cwd" as const,
							cwd,
							available: false,
							reason: location.reason ?? "unavailable",
							removed: false,
							identity: location.identity,
							indexDir: location.indexDir,
						},
						null,
						2,
					),
				);
			} else {
				writeLine(chalk.dim(`No CodeGraph index for ${cwd}: ${location.reason ?? "location unavailable"}.`));
			}
			return;
		}
		result = await clearCodeGraphIndexLocation(location, { dryRun: options.dryRun });
	}
	const removed = result.removed;
	const wouldRemove = result.wouldRemove ?? false;

	if (options.json) {
		writeLine(
			JSON.stringify(
				{
					resolvedVia,
					dryRun: options.dryRun,
					removed,
					wouldRemove,
					identity: result.location.identity,
					indexDir: result.location.indexDir,
				},
				null,
				2,
			),
		);
		return;
	}

	const target = chalk.cyan(result.location.identity.key);
	const indexDir = chalk.dim(shortenPath(result.location.indexDir));
	if (removed) {
		writeLine(`${chalk.green("removed")}  slot ${target}`);
		writeLine(`         ${indexDir}`);
		return;
	}
	if (wouldRemove) {
		writeLine(`${chalk.yellow("would remove")}  slot ${target}`);
		writeLine(`               ${indexDir}`);
		return;
	}
	writeLine(chalk.dim(`No CodeGraph index found for slot ${target} (already clean).`));
	writeLine(chalk.dim(`         ${indexDir}`));
}

/**
 * Sweep the CodeGraph indexes root: invalid legacy entries, slots past
 * `--older-than-days`, and slots beyond the `--keep` newest (by `lastUsedAt`).
 * `--dry-run` reports the plan without touching the filesystem.
 */
export async function runCodeGraphPrune(options: CodeGraphPruneOptions): Promise<void> {
	const facadeOptions: CodeGraphIndexPruneOptions = {
		dryRun: options.dryRun || undefined,
		keep: options.keep,
		olderThanDays: options.olderThanDays,
	};
	const result = await pruneCodeGraphIndexes(facadeOptions);

	if (options.json) {
		writeLine(JSON.stringify(result, null, 2));
		return;
	}

	const root = chalk.dim(shortenPath(result.root));
	writeLine(chalk.bold(`CodeGraph prune — ${root}`));
	writeLine(
		`  ${chalk.dim("scanned")}  ${result.scanned}    ${chalk.dim("removed")}  ${result.removed}    ${chalk.dim("kept")}  ${result.kept}${options.dryRun ? chalk.dim("    (dry-run)") : ""}`,
	);

	if (result.scanned === 0) {
		writeLine(chalk.dim(`\nNo indexes under ${getCodeGraphStorageRoot()}.`));
		return;
	}

	const groups = new Map<string, CodeGraphIndexPruneEntry[]>();
	for (const entry of result.entries) {
		const list = groups.get(entry.reason) ?? [];
		list.push(entry);
		groups.set(entry.reason, list);
	}

	writeLine();
	for (const [reason, entries] of groups) {
		writeLine(`${chalk.bold(reason)} ${chalk.dim(`(${entries.length})`)}`);
		for (const entry of entries) {
			const tag = entry.removed
				? chalk.green(options.dryRun ? "would-remove" : "removed")
				: entry.wouldRemove
					? chalk.yellow("would-remove")
					: chalk.dim("kept");
			writeLine(`  ${tag.padEnd(13)} ${shortenPath(entry.path)}`);
		}
	}

	const verb = options.dryRun ? "would remove" : "removed";
	writeLine(chalk.dim(`\n${verb} ${result.removed} · kept ${result.kept}`));
}
