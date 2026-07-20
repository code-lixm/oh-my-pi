import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-pi/pi-utils";
import type { Args } from "./args";

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

const DEFAULT_SANDBOX_DIR = path.join(os.homedir(), ".omp", "sandbox");

async function applySandbox(parsed: Args): Promise<boolean> {
	if (!parsed.sandbox) return false;

	const sandboxDir = parsed.cwd ?? DEFAULT_SANDBOX_DIR;
	await fs.mkdir(sandboxDir, { recursive: true });
	setProjectDir(sandboxDir);
	parsed.cwd = getProjectDir();
	return true;
}

export async function applyStartupCwd(parsed: Args): Promise<void> {
	if (await applySandbox(parsed)) return;
	if (parsed.cwd) {
		setProjectDir(parsed.cwd);
		// setProjectDir resolves the (possibly relative) target against the launch
		// cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		// so downstream consumers (buildSessionOptions, settings/discovery, session
		// persistence) don't re-resolve a relative string against the new cwd.
		parsed.cwd = getProjectDir();
		return;
	}
	await maybeAutoChdir(parsed);
}
