import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getOutputBlockBorderStyle, setOutputBlockBorderStyle } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Viewport-repaint seams of ToolExecutionComponent, driven through the public
// ToolRenderer flags (`forceFirstResultViewportRepaint`,
// `forceResultViewportRepaintOnSettle`). The removed ssh tool was the last
// built-in exercising them; custom/extension tool renderers remain consumers
// of the contract, so a synthetic tool stands in.

function toolResult(text: string) {
	return { content: [{ type: "text", text }] };
}

function editArgs() {
	return {
		edits: [
			{ path: "src/alpha.ts", old_text: "export const alpha = 1;", new_text: "export const alpha = 2;" },
			{ path: "src/beta.ts", old_text: "export const beta = 1;", new_text: "export const beta = 2;" },
		],
	};
}

function editResult(perFileResults: Array<{ path: string; diff: string; oldText: string; newText: string }>) {
	return {
		content: [{ type: "text", text: "edited" }],
		details: { perFileResults },
	};
}

function editPerFile(path: string, before: string, after: string) {
	return {
		path,
		diff: [`-1|${before}`, `+1|${after}`].join("\n"),
		oldText: `${before}\n`,
		newText: `${after}\n`,
	};
}

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

// The repaint flag stays armed for any streamed-args shape (raw JSON buffer
// present), while the visible label upgrades to parsed chrome as soon as a
// concrete field lands — mirroring how the removed ssh renderer behaved.
function hasStreamedArgs(args: unknown): boolean {
	return !!args && typeof args === "object" && "__partialJson" in args;
}

function isPlaceholderArgs(args: unknown): boolean {
	return hasStreamedArgs(args) && !(args && typeof args === "object" && "host" in args);
}

/** Synthetic renderer-bearing tool; cast is the test seam for the renderer contract. */
function makeFakeTool(): AgentTool {
	const tool = {
		name: "fake_device",
		label: "Fake",
		renderCall: (args: unknown) => new Text(isPlaceholderArgs(args) ? "FAKE: […]" : "FAKE: [router]", 0, 0),
		renderResult: (result: { content: Array<{ type: string; text?: string }> }, options: { isPartial: boolean }) => {
			const text = result.content[0]?.text ?? "";
			return new Text(options.isPartial ? `provisional ${text}` : `Output ${text}`, 0, 0);
		},
		forceFirstResultViewportRepaint: (args: unknown) => hasStreamedArgs(args),
		forceResultViewportRepaintOnSettle: true,
	};
	return tool as unknown as AgentTool;
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

describe("ToolExecutionComponent custom-renderer repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("fake_device", args, {}, makeFakeTool(), ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	function makeEditComponent() {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("edit", editArgs(), {}, undefined, ui);
		components.push(component);
		component.setArgsComplete();
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("repaints once when a painted provisional multi-file edit result settles with leading accent padding", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		try {
			setOutputBlockBorderStyle("accent");
			const { component, resetDisplay } = makeEditComponent();
			const partial = editResult([
				editPerFile("src/alpha.ts", "export const alpha = 1;", "export const alpha = 2;"),
			]);
			const final = editResult([
				editPerFile("src/alpha.ts", "export const alpha = 1;", "export const alpha = 2;"),
				editPerFile("src/beta.ts", "export const beta = 1;", "export const beta = 2;"),
			]);

			component.updateResult(partial, true);
			const partialRows = plainRows(component.render(100));
			expect(partialRows.some(row => row.includes("Edit:") && row.includes("src/alpha.ts"))).toBe(true);
			expect(partialRows.some(row => row.includes("1 more file pending"))).toBe(true);

			component.updateResult(final, false);

			expect(resetDisplay).toHaveBeenCalledTimes(1);
			const finalRows = plainRows(component.render(100));
			expect(finalRows[0]?.trim()).toBe("▌");
			const firstSemanticRowIndex = finalRows.findIndex(row => row.trim() !== "" && row.trim() !== "▌");
			expect(firstSemanticRowIndex).toBeGreaterThan(0);
			const firstSemanticRow = finalRows[firstSemanticRowIndex];
			expect(firstSemanticRow).toContain("Edit:");
			expect(firstSemanticRow).toContain("src/alpha.ts");
			expect(finalRows.some(row => row.includes("Edit:") && row.includes("src/beta.ts"))).toBe(true);
			expect(finalRows.some(row => row.includes("1 more file pending"))).toBe(false);
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("does not repaint when the provisional multi-file edit result never reaches the terminal", () => {
		const previousBorderStyle = getOutputBlockBorderStyle();
		try {
			setOutputBlockBorderStyle("accent");
			const { component, resetDisplay } = makeEditComponent();

			component.updateResult(
				editResult([editPerFile("src/alpha.ts", "export const alpha = 1;", "export const alpha = 2;")]),
				true,
			);
			component.updateResult(
				editResult([
					editPerFile("src/alpha.ts", "export const alpha = 1;", "export const alpha = 2;"),
					editPerFile("src/beta.ts", "export const beta = 1;", "export const beta = 2;"),
				]),
				false,
			);

			expect(resetDisplay).not.toHaveBeenCalled();
		} finally {
			setOutputBlockBorderStyle(previousBorderStyle);
		}
	});

	it("forces a viewport repaint when a painted streamed placeholder receives its first result", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// The placeholder shape was built in memory but never painted — a
		// resetDisplay here would wipe scrollback for a shape the user never saw.

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint complete args on the first result", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional partial result settles", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no reset should fire.

		component.updateResult(toolResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes streamed placeholder rows from the terminal buffer when the first result arrives", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ __partialJson: '{"host"' },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("FAKE: […]"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("FAKE: […]"))).toBe(false);
			expect(rows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("removes provisional partial chrome from the terminal buffer when the result settles", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ host: "router", command: "uptime" },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			expect(partialRows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(partialRows.some(row => row.includes("provisional partial output"))).toBe(true);

			component.updateResult(toolResult("final output"), false);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(false);
			expect(rows.filter(row => row.includes("FAKE: [router]"))).toHaveLength(1);
			expect(rows.some(row => row.includes("Output final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
