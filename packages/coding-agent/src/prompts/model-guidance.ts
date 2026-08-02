import { modelPromptPolicy } from "../task/prompt-policy";
import { selectPrompt } from "./prompt-locale";
import claudeGuidance from "./system/model-guidance/claude.md" with { type: "text" };
import claudeGuidanceZh from "./system/model-guidance/claude.zh-CN.md" with { type: "text" };
import codexGuidance from "./system/model-guidance/codex.md" with { type: "text" };
import codexGuidanceZh from "./system/model-guidance/codex.zh-CN.md" with { type: "text" };

export function selectModelGuidance(modelId: string | undefined): string | undefined {
	switch (modelPromptPolicy(modelId)) {
		case "codex":
			return selectPrompt(codexGuidance, codexGuidanceZh);
		case "claude":
			return selectPrompt(claudeGuidance, claudeGuidanceZh);
		default:
			return undefined;
	}
}
