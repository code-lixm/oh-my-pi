/**
 * `omp cron` — read-only management view of persisted scheduled tasks.
 *
 * Scheduled tasks are session-bound: each job lives in the session's
 * artifacts sidecar (`scheduled-jobs.json`) and shares that session's
 * lifecycle. This command scans the local session store and renders every
 * sidecar's jobs so scheduled work is observable across sessions from the
 * shell. Mutations stay inside the owning session (the `cron` tool, `/cron`,
 * and `/schedule`) — two processes writing one sidecar is a lost update.
 */

import type * as node_fs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface CronListFlags {
	json?: boolean;
	all?: boolean;
}

export interface CronJobRow {
	project: string;
	sessionId: string;
	sessionDir: string;
	jobId: string;
	source: string;
	status: string;
	schedule: string;
	deliveryMode: string;
	nextRunAt?: string;
	lastRunAt?: string;
	runCount: number;
	lastError?: string;
	prompt: string;
	updatedAt?: string;
}

interface RawSidecarJob {
	id?: unknown;
	source?: unknown;
	status?: unknown;
	prompt?: unknown;
	updatedAt?: unknown;
	nextRunAt?: unknown;
	lastRunAt?: unknown;
	runCount?: unknown;
	lastError?: unknown;
	deliveryMode?: unknown;
	schedule?: { expression?: unknown };
}

interface RawSidecarState {
	jobs?: unknown;
}

const PROMPT_PREVIEW_CHARS = 60;

/** Find `scheduled-jobs.json` sidecars under the sessions root (bounded depth). */
export async function discoverCronSidecars(sessionsDir: string): Promise<string[]> {
	const sidecars: string[] = [];
	const visit = async (dir: string, depth: number): Promise<void> => {
		if (depth > 4) return;
		let entries: node_fs.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isFile()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isFile() && entry.name === "scheduled-jobs.json") {
				sidecars.push(full);
				continue;
			}
			if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(full, depth + 1);
		}
	};
	await visit(sessionsDir, 0);
	return sidecars.sort();
}

/** Parse one sidecar into job rows; unreadable or corrupt files yield no rows. */
export function parseCronSidecar(sidecarPath: string, text: string): CronJobRow[] {
	// `<sessions>/<project>/<sessionDir>/[...]/scheduled-jobs.json`
	const segments = sidecarPath.split(path.sep);
	const sessionsIndex = segments.lastIndexOf("sessions");
	const project = segments[sessionsIndex + 1] ?? "unknown";
	const sessionDir = segments[sessionsIndex + 2] ?? segments[sessionsIndex + 1] ?? "unknown";
	let state: RawSidecarState;
	try {
		state = JSON.parse(text) as RawSidecarState;
	} catch {
		return [];
	}
	if (!state || typeof state !== "object" || !Array.isArray(state.jobs)) return [];
	const rows: CronJobRow[] = [];
	for (const job of state.jobs as RawSidecarJob[]) {
		if (!job || typeof job !== "object" || typeof job.id !== "string") continue;
		const prompt = typeof job.prompt === "string" ? job.prompt : "";
		rows.push({
			project,
			sessionId: sessionDir,
			sessionDir,
			jobId: job.id,
			source: typeof job.source === "string" ? job.source : "cron",
			status: typeof job.status === "string" ? job.status : "unknown",
			schedule: typeof job.schedule?.expression === "string" ? job.schedule.expression : String(job.schedule ?? "—"),
			deliveryMode: typeof job.deliveryMode === "string" ? job.deliveryMode : "follow_up",
			nextRunAt: typeof job.nextRunAt === "string" ? job.nextRunAt : undefined,
			lastRunAt: typeof job.lastRunAt === "string" ? job.lastRunAt : undefined,
			runCount: typeof job.runCount === "number" ? job.runCount : 0,
			lastError: typeof job.lastError === "string" ? job.lastError : undefined,
			prompt:
				prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_PREVIEW_CHARS) +
				(prompt.replace(/\s+/g, " ").trim().length > PROMPT_PREVIEW_CHARS ? "…" : ""),
			updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : undefined,
		});
	}
	return rows;
}

/** Load every cron job row under the sessions root. */
export async function collectCronRows(sessionsDir: string, includeAllSources = true): Promise<CronJobRow[]> {
	const rows: CronJobRow[] = [];
	for (const sidecar of await discoverCronSidecars(sessionsDir)) {
		try {
			const text = await fs.readFile(sidecar, "utf8");
			for (const row of parseCronSidecar(sidecar, text)) {
				if (!includeAllSources && row.source !== "cron") continue;
				rows.push(row);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				// Unreadable sidecar: surface it as a failed row so the list is honest.
				rows.push({
					project: "unreadable",
					sessionId: path.basename(path.dirname(sidecar)),
					sessionDir: sidecar,
					jobId: sidecar,
					source: "cron",
					status: `error: ${error instanceof Error ? error.message : String(error)}`,
					schedule: "—",
					deliveryMode: "—",
					runCount: 0,
					prompt: "—",
				});
			}
		}
	}
	return rows;
}

function shortTime(value: string | undefined): string {
	if (!value) return "—";
	const at = Date.parse(value);
	if (!Number.isFinite(at)) return "—";
	const local = new Date(at);
	const sameDay = new Date().toDateString() === local.toDateString();
	const hh = String(local.getHours()).padStart(2, "0");
	const mm = String(local.getMinutes()).padStart(2, "0");
	if (sameDay) return `${hh}:${mm}`;
	const dd = String(local.getDate()).padStart(2, "0");
	const mo = String(local.getMonth() + 1).padStart(2, "0");
	return `${mo}-${dd} ${hh}:${mm}`;
}

function renderTable(rows: CronJobRow[]): string {
	if (rows.length === 0) return "No scheduled tasks found.";
	const headers = ["project", "session", "status", "schedule", "next", "runs", "prompt"] as const;
	const table: string[][] = rows.map(row => [
		row.project,
		row.sessionId.slice(0, 8),
		row.status,
		row.schedule,
		shortTime(row.nextRunAt),
		String(row.runCount),
		row.prompt,
	]);
	const widths = headers.map((header, columnIndex) =>
		Math.max(header.length, ...table.map(cells => cells[columnIndex]?.length ?? 0)),
	);
	const line = (cells: string[]): string =>
		cells
			.map((cell, index) => cell.padEnd(widths[index] ?? 0))
			.join("  ")
			.trimEnd();
	return [
		line([...headers]),
		...table.map(cells => line(cells)),
		`\n${rows.length} task${rows.length === 1 ? "" : "s"}. Jobs are session-bound: they stop firing when their session ends.`,
	].join("\n");
}

/** Entry point for `omp cron`. */
export async function runCronCommand(
	flags: CronFlags = {},
	agentDir: string = getAgentDir(),
	stdout: (text: string) => void = text => console.log(text),
): Promise<void> {
	const sessionsDir = path.join(agentDir, "sessions");
	const rows = await collectCronRows(sessionsDir, true);
	if (flags.json) {
		stdout(JSON.stringify(rows, null, 2));
		return;
	}
	stdout(renderTable(rows));
}

export interface CronFlags {
	json?: boolean;
}
