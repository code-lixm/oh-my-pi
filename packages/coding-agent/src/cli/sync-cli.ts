import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_SYNC_BOOTSTRAP_PASSPHRASE_ENV,
	exportSyncBootstrap,
	importSyncBootstrap,
} from "../config-sync/bootstrap";
import {
	DEFAULT_SYNC_PASSPHRASE_ENV,
	getSyncConflictPath,
	loadSyncProfile,
	loadSyncState,
	saveSyncProfile,
	saveSyncState,
} from "../config-sync/profile";
import {
	garbageCollectConfiguration,
	getConfigSyncStatus,
	resolveConfigurationConflict,
	synchronizeConfiguration,
} from "../config-sync/service";
import type { ConfigConflictDocument, SyncProfile } from "../config-sync/types";
import { getEditorCommand, openInEditor } from "../utils/external-editor";

export type SyncAction = "init" | "push" | "pull" | "status" | "conflict" | "resolve" | "gc" | "bootstrap";

export interface SyncCommandArgs {
	action: SyncAction;
	target?: string;
	file?: string;
	flags: {
		bucket?: string;
		prefix?: string;
		region?: string;
		virtualHostedStyle?: boolean;
		autoPush?: boolean;
		endpoint?: string;
		accessKeyIdEnv?: string;
		secretAccessKeyEnv?: string;
		sessionTokenEnv?: string;
		passphraseEnv?: string;
		dryRun?: boolean;
		adopt?: boolean;
		apply?: boolean;
		json?: boolean;
		ours?: boolean;
		theirs?: boolean;
		editor?: boolean;
	};
}

export async function runSyncCommand(args: SyncCommandArgs): Promise<void> {
	const agentDir = getAgentDir();
	let output: unknown;
	switch (args.action) {
		case "init":
			output = await initializeSync(agentDir, args);
			break;
		case "push":
		case "pull": {
			const mode = args.action === "push" ? "push" : "pull";
			output = await withAuthStorage(agentDir, authStorage =>
				synchronizeConfiguration(agentDir, authStorage, {
					mode,
					dryRun: args.flags.dryRun,
					adopt: args.flags.adopt,
				}),
			);
			break;
		}
		case "status":
			output = await getConfigSyncStatus(agentDir);
			break;
		case "conflict":
			output = await showConflict(agentDir, args.flags.editor === true);
			break;
		case "resolve": {
			if (args.flags.ours === args.flags.theirs) throw new Error("Choose exactly one of --ours or --theirs");
			const choice = args.flags.ours ? "ours" : "theirs";
			output = await withAuthStorage(agentDir, authStorage =>
				resolveConfigurationConflict(agentDir, authStorage, choice, args.target),
			);
			break;
		}
		case "gc":
			if (args.flags.apply && args.flags.dryRun) throw new Error("Choose either --apply or --dry-run");
			output = await garbageCollectConfiguration(agentDir, args.flags.apply !== true);
			break;
		case "bootstrap": {
			if (args.target !== "export" && args.target !== "import") {
				throw new Error("`omp sync bootstrap` requires `export` or `import`");
			}
			if (!args.file) throw new Error("`omp sync bootstrap` requires a bundle file path");
			const passphraseEnv = args.flags.passphraseEnv ?? DEFAULT_SYNC_BOOTSTRAP_PASSPHRASE_ENV;
			const passphrase = process.env[passphraseEnv];
			if (!passphrase) throw new Error(`Set ${passphraseEnv} before using sync bootstrap`);
			output =
				args.target === "export"
					? await exportSyncBootstrap(agentDir, args.file, passphrase)
					: await importSyncBootstrap(agentDir, args.file, passphrase, args.flags.dryRun === true);
			break;
		}
	}
	renderOutput(output, args.flags.json === true);
}

async function initializeSync(
	agentDir: string,
	args: SyncCommandArgs,
): Promise<{ profile: SyncProfile; writerId: string }> {
	const existing = await loadSyncProfile(agentDir, undefined, { allowDisabled: true });
	const bucket = args.flags.bucket ?? existing?.bucket;
	if (!bucket) throw new Error("`omp sync init` requires --bucket");
	const profile: SyncProfile = {
		formatVersion: 1,
		bucket,
		prefix: args.flags.prefix ?? existing?.prefix ?? "omp-config",
		region: args.flags.region ?? existing?.region,
		endpoint: args.flags.endpoint ?? existing?.endpoint,
		virtualHostedStyle: args.flags.virtualHostedStyle ?? existing?.virtualHostedStyle,
		accessKeyIdEnv: args.flags.accessKeyIdEnv ?? existing?.accessKeyIdEnv,
		secretAccessKeyEnv: args.flags.secretAccessKeyEnv ?? existing?.secretAccessKeyEnv,
		sessionTokenEnv: args.flags.sessionTokenEnv ?? existing?.sessionTokenEnv,
		passphraseEnv: args.flags.passphraseEnv ?? existing?.passphraseEnv ?? DEFAULT_SYNC_PASSPHRASE_ENV,
		autoPush: args.flags.autoPush ?? existing?.autoPush,
		retention: existing?.retention,
	};
	await saveSyncProfile(agentDir, profile);
	const state = await loadSyncState(agentDir);
	await saveSyncState(agentDir, state);
	return { profile, writerId: state.writerId };
}

async function withAuthStorage<T>(agentDir: string, run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
	const authStorage = new AuthStorage(store);
	try {
		await authStorage.reload();
		return await run(authStorage);
	} finally {
		authStorage.close();
	}
}

interface ConfigConflictSummary {
	format: ConfigConflictDocument["format"];
	formatVersion: ConfigConflictDocument["formatVersion"];
	createdAt: string;
	baseRevisionId?: string;
	remoteRevisionIds: string[];
	conflicts: Array<{ kind: "file" | "auth"; key: string }>;
}

async function showConflict(agentDir: string, editor: boolean): Promise<unknown> {
	const conflictPath = getSyncConflictPath(agentDir);
	if (!editor) {
		const conflict = (await Bun.file(conflictPath).json()) as ConfigConflictDocument;
		return { path: conflictPath, conflict: summarizeConflict(conflict) };
	}
	const editorCommand = getEditorCommand();
	if (!editorCommand) throw new Error("No editor configured. Set $VISUAL or $EDITOR");
	const original = await Bun.file(conflictPath).text();
	const edited = await openInEditor(editorCommand, original, { extension: ".json", trimTrailingNewline: false });
	if (edited !== null) {
		JSON.parse(edited);
		await Bun.write(conflictPath, edited);
	}
	return { path: conflictPath, edited: edited !== null };
}
function summarizeConflict(conflict: ConfigConflictDocument): ConfigConflictSummary {
	return {
		format: conflict.format,
		formatVersion: conflict.formatVersion,
		createdAt: conflict.createdAt,
		baseRevisionId: conflict.baseRevisionId,
		remoteRevisionIds: conflict.remoteRevisionIds,
		conflicts: conflict.conflicts.map(entry => ({ kind: entry.kind, key: entry.key })),
	};
}

function renderOutput(value: unknown, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(value, null, 2));
		return;
	}
	if (typeof value === "string") console.log(value);
	else console.log(JSON.stringify(value, null, 2));
}
