/**
 * Automatic cold-session archiving.
 *
 * Hooked into main-session construction so the retention switch
 * (`gc.archive` + `gc.coldArchiveAfterDays` + retention counts) is enforced
 * without remembering to run `omp gc`. Every archived session is first flushed
 * into stats.db (`gc.archivePreserveStats`), so token/cost/request metrics
 * survive forever while the raw files stop consuming space.
 *
 * Runs are throttled through a marker file: at most one scan per throttle
 * window per agent dir, never inside tests.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { runGcCommand } from "./gc-cli";

const RETENTION_THROTTLE_MS = 6 * 60 * 60 * 1_000;

function markerPath(agentDir: string): string {
	return path.join(agentDir, "last-auto-archive");
}

export interface AutoArchiveScanOutcome {
	ran: boolean;
	reason?: "disabled" | "throttled" | "test" | "already-running";
	archived?: number;
}

/** Run at most one retention scan per throttle window. Errors are logged, never thrown. */
export async function runAutoArchiveScan(agentDir: string = getAgentDir()): Promise<AutoArchiveScanOutcome> {
	const settings = await Settings.loadReadOnly({ agentDir });
	if (!settings.get("gc.archive")) return { ran: false, reason: "disabled" };

	const marker = markerPath(agentDir);
	const stat = await fs.stat(marker).catch(() => undefined);
	if (stat && Date.now() - stat.mtimeMs < RETENTION_THROTTLE_MS) return { ran: false, reason: "throttled" };

	// Stamp before running: a slow or crashed scan must not loop every session start.
	await fs.mkdir(path.dirname(marker), { recursive: true });
	await fs.writeFile(marker, new Date().toISOString());

	const result = await runGcCommand({
		flags: {
			apply: true,
			archive: true,
			agentDir,
		},
	});
	if (result.archive && result.archive.archived > 0) {
		logger.info("Auto-archive archived cold sessions", {
			archived: result.archive.archived,
			errors: result.archive.errors.length,
		});
	}
	return { ran: true, archived: result.archive?.archived ?? 0 };
}

let inFlight: Promise<AutoArchiveScanOutcome> | undefined;

/**
 * Fire-and-forget retention scan for session-creation paths. Never throws,
 * never runs inside tests, and collapses concurrent starts into one scan.
 */
export function scheduleAutoArchiveScan(agentDir: string = getAgentDir()): Promise<AutoArchiveScanOutcome> {
	if (isBunTestRuntime()) return Promise.resolve({ ran: false, reason: "test" });
	if (inFlight) return inFlight;
	inFlight = runAutoArchiveScan(agentDir)
		.catch(error => {
			logger.warn("Auto-archive scan failed", { error: String(error) });
			return { ran: false, reason: "disabled" as const };
		})
		.finally(() => {
			inFlight = undefined;
		});
	return inFlight;
}
