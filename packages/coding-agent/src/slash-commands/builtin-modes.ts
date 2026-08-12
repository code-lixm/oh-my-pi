import * as path from "node:path";
import type { AutonomousController } from "../autonomous/controller";
import type { AutonomousStatus } from "../autonomous/types";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import type { SettingPath } from "../config/settings";
import { tSettingsUi } from "../i18n/settings-locale";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		if (!submitted && ((runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0)) {
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** Detailed, session-effective `/computer status` diagnostics. */
async function formatComputerUseStatus(session: AgentSession): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEnabledToolNames().includes("computer");
	const model = session.model;
	const modelName = model ? formatModelString(model) : "none";
	const exposure = !enabled
		? "not exposed (disabled)"
		: !active
			? "not exposed (tool inactive)"
			: computerExposureMode(model);
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	const computerTool = active
		? (session.getToolByName("computer") as Pick<ComputerTool, "capabilities"> | undefined)
		: undefined;
	const capabilities = await computerTool?.capabilities();
	const capabilityStatus = capabilities
		? [
				`backend=${capabilities.backend}${capabilities.displayServer ? `/${capabilities.displayServer}` : ""}`,
				`capture=${capabilities.capture} (${capabilities.capturePermission})`,
				`input=${capabilities.input} (${capabilities.inputPermission})`,
				`ax=${capabilities.ax} (${capabilities.axPermission})`,
				`backgroundWindowInput=${capabilities.backgroundWindowInput}`,
				`deliveryModes=${capabilities.deliveryModes.join(",") || "none"}`,
			].join(", ")
		: "session not started";
	return [
		`Computer use: ${enabled ? "enabled" : "disabled"}`,
		`tool: ${active ? "active" : "inactive"}`,
		`exposure: ${exposure}`,
		`model: ${modelName}`,
		`configured: display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
		`capabilities: ${capabilityStatus}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle: flip the active tool slate first
 * (so a failed enable never leaves a stale settings override), then record the
 * runtime override — never `settings.set`, which would persist to settings.json.
 * Returns the operator feedback line.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const applied = await session.setComputerToolEnabled(enable);
	if (enable && !applied) {
		return "Computer use is unavailable in this session.";
	}
	session.settings.override("computer.enabled", enable);
	return enable
		? `Computer use enabled for this session. ${await formatComputerUseStatus(session)}`
		: "Computer use disabled for this session.";
}

/** Session-effective `/vision status` line. */
function formatVisionStatus(session: AgentSession): string {
	const { mode, active, model } = session.inspectImageState();
	const override = session.getInspectImageModeOverride();
	const modelObj = session.model;
	const capability = modelObj
		? modelObj.input.includes("image")
			? tSettingsUi("native image input")
			: tSettingsUi("no native image input")
		: tSettingsUi("no active model");
	return [
		tSettingsUi("inspect_image: {status}", { status: tSettingsUi(active ? "active" : "inactive") }),
		override ? tSettingsUi("mode: {mode} (session override)", { mode }) : tSettingsUi("mode: {mode}", { mode }),
		...(override ? [tSettingsUi("configured: {mode}", { mode: session.settings.get("inspect_image.mode") })] : []),
		tSettingsUi("model: {model} ({capability})", { model: model ?? tSettingsUi("none"), capability }),
	].join(" · ");
}

/** Applies a `/vision` mode for this session and returns the operator feedback line. */
async function applyVisionMode(session: AgentSession, mode: InspectImageMode): Promise<string> {
	const applied = await session.setInspectImageMode(mode);
	if (!applied) {
		return tSettingsUi("inspect_image is unavailable in this session.");
	}
	return tSettingsUi("Vision mode: {mode}. {status}", { mode, status: formatVisionStatus(session) });
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

interface AutonomousControllerSession {
	getAutonomousController?(): AutonomousController | undefined;
}

function getAutonomousController(session: AgentSession): AutonomousController | undefined {
	return (session as unknown as AutonomousControllerSession).getAutonomousController?.();
}

function formatAutonomousStatus(status: AutonomousStatus): string {
	const limits = status.limits;
	const gateSummary = status.gates.commands.length > 0 ? status.gates.commands.join("; ") : tSettingsUi("none");
	const failure = status.lastGateFailure
		? tSettingsUi("Last gate failure: {command} ({exitText}, attempt {attempt}/{maxRetries}).", {
				command: status.lastGateFailure.command,
				exitText: status.lastGateFailure.exitText,
				attempt: status.lastGateFailure.attempt,
				maxRetries: status.gates.maxRetries,
			})
		: tSettingsUi("Last gate failure: none.");
	return [
		tSettingsUi("Autonomous mode is {status}.", {
			status: tSettingsUi(status.enabled ? "enabled" : "disabled"),
		}),
		tSettingsUi(
			"Continuations: {continuations}/{maxContinuations}; turns: {turns}/{maxTurns}; tokens: {tokens}/{maxTokens}.",
			{
				continuations: status.continuationsUsed,
				maxContinuations: limits.maxContinuations,
				turns: status.turnsUsed,
				maxTurns: limits.maxTurns,
				tokens: formatTokenCount(status.tokensUsed),
				maxTokens: formatTokenCount(limits.maxTokens),
			},
		),
		tSettingsUi("Timeout: {timeoutMs}ms; gates: {gates}.", {
			timeoutMs: limits.timeoutMs,
			gates: gateSummary,
		}),
		failure,
	].join("\n");
}

function parseAutonomousCommandText(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		(trimmed.startsWith('"') || trimmed.startsWith("'")) &&
		trimmed.at(0) === trimmed.at(-1)
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function handleAutonomousCommand(session: AgentSession, args: string): string {
	const controller = getAutonomousController(session);
	if (!controller)
		return tSettingsUi("Autonomous mode is not available yet. It will be enabled after integration wiring.");

	const { verb, rest } = parseSubcommand(args);
	try {
		if (!verb || verb === "status") return formatAutonomousStatus(controller.status());
		if (verb === "on") {
			const gateCommand = parseAutonomousCommandText(rest);
			if (gateCommand) controller.configure({ gates: { commands: [gateCommand] } });
			controller.setEnabled(true);
			return gateCommand
				? tSettingsUi("Autonomous mode enabled with quality gate: {command}.", { command: gateCommand })
				: tSettingsUi("Autonomous mode enabled.");
		}
		if (verb === "off") {
			controller.setEnabled(false);
			return tSettingsUi("Autonomous mode disabled.");
		}
		if (verb === "gate") {
			const { verb: action, rest: commandText } = parseSubcommand(rest);
			if (action === "clear" && !commandText) {
				controller.configure({ gates: { commands: [] } });
				return tSettingsUi("Autonomous quality gates cleared.");
			}
			if (action === "add") {
				const command = parseAutonomousCommandText(commandText);
				if (!command) return tSettingsUi("Usage: /autonomous gate add <command>");
				const commands = controller.status().gates.commands;
				controller.configure({ gates: { commands: [...commands, command] } });
				return tSettingsUi("Autonomous quality gate added: {command}.", { command });
			}
		}
		if (verb === "budget") {
			const { verb: budgetType, rest: valueText } = parseSubcommand(rest);
			const parsedBudget = Number(valueText.trim());
			const value = Number.isSafeInteger(parsedBudget) && parsedBudget > 0 ? parsedBudget : undefined;
			if (!value)
				return tSettingsUi("Usage: /autonomous budget <continuations|turns|tokens|time> <positive integer>");
			if (budgetType === "continuations") controller.configure({ maxContinuations: value });
			else if (budgetType === "turns") controller.configure({ maxTurns: value });
			else if (budgetType === "tokens") controller.configure({ maxTokens: value });
			else if (budgetType === "time") controller.configure({ timeoutMs: value });
			else return tSettingsUi("Usage: /autonomous budget <continuations|turns|tokens|time> <positive integer>");
			return tSettingsUi("Autonomous {budgetType} budget set to {value}.", { budgetType, value });
		}
		return tSettingsUi(
			"Usage: /autonomous [on [gate-command]|off|status|gate add <command>|gate clear|budget <continuations|turns|tokens|time> <n>]",
		);
	} catch (error) {
		return tSettingsUi("Unable to configure autonomous mode: {error}", { error: errorMessage(error) });
	}
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		description: "Plan, run, inspect, import, and compare OMP-native security scans",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "Create an immutable security scan plan" },
			{ name: "scan", description: "Start a planned or newly planned native scan" },
			{ name: "status", description: "Show native scan operation status" },
			{ name: "cancel", description: "Cancel a running native scan" },
			{ name: "scans", description: "List stored project security scans" },
			{ name: "show", description: "Render a scan or security:// resource" },
			{ name: "import", description: "Import SARIF or a Codex Security bundle" },
			{ name: "export", description: "Export a canonical bundle, SARIF, or report" },
			{ name: "validate", description: "Validate one finding with OMP-native tools" },
			{ name: "compare", description: "Compare finding lineage across two scans" },
			{ name: "disposition", description: "Set a finding disposition with rationale" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		description: "Open settings menu",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "history",
		description: "View session history",
		handleTui: (_command, runtime) => {
			runtime.ctx.editor.setText("");
			runtime.ctx.showSessionHistory();
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: "Open provider setup",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`Usage: /${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return tSettingsUi("Plan: disabled in settings");
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return planFile
					? tSettingsUi("Plan: on ({file})", { file: path.basename(planFile) })
					: tSettingsUi("Plan: on");
			}
			if (runtime.ctx.goalModeEnabled) return tSettingsUi("Plan: blocked by goal mode");
			return tSettingsUi("Plan: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled
				? tSettingsUi("Plan review: available")
				: tSettingsUi("Plan review: plan mode inactive"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return tSettingsUi("Vibe: on");
			if (runtime.ctx.planModeEnabled) return tSettingsUi("Vibe: blocked by plan mode");
			if (runtime.ctx.goalModeEnabled) return tSettingsUi("Vibe: blocked by goal mode");
			return tSettingsUi("Vibe: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
			{ name: "budget", description: "Adjust the token budget", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return tSettingsUi("Goal: disabled in settings");
			if (runtime.ctx.planModeEnabled) return tSettingsUi("Goal: blocked by plan mode");
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? tSettingsUi("Goal: {status} ({detail})", {
						status: state.goal.status,
						detail: shortDetail(state.goal.objective),
					})
				: tSettingsUi("Goal: off");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "autonomous",
		description: "Control host-owned autonomous continuation and quality gates",
		acpDescription: "Control autonomous continuation",
		acpInputHint: "[on [gate-command]|off|status|gate|budget]",
		subcommands: [
			{ name: "on", description: "Enable autonomous continuation", usage: "[gate-command]" },
			{ name: "off", description: "Disable autonomous continuation" },
			{ name: "status", description: "Show autonomous budgets and gate status" },
			{ name: "gate", description: "Add or clear quality gates", usage: "<add <command>|clear>" },
			{ name: "budget", description: "Set a continuation, turn, token, or time budget", usage: "<type> <n>" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const controller = getAutonomousController(runtime.ctx.session);
			if (!controller) return tSettingsUi("Autonomous: unavailable");
			return tSettingsUi("Autonomous: {status}", {
				status: tSettingsUi(controller.status().enabled ? "on" : "off"),
			});
		},
		handle: async (command, runtime) => {
			await runtime.output(handleAutonomousCommand(runtime.session, command.args));
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			runtime.ctx.showStatus(handleAutonomousCommand(runtime.ctx.session, command.args));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "guided-goal",
		description: "Have the agent interview you in chat, then set up goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return tSettingsUi("Loop: off");
			if (runtime.ctx.loopModePaused) return tSettingsUi("Loop: paused");
			if (runtime.ctx.loopLimit)
				return tSettingsUi("Loop: on ({detail})", { detail: describeLoopLimitRuntime(runtime.ctx.loopLimit) });
			if (runtime.ctx.loopPrompt) return tSettingsUi("Loop: on (repeating prompt)");
			return tSettingsUi("Loop: on (waiting for next prompt)");
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model
				? tSettingsUi("Model: {provider}/{id}", { provider: model.provider, id: model.id })
				: tSettingsUi("Model: none selected");
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		description: "Switch model for this session (same as alt+p)",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model
				? tSettingsUi("Model: {provider}/{id}", { provider: model.provider, id: model.id })
				: tSettingsUi("Model: none selected");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable fast mode" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "status", description: "Show fast mode status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			tSettingsUi("Fast: {status}", { status: formatFastModeStatus(runtime.ctx.session) }),
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("Fast mode disabled.");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`Fast mode is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`Fast mode ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? "Fast mode enabled." : "Fast mode is unavailable for the current model.",
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("Fast mode disabled.");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`Fast mode is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		description: "Toggle the native computer-use tool for this session",
		acpDescription: "Toggle computer use",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "Enable computer use for this session" },
			{ name: "off", description: "Disable computer use for this session" },
			{ name: "status", description: "Show computer use status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`Computer: ${runtime.ctx.session.settings.get("computer.enabled") ? "on" : "off"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(await formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("Usage: /computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(await formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /computer [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vision",
		description: "Control the inspect_image vision-delegation tool for this session",
		acpDescription: "Toggle vision delegation",
		acpInputHint: "[on|off|auto|status]",
		subcommands: [
			{ name: "on", description: "Always expose inspect_image this session" },
			{ name: "off", description: "Never expose inspect_image this session" },
			{ name: "auto", description: "Follow inspect_image.mode (auto hides it for vision-capable models)" },
			{ name: "status", description: "Show inspect_image status" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			tSettingsUi("Vision: {mode}", { mode: runtime.ctx.session.inspectImageState().mode }),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatVisionStatus(runtime.session));
				return commandConsumed();
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				await runtime.output(await applyVisionMode(runtime.session, arg));
				return commandConsumed();
			}
			return usage(tSettingsUi("Usage: /vision [on|off|auto|status]"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatVisionStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				runtime.ctx.showStatus(await applyVisionMode(runtime.ctx.session, arg));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus(tSettingsUi("Usage: /vision [on|off|auto|status]"));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		description: "Switch to a fast/cheap model at the next action (works even without --prewalk)",
		acpDescription: "Prewalk at the next action",
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? `Model "${rolePattern}" not found`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`No API key for ${resolved.model.provider}/${resolved.model.id}`, runtime);
			}
			const armed = runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk on: switching to ${resolved.model.provider}/${resolved.model.id} at the next edit/write (todo-gated).`,
				);
			}
			return commandConsumed();
		},
	},
];
