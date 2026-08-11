import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { GitWorktreeSnapshot } from "./types";

const WORKTREE_PATHSPEC = [
	".",
	":(exclude)verification",
	":(exclude)target",
	":(exclude).vf-prime-agent",
	":(exclude)Cargo.lock",
	":(exclude)submission.tar.gz",
	":(exclude)runner_args.log",
] as const;

export interface GateCommandResult {
	status: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
	outputTruncated: boolean;
}

interface CapturedOutput {
	text: string;
	truncated: boolean;
}

/**
 * Run a configured quality gate through the platform shell. Output streams are
 * drained even after their retained prefix reaches `maxOutputChars`, so a
 * verbose gate cannot deadlock on a full pipe. `ptree` owns timeout/abort
 * cleanup, including descendants launched by `/bin/sh -c`.
 */
export async function runGateCommand(
	command: string,
	cwd: string,
	options: { timeoutMs: number; maxOutputChars: number; signal?: AbortSignal },
): Promise<GateCommandResult> {
	options.signal?.throwIfAborted();

	try {
		using child = ptree.spawn(shellCommand(command), {
			cwd,
			signal: options.signal,
			timeout: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : undefined,
			stderr: "full",
		});
		const exited = child.exited.then(
			status => ({ status, error: undefined }),
			error => ({ status: child.exitCode ?? -1, error }),
		);
		const [stdout, stderr, outcome] = await Promise.all([
			captureOutput(child.stdout, options.maxOutputChars),
			captureOutput(child.stderr!, options.maxOutputChars),
			exited,
		]);
		options.signal?.throwIfAborted();
		const timedOut = outcome.error instanceof ptree.TimeoutError;
		return {
			status: outcome.status,
			stdout: stdout.text,
			stderr: stderr.text,
			timedOut,
			...(outcome.error !== undefined && !timedOut ? { error: errorMessage(outcome.error) } : {}),
			outputTruncated: stdout.truncated || stderr.truncated,
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		return {
			status: -1,
			stdout: "",
			stderr: "",
			timedOut: error instanceof ptree.TimeoutError,
			error: errorMessage(error),
			outputTruncated: false,
		};
	}
}

/** Capture the repository state relevant to autonomous work without invoking git directly. */
export async function captureWorktreeSnapshot(
	cwd: string,
	signal?: AbortSignal,
): Promise<GitWorktreeSnapshot | undefined> {
	signal?.throwIfAborted();
	try {
		const status = await git.status(cwd, {
			porcelainV1: true,
			z: true,
			untrackedFiles: "all",
			pathspecs: WORKTREE_PATHSPEC,
			signal,
		});
		signal?.throwIfAborted();
		const diff = await git.diff(cwd, {
			base: "HEAD",
			binary: true,
			files: WORKTREE_PATHSPEC,
			signal,
		});
		signal?.throwIfAborted();
		return {
			status,
			diff,
			untrackedHash: await hashUntrackedFiles(cwd, status, signal),
		};
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

export function worktreeSnapshotsEqual(
	a: GitWorktreeSnapshot | undefined,
	b: GitWorktreeSnapshot | undefined,
): boolean {
	return !!a && !!b && a.status === b.status && a.diff === b.diff && a.untrackedHash === b.untrackedHash;
}

export function truncateGateOutput(output: string, outputAlreadyTruncated = false, maxChars = 6000): string {
	if (output.length <= maxChars && !outputAlreadyTruncated) return output;
	return `${output.slice(0, maxChars)}\n... [truncated]`;
}

function shellCommand(command: string): string[] {
	if (process.platform === "win32") return [Bun.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command];
	return ["/bin/sh", "-c", command];
}

async function captureOutput(stream: ReadableStream<Uint8Array>, maxOutputChars: number): Promise<CapturedOutput> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const limit = Number.isFinite(maxOutputChars) ? Math.max(0, Math.trunc(maxOutputChars)) : 0;
	let text = "";
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			appendCapturedChunk(decoder.decode(value, { stream: true }));
		}
		appendCapturedChunk(decoder.decode());
		return { text, truncated };
	} finally {
		reader.releaseLock();
	}

	function appendCapturedChunk(chunk: string): void {
		if (!chunk) return;
		const remaining = limit - text.length;
		if (remaining > 0) text += chunk.slice(0, remaining);
		if (chunk.length > Math.max(remaining, 0)) truncated = true;
	}
}

function untrackedPathsFromStatus(status: string): string[] {
	return status
		.split("\0")
		.filter(entry => entry.startsWith("?? "))
		.map(entry => entry.slice(3))
		.sort();
}

async function hashUntrackedFiles(cwd: string, status: string, signal?: AbortSignal): Promise<string> {
	const aggregate = new Bun.CryptoHasher("sha256");
	for (const relativePath of untrackedPathsFromStatus(status)) {
		signal?.throwIfAborted();
		aggregate.update(relativePath);
		aggregate.update("\0");
		aggregate.update(await hashUntrackedPath(path.resolve(cwd, relativePath), signal));
		aggregate.update("\0");
	}
	signal?.throwIfAborted();
	return aggregate.digest("hex");
}

async function hashUntrackedPath(filePath: string, signal?: AbortSignal): Promise<string> {
	try {
		signal?.throwIfAborted();
		const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
		signal?.throwIfAborted();
		return `file:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
	} catch (error) {
		signal?.throwIfAborted();
		return `error:${errorMessage(error)}`;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
