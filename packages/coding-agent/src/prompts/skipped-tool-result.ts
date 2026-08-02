import type { SteeringInterruptSource } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { selectPrompt } from "./prompt-locale";
import skippedToolResultTemplate from "./system/skipped-tool-result.md" with { type: "text" };
import skippedToolResultTemplateZh from "./system/skipped-tool-result.zh-CN.md" with { type: "text" };

export function formatSkippedToolResult(source: SteeringInterruptSource | "irc" | undefined): string {
	return prompt
		.render(selectPrompt(skippedToolResultTemplate, skippedToolResultTemplateZh), {
			user: source === "user",
			system: source === "system",
			irc: source === "irc",
		})
		.trim();
}
