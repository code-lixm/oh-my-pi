import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let counter = 0;

function makeUserNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${counter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: counter };
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function buildLinearTree(count: number): { tree: SessionTreeNode[]; leafId: string } {
	const root = makeUserNode("node-0");
	let current = root;
	for (let i = 1; i < count; i++) {
		const child = makeUserNode(`node-${i}`, current.entry.id);
		current.children.push(child);
		current = child;
	}
	return { tree: [root], leafId: current.entry.id };
}

function makeSelector(tree: SessionTreeNode[], leafId: string, terminalHeight: number): TreeSelectorComponent {
	return new TreeSelectorComponent(
		tree,
		leafId,
		terminalHeight,
		() => {},
		() => {},
	);
}

function renderStripped(selector: TreeSelectorComponent, width = 120): string[] {
	return selector.render(width).map(line => Bun.stripANSI(line));
}

function visibleTreeRows(lines: readonly string[]): number {
	return lines.filter(line => line.includes("node-")).length;
}

describe("TreeSelectorComponent layout chrome", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	beforeEach(() => {
		counter = 0;
	});

	it("uses every row below the fixed 7-line chrome for the tree viewport instead of a half-screen window", () => {
		const terminalHeight = 24;
		const { tree, leafId } = buildLinearTree(40);
		const lines = renderStripped(makeSelector(tree, leafId, terminalHeight));

		expect(lines).toHaveLength(terminalHeight);
		expect(visibleTreeRows(lines)).toBe(terminalHeight - 7);
	});

	it("renders keyboard hints as two compact rows immediately above the search line", () => {
		const { tree, leafId } = buildLinearTree(4);
		const lines = renderStripped(makeSelector(tree, leafId, 18), 140);

		const primaryHintRow = lines.findIndex(line => line.includes("Shift+Enter") && line.includes("Shift+L"));
		const secondaryHintRow = lines.findIndex(line => line.includes("Ctrl+O") && line.includes("Alt+D/T/U/L/A"));
		const searchRow = lines.findIndex(line => line.includes("Search:"));

		expect(primaryHintRow).toBeGreaterThanOrEqual(0);
		expect(secondaryHintRow).toBe(primaryHintRow + 1);
		expect(searchRow).toBe(secondaryHintRow + 1);
		expect(lines[primaryHintRow]).toContain("Enter");
		expect(lines[primaryHintRow]).not.toContain("Ctrl+O");
		expect(lines[secondaryHintRow]).toContain("Shift+Ctrl+O");
		expect(lines[secondaryHintRow]).not.toContain("Shift+Enter");
	});

	it("shows a non-default filter badge on the search row without stealing a tree row", () => {
		const terminalHeight = 24;
		const { tree, leafId } = buildLinearTree(40);
		const selector = makeSelector(tree, leafId, terminalHeight);

		const defaultLines = renderStripped(selector);
		selector.handleInput("\x0f");
		const noToolsLines = renderStripped(selector);

		const searchRow = noToolsLines.find(line => line.includes("Search:"));

		expect(searchRow).toBeDefined();
		expect(searchRow!).toContain("[no-tools]");
		expect(noToolsLines.filter(line => line.includes("[no-tools]"))).toHaveLength(1);
		expect(visibleTreeRows(defaultLines)).toBe(terminalHeight - 7);
		expect(visibleTreeRows(noToolsLines)).toBe(terminalHeight - 7);
		expect(noToolsLines).toHaveLength(terminalHeight);
	});
});
