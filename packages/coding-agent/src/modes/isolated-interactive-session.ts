import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { resolveCliSpawnCmd } from "../subprocess/worker-client";
import type { EventBus } from "../utils/event-bus";
import { RpcClient } from "./rpc/rpc-client";
import { RemoteAgentSession } from "./session-port/remote-agent-session";

const ISOLATION_AGENT_BOOLEAN_FLAGS = new Set([
	"--allow-home",
	"--no-tools",
	"--no-lsp",
	"--no-pty",
	"--hide-thinking",
	"--advisor",
	"--autonomous",
	"--external-thinking",
	"--prewalk",
	"--no-prewalk",
	"--plan-yolo",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--auto-approve",
	"--yolo",
]);

const ISOLATION_AGENT_VALUE_FLAGS = new Set([
	"--add-dir",
	"--profile",
	"--alias",
	"--config",
	"--smol",
	"--slow",
	"--plan",
	"--prewalk-into",
	"--plan-yolo-into",
	"--max-time",
	"--autonomous-gate",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--service-tier",
	"--system-prompt",
	"--append-system-prompt",
	"--provider-session-id",
	"--prompt-cache-key",
	"--thinking",
	"--models",
	"--tools",
	"--hook",
	"--extension",
	"-e",
	"--trusted-extension",
	"--plugin-dir",
	"--skills",
	"--approval-mode",
]);

export function buildIsolatedChildArgs(
	args: readonly string[],
	extensionFlags: ReadonlyMap<string, boolean | string> | undefined,
): string[] {
	const forwarded: string[] = [];
	const emittedExtensionFlags = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const equalsIndex = arg.indexOf("=");
		const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		const extensionName = flag.startsWith("--") ? flag.slice(2) : undefined;
		const extensionValue = extensionName ? extensionFlags?.get(extensionName) : undefined;
		if (extensionName && extensionValue !== undefined) {
			if (!emittedExtensionFlags.has(extensionName)) {
				emittedExtensionFlags.add(extensionName);
				forwarded.push(`--${extensionName}`);
				if (typeof extensionValue === "string") forwarded.push(extensionValue);
			}
			continue;
		}
		if (ISOLATION_AGENT_BOOLEAN_FLAGS.has(flag)) {
			forwarded.push(arg);
			continue;
		}
		if (ISOLATION_AGENT_VALUE_FLAGS.has(flag)) {
			forwarded.push(arg);
			if (equalsIndex === -1 && args[index + 1] !== undefined) forwarded.push(args[++index]);
		}
	}
	return forwarded;
}

export interface IsolatedInteractiveSessionOptions {
	readonly cwd: string;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly provider?: string;
	readonly model?: string;
	readonly apiKey?: string;
	readonly sessionPath?: string;
	readonly eventBus?: EventBus;
	/** Original interactive CLI args and resolved extension flags to retain in the child. */
	readonly cliArgs?: readonly string[];
	readonly extensionFlags?: ReadonlyMap<string, boolean | string>;
}

/** Start one rpc-ui child and expose its serializable session facade to the foreground TUI. */
export async function createIsolatedInteractiveSession(
	options: IsolatedInteractiveSessionOptions,
): Promise<RemoteAgentSession> {
	const sessionPath = options.sessionPath ?? SessionManager.createEmptySessionFile(options.cwd);
	const command = resolveCliSpawnCmd(["--cwd", options.cwd]);
	const client = new RpcClient({
		command: command.cmd,
		cwd: command.cwd,
		mode: "rpc-ui",
		...(options.provider ? { provider: options.provider } : {}),
		...(options.model ? { model: options.model } : {}),
		args: [
			...buildIsolatedChildArgs(options.cliArgs ?? [], options.extensionFlags),
			"--session",
			sessionPath,
			...(options.apiKey ? ["--api-key", options.apiKey] : []),
		],
	});
	try {
		await client.start();
		return await RemoteAgentSession.connect({
			client,
			cwd: options.cwd,
			sessionManager: await SessionManager.open(sessionPath),
			settings: options.settings,
			modelRegistry: options.modelRegistry,
			eventBus: options.eventBus,
		});
	} catch (error) {
		await client.stop();
		throw error;
	}
}

/** Temporary compatibility bridge while controllers move from AgentSession to InteractiveSessionPort. */
export function asInteractiveSession(session: RemoteAgentSession): AgentSession {
	return session.asAgentSession();
}
