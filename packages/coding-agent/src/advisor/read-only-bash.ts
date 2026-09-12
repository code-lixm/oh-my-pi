import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { tSettingsUi } from "../i18n/settings-locale";
import { isReadOnlyBashCommand } from "../tools/bash-readonly";

/**
 * Narrow a granted `bash` tool for an advisor to provably read-only command
 * lines.
 *
 * The advisor is a reviewer: its lane is observation, and a shell write would
 * land with none of the main agent's intent or user confirmation. Rather than
 * withholding `bash` entirely (which also loses `git log`, `ls`, `cat`), every
 * non-read-only line is rejected in-band with a tool error the advisor can
 * learn from. {@link isReadOnlyBashCommand} fails closed, so an unmodeled
 * command is rejected instead of run.
 *
 * Other tools pass through untouched: this narrows the shell, it does not
 * replace the session's approval gate.
 */
export function withReadOnlyBashTool<T extends AgentTool<any>>(tool: T): T {
	if (tool.name !== "bash") return tool;
	return new Proxy(tool, {
		get: (target, prop) => {
			if (prop !== "execute") return target[prop as keyof T];
			return async (
				toolCallId: string,
				args: unknown,
				signal: AbortSignal | undefined,
				onUpdate: never,
				ctx: never,
			) => {
				const rawCommand = (args as { command?: unknown } | undefined)?.command;
				const command = typeof rawCommand === "string" ? rawCommand : "";
				if (!isReadOnlyBashCommand(command)) {
					return {
						content: [
							{
								type: "text" as const,
								text: tSettingsUi("Advisor bash is read-only; this command was not run: {command}", {
									command: command || tSettingsUi("(missing)"),
								}),
							},
						],
						isError: true,
					};
				}
				return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
			};
		},
	}) as T;
}
