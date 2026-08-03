import { describe, expect, it } from "bun:test";
import { getThemeByName } from "../../src/modes/theme/theme";
import { createCheckpointToolRenderer } from "../../src/tools/checkpoint-renderer";

type CheckpointRendererName = "Checkpoint" | "Rewind";

async function renderResultHeader(name: CheckpointRendererName, isError: boolean) {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected the built-in dark theme");

	const args = name === "Checkpoint" ? { goal: "renderer icon contract" } : { report: "renderer icon contract" };
	const component = createCheckpointToolRenderer(name).renderResult(
		{ content: [{ type: "text", text: "renderer result" }], isError },
		{ expanded: true, isPartial: false },
		theme,
		args,
	);

	return { header: Bun.stripANSI(component.render(120)[0] ?? ""), theme };
}

describe("createCheckpointToolRenderer result icons", () => {
	it("renders Checkpoint success with the standard success glyph instead of the rewind glyph", async () => {
		const { header, theme } = await renderResultHeader("Checkpoint", false);

		expect(header).toContain(theme.status.success);
		expect(header).not.toContain(theme.icon.rewind);
	});

	it("renders successful Rewind with the rewind glyph", async () => {
		const { header, theme } = await renderResultHeader("Rewind", false);

		expect(header).toContain(theme.icon.rewind);
	});

	it.each(["Checkpoint", "Rewind"] as const)("renders %s errors with the error status glyph", async name => {
		const { header, theme } = await renderResultHeader(name, true);

		expect(header).toContain(theme.status.error);
	});
});
