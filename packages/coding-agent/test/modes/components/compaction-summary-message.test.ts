import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
	HandoffSummaryMessageComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/compaction-summary-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function makeHandoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

const STRUCTURED_COMPACTION_SUMMARY = `# Objective

- Keep summary expansion readable.

## Important Details

- Markdown headings must stay visible.
- Short bullets must render clearly.

## Work State

- Component test is the only edited file.

## Next Move

- Run the focused component test.

## Relevant Files

- packages/coding-agent/test/modes/components/compaction-summary-message.test.ts`;

function makeCompactionComponent(expanded: boolean): CompactionSummaryMessageComponent {
	const component = new CompactionSummaryMessageComponent(
		createCompactionSummaryMessage(STRUCTURED_COMPACTION_SUMMARY, 42000, new Date().toISOString()),
	);
	component.setExpanded(expanded);
	return component;
}


describe("handoff summary divider", () => {
	it("renders handoff custom messages with the compact divider instead of a framed block", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage(
				`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
			),
			false,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const collapsed = Bun.stripANSI(component!.render(80).join("\n"));
		expect(collapsed).toContain("handoff");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("[handoff]");
		expect(collapsed).not.toContain("Continue the resize fix");
	});

	it("expands to the handoff document without the provider-only XML wrapper", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage([
				{
					type: "text",
					text: "<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>",
				},
			]),
			true,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const expanded = Bun.stripANSI(component!.render(80).join("\n"));
		expect(expanded).toContain("Handoff context");
		expect(expanded).toContain("Continue the resize fix");
		expect(expanded).not.toContain("<handoff-context>");
		expect(expanded).not.toContain("</handoff-context>");
	});

	it("leaves unrelated custom messages on the generic renderer path", () => {
		const message = makeHandoffMessage("Not a handoff.");
		message.customType = "extension-note";

		expect(createHandoffSummaryMessageComponent(message, false)).toBeUndefined();
	});
});

describe("compaction summary divider", () => {
	it("keeps structured summary body hidden until expanded", () => {
		const collapsed = Bun.stripANSI(makeCompactionComponent(false).render(80).join("\n"));

		expect(collapsed).toContain("compacted");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("Objective");
		expect(collapsed).not.toContain("Keep summary expansion readable");
		expect(collapsed).not.toContain(
			"packages/coding-agent/test/modes/components/compaction-summary-message.test.ts",
		);
	});

	it("expands the fixed Markdown summary structure with headings, bullets, and paths", () => {
		const expanded = Bun.stripANSI(makeCompactionComponent(true).render(140).join("\n"));

		expect(expanded).toContain("compacted");
		expect(expanded).toContain("Objective");
		expect(expanded).toContain("Important Details");
		expect(expanded).toContain("Work State");
		expect(expanded).toContain("Next Move");
		expect(expanded).toContain("Relevant Files");
		expect(expanded).not.toContain("# Objective");
		expect(expanded).not.toContain("## Relevant Files");
		expect(expanded).not.toContain("\n- Keep summary expansion readable.");
		expect(expanded).not.toContain("\n- packages/coding-agent/test/modes/components/compaction-summary-message.test.ts");
		expect(expanded).toContain("Keep summary expansion readable");
		expect(expanded).toContain("Markdown headings must stay visible");
		expect(expanded).toContain("Short bullets must render clearly");
		expect(expanded).toContain("Run the focused component test");
		expect(expanded).toContain(
			"packages/coding-agent/test/modes/components/compaction-summary-message.test.ts",
		);
	});
});
