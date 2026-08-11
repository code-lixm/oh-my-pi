import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { tSettingsUi } from "../i18n/settings-locale";
import type { RefinementController } from "../prime-integration/contracts";
import { selectPrompt } from "../prompts/prompt-locale";
import refineToolDescription from "../prompts/refinement/refine-tool.md" with { type: "text" };
import refineToolDescriptionZh from "../prompts/refinement/refine-tool.zh-CN.md" with { type: "text" };

const refineSchema = type({
	"op?": type("'refine' | 'rollback' | 'status'").describe("refinement operation"),
	"instructions?": type("string").describe("refinement instructions"),
	"resultId?": type("string").describe("result ID for rollback"),
	"scope?": type("'local' | 'global'").describe("harness scope"),
});

interface RefineToolInput {
	op?: "refine" | "rollback" | "status";
	instructions?: string;
	resultId?: string;
	scope?: "local" | "global";
}

export interface RefineToolDetails {
	scheduled: boolean;
	requestId: string;
	message: string;
}

export class RefineTool implements AgentTool<typeof refineSchema, RefineToolDetails> {
	readonly name = "refine";
	readonly label = "Refine";
	readonly description = selectPrompt(refineToolDescription, refineToolDescriptionZh);
	readonly parameters = refineSchema;

	readonly #getController: () => RefinementController | undefined;
	readonly #isEnabled: () => boolean;

	constructor(getController: () => RefinementController | undefined, isEnabled: () => boolean = () => true) {
		this.#getController = getController;
		this.#isEnabled = isEnabled;
	}

	async execute(
		_toolCallId: string,
		params: RefineToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<RefineToolDetails>> {
		if (!this.#isEnabled()) {
			return {
				content: [{ type: "text", text: tSettingsUi("Continual harness refinement is disabled or unavailable.") }],
			};
		}
		const controller = this.#getController();
		if (!controller) {
			return {
				content: [{ type: "text", text: tSettingsUi("Continual harness refinement is disabled or unavailable.") }],
			};
		}

		const op = params.op ?? "refine";
		const scope = params.scope;
		if (op === "rollback") {
			if (!params.resultId) throw new Error(tSettingsUi("resultId is required for rollback"));
			const { requestId } = controller.scheduleRollback(params.resultId, scope);
			const message = tSettingsUi("Rollback of refinement {resultId} scheduled for the next idle boundary.", {
				resultId: params.resultId,
			});
			return {
				content: [{ type: "text", text: message }],
				details: { scheduled: true, requestId, message },
			};
		}

		if (op === "status") {
			const state = await controller.getState();
			const counts = (Object.keys(state.entries) as Array<keyof typeof state.entries>)
				.map(kind =>
					tSettingsUi("{kind}={count}", {
						kind: tSettingsUi(kind),
						count: Object.keys(state.entries[kind]).length,
					}),
				)
				.join(" ");
			return { content: [{ type: "text", text: tSettingsUi("Continual harness: {counts}", { counts }) }] };
		}

		const { requestId } = controller.scheduleRefinement({ instructions: params.instructions, scope });
		const message = tSettingsUi("Refinement scheduled. It will run at the next idle boundary.");
		return { content: [{ type: "text", text: message }], details: { scheduled: true, requestId, message } };
	}
}
