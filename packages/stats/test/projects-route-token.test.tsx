import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectsRoute } from "../src/client/routes/ProjectsRoute";

const folderStats = {
	folder: "/project",
	totalRequests: 1,
	successfulRequests: 1,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 100,
	totalOutputTokens: 20,
	totalCacheReadTokens: 300,
	totalCacheWriteTokens: 40,
	cacheRate: 0.75,
	totalCost: 0,
	totalPremiumRequests: 0,
	avgDuration: 1000,
	avgTtft: 100,
	avgTokensPerSecond: 20,
	firstTimestamp: 1,
	lastTimestamp: 1,
};

type FetchSpy = {
	mockRestore(): void;
};

const GLOBAL_KEYS = [
	"window",
	"document",
	"Node",
	"Element",
	"HTMLElement",
	"HTMLIFrameElement",
	"SVGElement",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): void {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const key of GLOBAL_KEYS) originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.assign(globalThis, {
		window,
		document: window.document,
		Node: window.Node,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		HTMLIFrameElement: window.HTMLIFrameElement,
		SVGElement: window.SVGElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function restoreDom(): void {
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originalGlobals.clear();
}

describe("ProjectsRoute token totals", () => {
	let root: Root | undefined;
	let container: HTMLDivElement | undefined;
	let fetchSpy: FetchSpy | undefined;

	afterEach(async () => {
		if (root) {
			const activeRoot = root;
			root = undefined;
			await act(async () => activeRoot.unmount());
		}
		container?.remove();
		container = undefined;
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
		restoreDom();
	});

	it("displays all token buckets in the project total", async () => {
		installDom();
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([folderStats]));

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(<ProjectsRoute active range="30d" refreshTrigger={0} />);
		});
		await act(async () => {
			await Bun.sleep(0);
		});

		const row = Array.from(document.querySelectorAll("tr")).find(candidate =>
			candidate.textContent?.includes("/project"),
		);
		expect(row).toBeDefined();

		const tokensCell = row?.querySelectorAll("td")[3];
		expect(tokensCell?.textContent).toContain("460");
		expect(tokensCell?.textContent).not.toContain("120");
	});
});
