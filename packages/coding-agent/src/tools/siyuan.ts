import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { $which, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { selectPrompt } from "../prompts/prompt-locale";
import siyuanDescription from "../prompts/tools/siyuan.md" with { type: "text" };
import siyuanDescriptionZh from "../prompts/tools/siyuan.zh-CN.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const SIYUAN_VERSION_PATTERN = /^siyuan version (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const SIYUAN_WORKSPACE_HELP_PATTERN = /Usage:\s+siyuan workspace(?:\s|$)/;
const OFFICIAL_MACOS_TEAM_ID = "FJT3K7XAD8";
const DETECTION_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
const MIN_COMMAND_TIMEOUT_SECONDS = 1;
const MAX_COMMAND_TIMEOUT_SECONDS = 3_600;

const siyuanSchema = type({
	op: type(
		"'asset' | 'attr' | 'block' | 'bookmark' | 'dailynote' | 'database' | 'document' | 'export' | 'file' | 'history' | 'import' | 'inbox' | 'notebook' | 'outline' | 'ref' | 'repo' | 'search' | 'sql' | 'sync' | 'system' | 'tag' | 'template' | 'workspace'",
	).describe("SiYuan command group"),
	"args?": type("string[]").describe("arguments after the command group; exclude global flags"),
	"workspace?": type("string").describe("registered workspace name or absolute path"),
	"format?": type("'json' | 'table'").describe("CLI output format; defaults to json"),
	"dryRun?": type("boolean").describe("mutation preview; defaults to true for mutating operations"),
	"stdin?": type("string").describe("stdin content for commands using --file -"),
	"timeout?": type("number").describe("timeout in seconds (1-3600)"),
});

export type SiyuanInput = typeof siyuanSchema.infer;

export interface SiyuanToolDetails {
	meta?: OutputMeta;
	binary: string;
	version: string;
	workspace?: string;
	dryRun: boolean;
	exitCode: number;
}

export interface SiyuanProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface SiyuanSpawnOptions {
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
}

export type SiyuanVerification = "apple-signature" | "compatibility-signature";

export type SiyuanCliDetection =
	| { available: true; path: string; version: string; verification: SiyuanVerification }
	| {
			available: false;
			reason: "not-found" | "version-check-failed" | "invalid-version" | "incompatible-cli" | "untrusted-signature";
			path?: string;
			detail?: string;
	  };

export interface SiyuanCliDetectionOptions {
	resolveBinary?: () => string | null;
	spawn?: typeof spawnSiyuan;
	platform?: NodeJS.Platform;
	verifyMacSignature?: (binary: string) => Promise<boolean>;
}

export interface SiyuanMacSignatureVerificationOptions {
	spawn?: typeof spawnSiyuan;
	resolveCodesign?: () => string | null;
}

interface RegisteredWorkspace {
	name: string;
	path: string;
}

let cachedDetection: Promise<SiyuanCliDetection> | undefined;

const READ_ONLY_OPERATIONS = new Set([
	"asset:stat",
	"asset:unused",
	"attr:batch-get",
	"attr:get",
	"block:batch-get",
	"block:batch-kramdown",
	"block:breadcrumb",
	"block:children",
	"block:dom",
	"block:get",
	"block:kramdown",
	"block:stat",
	"bookmark:labels",
	"bookmark:list",
	"database:get",
	"database:keys",
	"database:render",
	"database:search",
	"database:unused",
	"document:get",
	"document:info",
	"document:list",
	"document:search",
	"file:find",
	"file:grep",
	"file:list",
	"file:read",
	"file:stat",
	"history:get",
	"history:list",
	"history:search",
	"inbox:get",
	"inbox:list",
	"notebook:list",
	"ref:backlinks",
	"ref:mentions",
	"repo:diff",
	"repo:list",
	"repo:search",
	"sync:status",
	"system:current-time",
	"tag:list",
	"template:get",
	"template:render",
	"template:search",
	"workspace:info",
	"workspace:list",
]);

const READ_ONLY_TOP_LEVEL = new Set(["outline", "search"]);
const RESERVED_GLOBAL_ARGUMENTS = new Set(["--dry-run", "--format", "--log-level", "--workspace", "-f", "-v", "-w"]);

function processErrorDetail(result: SiyuanProcessResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}

export async function spawnSiyuan(
	binary: string,
	args: readonly string[],
	options: SiyuanSpawnOptions = {},
): Promise<SiyuanProcessResult> {
	if (options.signal?.aborted) throw new ToolAbortError();
	const proc = Bun.spawn({
		cmd: [binary, ...args],
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const aborted = Promise.withResolvers<never>();
	const timedOut = Promise.withResolvers<never>();
	const onAbort = () => {
		proc.kill();
		aborted.reject(new ToolAbortError());
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_SECONDS * 1_000;
	const timer = setTimeout(() => {
		proc.kill();
		timedOut.reject(new ToolError(`siyuan command timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const completed = proc.exited.then(async exitCode => ({
		stdout: await stdout,
		stderr: await stderr,
		exitCode,
	}));

	try {
		return await Promise.race([completed, aborted.promise, timedOut.promise]);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function verifyOfficialMacSignature(
	binary: string,
	options: SiyuanMacSignatureVerificationOptions = {},
): Promise<boolean> {
	try {
		const codesign = options.resolveCodesign?.() ?? $which("codesign") ?? "/usr/bin/codesign";
		const spawn = options.spawn ?? spawnSiyuan;
		const verification = await spawn(codesign, ["--verify", "--strict", binary], {
			timeoutMs: DETECTION_TIMEOUT_MS,
		});
		if (verification.exitCode !== 0) return false;
		const metadata = await spawn(codesign, ["-dv", "--verbose=4", binary], {
			timeoutMs: DETECTION_TIMEOUT_MS,
		});
		if (metadata.exitCode !== 0) return false;
		const signature = `${metadata.stdout}\n${metadata.stderr}`;
		return (
			signature.includes(`TeamIdentifier=${OFFICIAL_MACOS_TEAM_ID}`) &&
			signature.includes("Identifier=SiYuan-Kernel")
		);
	} catch {
		return false;
	}
}

export async function detectSiyuanCli(options: SiyuanCliDetectionOptions = {}): Promise<SiyuanCliDetection> {
	const resolveBinary = options.resolveBinary ?? (() => $which("siyuan"));
	const binary = resolveBinary();
	if (!binary) return { available: false, reason: "not-found" };
	const spawn = options.spawn ?? spawnSiyuan;
	let versionResult: SiyuanProcessResult;
	try {
		versionResult = await spawn(binary, ["--version"], { timeoutMs: DETECTION_TIMEOUT_MS });
	} catch (error) {
		return {
			available: false,
			reason: "version-check-failed",
			path: binary,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (versionResult.exitCode !== 0) {
		return {
			available: false,
			reason: "version-check-failed",
			path: binary,
			detail: processErrorDetail(versionResult),
		};
	}
	const versionOutput = versionResult.stdout.trim();
	const versionMatch = SIYUAN_VERSION_PATTERN.exec(versionOutput);
	if (!versionMatch) {
		return { available: false, reason: "invalid-version", path: binary, detail: versionOutput };
	}

	let helpResult: SiyuanProcessResult;
	try {
		helpResult = await spawn(binary, ["workspace", "--help"], { timeoutMs: DETECTION_TIMEOUT_MS });
	} catch (error) {
		return {
			available: false,
			reason: "incompatible-cli",
			path: binary,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (helpResult.exitCode !== 0 || !SIYUAN_WORKSPACE_HELP_PATTERN.test(helpResult.stdout)) {
		return {
			available: false,
			reason: "incompatible-cli",
			path: binary,
			detail: processErrorDetail(helpResult),
		};
	}

	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const verifySignature = options.verifyMacSignature ?? verifyOfficialMacSignature;
		try {
			if (!(await verifySignature(binary))) {
				return { available: false, reason: "untrusted-signature", path: binary };
			}
		} catch (error) {
			return {
				available: false,
				reason: "untrusted-signature",
				path: binary,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		return { available: true, path: binary, version: versionMatch[1]!, verification: "apple-signature" };
	}
	return { available: true, path: binary, version: versionMatch[1]!, verification: "compatibility-signature" };
}

export function getSiyuanCliDetection(): Promise<SiyuanCliDetection> {
	cachedDetection ??= detectSiyuanCli();
	return cachedDetection;
}

export function resetSiyuanCliDetectionForTests(): void {
	cachedDetection = undefined;
}

function operationKey(params: SiyuanInput): string {
	const subcommand = params.args?.[0]?.trim();
	return subcommand ? `${params.op}:${subcommand}` : params.op;
}

export function isSiyuanReadOnlyOperation(params: SiyuanInput): boolean {
	if (params.args?.includes("--help") || params.args?.includes("-h")) return true;
	if (params.op === "sql") {
		return /^\s*SELECT\b/i.test(params.args?.[0] ?? "");
	}
	return READ_ONLY_TOP_LEVEL.has(params.op) || READ_ONLY_OPERATIONS.has(operationKey(params));
}

function validateInput(params: SiyuanInput): void {
	for (const arg of params.args ?? []) {
		const flag = arg.split("=", 1)[0]!;
		if (RESERVED_GLOBAL_ARGUMENTS.has(flag)) {
			throw new ToolError(`Pass '${flag}' through the dedicated siyuan tool field, not args.`);
		}
	}
	if (params.op === "sql" && !/^\s*SELECT\b/i.test(params.args?.[0] ?? "")) {
		throw new ToolError("siyuan sql only permits SELECT queries");
	}
}

function parseWorkspaceList(stdout: string): RegisteredWorkspace[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new ToolError("siyuan workspace list returned invalid JSON");
	}
	if (!Array.isArray(parsed)) throw new ToolError("siyuan workspace list returned an unexpected result");
	const workspaces: RegisteredWorkspace[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.name !== "string" || typeof record.path !== "string") continue;
		workspaces.push({ name: record.name, path: path.resolve(record.path) });
	}
	return workspaces;
}

function normalizeWorkspacePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
	return path.resolve(value);
}

function pathsEqual(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(left);
	const normalizedRight = path.normalize(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

async function listRegisteredWorkspaces(
	binary: string,
	spawn: typeof spawnSiyuan,
	signal?: AbortSignal,
): Promise<RegisteredWorkspace[]> {
	const result = await spawn(binary, ["--format", "json", "workspace", "list"], {
		signal,
		timeoutMs: DETECTION_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new ToolError(`siyuan workspace list failed: ${processErrorDetail(result)}`);
	}
	return parseWorkspaceList(result.stdout);
}

async function resolveWorkspace(
	session: ToolSession,
	binary: string,
	params: SiyuanInput,
	spawn: typeof spawnSiyuan,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (params.args?.includes("--help") || params.args?.includes("-h")) return undefined;
	if (params.op === "workspace" && params.args?.[0] === "list") return undefined;
	if (params.op === "system") return undefined;
	const requested =
		params.workspace?.trim() ||
		session.settings.get("siyuan.workspace")?.trim() ||
		process.env.SIYUAN_WORKSPACE_PATH?.trim();
	const workspaces = await listRegisteredWorkspaces(binary, spawn, signal);
	if (requested) {
		const byName = workspaces.filter(workspace => workspace.name === requested);
		if (byName.length === 1) return byName[0]!.path;
		const requestedPath = normalizeWorkspacePath(requested);
		const byPath = workspaces.find(workspace => pathsEqual(workspace.path, requestedPath));
		if (byPath) return byPath.path;
		const available =
			workspaces
				.map(workspace => workspace.name)
				.sort()
				.join(", ") || "none";
		throw new ToolError(`Unknown registered SiYuan workspace: ${requested}\nAvailable: ${available}`);
	}
	if (workspaces.length === 1) return workspaces[0]!.path;
	if (workspaces.length === 0) throw new ToolError("No registered SiYuan workspaces found");
	const available = workspaces
		.map(workspace => workspace.name)
		.sort()
		.join(", ");
	throw new ToolError(
		`Multiple SiYuan workspaces are registered; pass workspace explicitly.\nAvailable: ${available}`,
	);
}

function commandTimeoutMs(rawTimeout: number | undefined): number {
	const seconds = Math.max(
		MIN_COMMAND_TIMEOUT_SECONDS,
		Math.min(MAX_COMMAND_TIMEOUT_SECONDS, rawTimeout ?? DEFAULT_COMMAND_TIMEOUT_SECONDS),
	);
	return seconds * 1_000;
}

export class SiyuanTool implements AgentTool<typeof siyuanSchema, SiyuanToolDetails> {
	readonly name = "siyuan";
	readonly summary = "Query and manage SiYuan workspaces, documents, blocks, databases, and sync";
	readonly loadMode = "discoverable";
	readonly label = "SiYuan";
	readonly description = prompt.render(selectPrompt(siyuanDescription, siyuanDescriptionZh));
	readonly parameters = siyuanSchema;
	readonly strict = true;

	readonly approval = (args: unknown): ToolApprovalDecision => {
		const params = args as Partial<SiyuanInput>;
		if (params.op === "inbox" || params.op === "sync") return "exec";
		if (!params.op) return "write";
		const complete = params as SiyuanInput;
		if (isSiyuanReadOnlyOperation(complete)) return "read";
		return params.dryRun === false ? "write" : "read";
	};

	constructor(
		private readonly session: ToolSession,
		private readonly cli: Extract<SiyuanCliDetection, { available: true }>,
		private readonly spawn: typeof spawnSiyuan = spawnSiyuan,
	) {}

	static async createIf(session: ToolSession): Promise<SiyuanTool | null> {
		const detection = await getSiyuanCliDetection();
		if (!detection.available) {
			logger.warn("SiYuan integration enabled but official CLI verification failed", {
				reason: detection.reason,
				path: detection.path,
				detail: detection.detail,
			});
			return null;
		}
		return new SiyuanTool(session, detection);
	}

	async execute(
		_toolCallId: string,
		params: SiyuanInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SiyuanToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SiyuanToolDetails>> {
		return untilAborted(signal, async () => {
			validateInput(params);
			const readOnly = isSiyuanReadOnlyOperation(params);
			const dryRun = !readOnly && params.dryRun !== false;
			if (!readOnly && !dryRun && this.session.getPlanModeState?.()?.enabled) {
				throw new ToolError("Plan mode: SiYuan mutations are not allowed.");
			}
			const workspace = await resolveWorkspace(this.session, this.cli.path, params, this.spawn, signal);
			const args: string[] = [];
			if (workspace) args.push("--workspace", workspace);
			args.push("--format", params.format ?? "json");
			if (dryRun) args.push("--dry-run");
			args.push(params.op, ...(params.args ?? []));
			const result = await this.spawn(this.cli.path, args, {
				signal,
				stdin: params.stdin,
				timeoutMs: commandTimeoutMs(params.timeout),
			});
			if (result.exitCode !== 0) {
				throw new ToolError(`siyuan ${params.op} failed: ${processErrorDetail(result)}`);
			}
			const output = result.stdout.trimEnd() || result.stderr.trimEnd() || "(no output)";
			const content = dryRun ? `Dry run only; no data changed.\n\n${output}` : output;
			return toolResult<SiyuanToolDetails>({
				binary: this.cli.path,
				version: this.cli.version,
				workspace,
				dryRun,
				exitCode: result.exitCode,
			})
				.text(content)
				.done();
		});
	}
}
