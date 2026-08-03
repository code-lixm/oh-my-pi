import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import { selectPrompt } from "../prompts/prompt-locale";
import nextStepOfferDescription from "../prompts/tools/next-step-offer.md" with { type: "text" };
import nextStepOfferDescriptionZh from "../prompts/tools/next-step-offer.zh-CN.md" with { type: "text" };
import { getNextStepOfferStore, type NextStepOffer, type NextStepOfferStore } from "../session/next-step-offers";
import type { ToolSession } from ".";

const nextStepOfferItemSchema = type({
	id: type("string").describe("stable kebab-case offer id"),
	label: type("string").describe("concise user-visible next action"),
	"description?": type("string").describe("optional context for this action"),
	requiresConfirmation: type("boolean").describe("whether the eventual action still requires user confirmation"),
});

const nextStepOfferSchema = type({
	offers: nextStepOfferItemSchema.array().atLeastLength(1).describe("one to three structured next-step choices"),
});

export type NextStepOfferToolParams = typeof nextStepOfferSchema.infer;

function branchAnchor(session: ToolSession): string {
	const entries = session.sessionManager?.getBranch() ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message") return entry.id;
	}
	return entries.at(-1)?.id ?? "";
}

/** Records structured handoff choices; it never performs a suggested action. */
export class NextStepOfferTool implements AgentTool<typeof nextStepOfferSchema> {
	readonly name = "next_step_offer";
	readonly approval = "write" as const;
	readonly label = "Next Step Offer";
	readonly description = selectPrompt(nextStepOfferDescription, nextStepOfferDescriptionZh);
	readonly parameters = nextStepOfferSchema;
	readonly strict = true;
	readonly summary = "Record structured next-step offers for the current final response";
	readonly #store: NextStepOfferStore;

	private constructor(session: ToolSession) {
		const sessionManager = session.sessionManager;
		if (!sessionManager) throw new Error("Next-step offers require a session manager.");
		this.#store = getNextStepOfferStore({
			sessionManager,
			getIdentity: () => ({
				sessionId: session.getSessionId?.() ?? "",
				branchId: branchAnchor(session),
				modelId: session.getActiveModelString?.() ?? "",
			}),
		});
	}

	static createIf(session: ToolSession): NextStepOfferTool | null {
		if (session.settings.get("communication.nextSteps") !== "auto" || !session.sessionManager) return null;
		return new NextStepOfferTool(session);
	}

	async execute(_id: string, params: NextStepOfferToolParams): Promise<AgentToolResult> {
		const offers = params.offers as NextStepOffer[];
		this.#store.stageOffers(offers);
		return {
			content: [
				{ type: "text", text: "Structured next-step offers recorded for this response; no action was executed." },
			],
			details: { offers },
		};
	}
}
