import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelsRoute } from "../src/client/routes/ModelsRoute";
import type { ModelDashboardStats } from "../src/types";

const modelStats: ModelDashboardStats = {
	byModel: [
		{
			model: "tok-model",
			provider: "test-provider",
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
		},
	],
	modelSeries: [],
	modelPerformanceSeries: [],
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
const originalGetContext = new Map<typeof HTMLElement, unknown>();

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

	// Chart.js needs a canvas 2d context; the DOM fixture has none. Provide a
	// minimal no-op context so the ModelShareChart timeline can mount.
	const canvasProto = window.HTMLCanvasElement?.prototype;
	if (canvasProto && !canvasProto.getContext) {
		originalGetContext.set(canvasProto, canvasProto.getContext);
		canvasProto.getContext = () =>
			({
				canvas: { width: 0, height: 0 },
				clearRect: () => {},
				fillRect: () => {},
				beginPath: () => {},
				closePath: () => {},
				stroke: () => {},
				fill: () => {},
				moveTo: () => {},
				lineTo: () => {},
				arc: () => {},
				rect: () => {},
				clip: () => {},
				setTransform: () => {},
				transform: () => {},
				translate: () => {},
				scale: () => {},
				rotate: () => {},
				measureText: () => ({ width: 0 }),
				createLinearGradient: () => ({ addColorStop: () => {} }),
				createRadialGradient: () => ({ addColorStop: () => {} }),
				createPattern: () => null,
				drawImage: () => {},
				getImageData: () => ({ data: [] }),
				putImageData: () => {},
				save: () => {},
				restore: () => {},
				setLineDash: () => {},
				fillText: () => {},
				strokeText: () => {},
			}) as unknown as CanvasRenderingContext2D;
	}
}

function restoreDom(): void {
	for (const [proto, original] of originalGetContext) {
		if (original === undefined) Reflect.deleteProperty(proto, "getContext");
		else proto.getContext = original as typeof proto.getContext;
	}
	originalGetContext.clear();
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originalGlobals.clear();
}

describe("ModelsRoute token totals", () => {
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

	it("displays all token buckets in the model token total", async () => {
		installDom();
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(modelStats));

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(<ModelsRoute active range="30d" refreshTrigger={0} />);
		});
		await act(async () => {
			await Bun.sleep(0);
		});

		const row = Array.from(document.querySelectorAll("div")).find(candidate =>
			candidate.textContent?.includes("tok-model"),
		);
		expect(row).toBeDefined();

		// 100 + 20 + 300 + 40 = 460, not the input+output subset 120.
		expect(row?.textContent).toContain("460");
		expect(row?.textContent).not.toContain("120");
	});
});
