import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import * as syncApi from "../src/client/api.ts";
import { SyncButton } from "../src/client/app/SyncButton.tsx";
import { CATALOGS, t, tp } from "../src/client/locale/catalog.ts";
import type { Locale } from "../src/client/useLocale.ts";
import { DEFAULT_LOCALE, getLocale, SUPPORTED_LOCALES, setLocale, useLocale } from "../src/client/useLocale.ts";

type DomHarness = {
	document: Document;
	localStorage: Storage;
	window: Window & typeof globalThis;
	restore(): void;
};

interface ResolutionProbeResult {
	locale: Locale;
	lang: string;
	supported: Locale[];
}

const STORAGE_KEY = "omp-stats-locale";
const USE_LOCALE_MODULE_URL = new URL("../src/client/useLocale.ts", import.meta.url).href;
const GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"self",
	"location",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"Event",
	"CustomEvent",
	"DocumentFragment",
	"SVGElement",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
type GlobalKey = (typeof GLOBAL_KEYS)[number];

let activeRoot: Root | null = null;

function createMemoryStorage(seed?: Record<string, string>): Storage {
	const data = new Map(Object.entries(seed ?? {}));
	return {
		get length() {
			return data.size;
		},
		clear() {
			data.clear();
		},
		getItem(key) {
			return data.has(key) ? (data.get(key) ?? null) : null;
		},
		key(index) {
			return [...data.keys()][index] ?? null;
		},
		removeItem(key) {
			data.delete(key);
		},
		setItem(key, value) {
			data.set(key, String(value));
		},
	} satisfies Storage;
}

function installDom(browserLanguage: string, seedStorage?: Record<string, string>): DomHarness {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const localStorage = createMemoryStorage(seedStorage);
	const navigatorValue = Object.create(window.navigator) as Navigator;
	const previous: Partial<Record<GlobalKey, PropertyDescriptor>> = {};
	const missing: Partial<Record<GlobalKey, true>> = {};

	Object.defineProperty(navigatorValue, "language", {
		configurable: true,
		value: browserLanguage,
	});
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: localStorage,
	});

	const installGlobal = (key: GlobalKey, value: unknown) => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor) previous[key] = descriptor;
		else missing[key] = true;
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	};

	installGlobal("window", window);
	installGlobal("document", window.document);
	installGlobal("navigator", navigatorValue);
	installGlobal("localStorage", localStorage);
	installGlobal("self", window);
	installGlobal("location", window.location);
	installGlobal("HTMLElement", window.HTMLElement);
	installGlobal("Element", window.Element);
	installGlobal("Node", window.Node);
	installGlobal("Text", window.Text);
	installGlobal("Event", window.Event);
	installGlobal("CustomEvent", window.CustomEvent);
	installGlobal("DocumentFragment", window.DocumentFragment);
	installGlobal("SVGElement", window.SVGElement);
	installGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	});
	installGlobal("cancelAnimationFrame", () => {});
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

	return {
		document: window.document,
		localStorage,
		window: window as Window & typeof globalThis,
		restore() {
			for (const key of [...GLOBAL_KEYS].reverse()) {
				const descriptor = previous[key];
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else if (missing[key]) delete (globalThis as Record<string, unknown>)[key];
			}
		},
	};
}

function runResolutionProbe(browserLanguage: string, storedValue?: string): ResolutionProbeResult {
	const seedEntries = storedValue === undefined ? [] : [[STORAGE_KEY, storedValue]];
	const script = `
		import { parseHTML } from "linkedom";
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const localStorageData = new Map(${JSON.stringify(seedEntries)});
		const localStorage = {
			getItem(key) { return localStorageData.has(key) ? localStorageData.get(key) : null; },
			setItem(key, value) { localStorageData.set(key, String(value)); },
			removeItem(key) { localStorageData.delete(key); },
			clear() { localStorageData.clear(); },
			key(index) { return [...localStorageData.keys()][index] ?? null; },
			get length() { return localStorageData.size; },
		};
		const navigatorValue = Object.create(window.navigator);
		Object.defineProperty(navigatorValue, "language", { configurable: true, value: ${JSON.stringify(browserLanguage)} });
		Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
		for (const [key, value] of Object.entries({
			window,
			document: window.document,
			navigator: navigatorValue,
			localStorage,
			self: window,
			location: window.location,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			Text: window.Text,
			Event: window.Event,
			CustomEvent: window.CustomEvent,
			DocumentFragment: window.DocumentFragment,
			SVGElement: window.SVGElement,
		})) {
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		// Dynamic import is required here: this probe must evaluate useLocale after browser globals are installed.
		const mod = await import(${JSON.stringify(USE_LOCALE_MODULE_URL)});
		console.log(JSON.stringify({
			locale: mod.getLocale(),
			lang: document.documentElement.lang,
			supported: [...mod.SUPPORTED_LOCALES],
		}));
	`;
	const result = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	if (result.exitCode !== 0) {
		throw new Error(stderr || stdout || `locale resolution probe failed with exit code ${result.exitCode}`);
	}
	return JSON.parse(stdout) as ResolutionProbeResult;
}

function resetRuntimeLocale(next: Locale, localStorage: Storage): void {
	if (getLocale() === next) {
		setLocale(next === "en" ? "zh-CN" : "en");
	}
	setLocale(next);
	localStorage.clear();
}

async function click(button: Element, window: Window): Promise<void> {
	await act(async () => {
		button.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
}

async function mount(element: ReactElement, document: Document): Promise<Element> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	activeRoot = createRoot(container);
	await act(async () => {
		activeRoot?.render(element);
	});
	return container;
}

async function unmountActiveRoot(): Promise<void> {
	if (!activeRoot) return;
	const root = activeRoot;
	activeRoot = null;
	await act(async () => {
		root.unmount();
	});
}

describe("stats client locale resolution", () => {
	it("prefers a persisted supported locale over the browser language on first load", () => {
		const result = runResolutionProbe("en-US", "zh-CN");
		expect(result.supported).toEqual(["en", "zh-CN"] satisfies Locale[]);
		expect(result.locale).toBe("zh-CN");
		expect(result.lang).toBe("zh-CN");
	});

	it("ignores empty or unsupported persisted overrides so zh browsers still resolve to zh-CN", () => {
		for (const storedValue of ["", "fr-FR"]) {
			const result = runResolutionProbe("zh-TW", storedValue);
			expect(result.locale).toBe("zh-CN");
			expect(result.lang).toBe("zh-CN");
		}
	});
});

describe("stats client locale runtime behavior", () => {
	let dom: DomHarness;

	beforeAll(() => {
		dom = installDom("en-US");
		resetRuntimeLocale("en", dom.localStorage);
	});

	afterAll(async () => {
		await unmountActiveRoot();
		dom.restore();
	});

	beforeEach(() => {
		resetRuntimeLocale("en", dom.localStorage);
		dom.document.body.innerHTML = "";
	});

	afterEach(async () => {
		await unmountActiveRoot();
		dom.document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("defaults to English copy, pluralizes and interpolates correctly, and falls back to English when a zh key is missing", () => {
		expect(DEFAULT_LOCALE).toBe("en");
		expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN"] satisfies Locale[]);
		expect(getLocale()).toBe(DEFAULT_LOCALE);
		expect(t("syncButton.idle")).toBe("Sync DB");
		expect(tp("syncButton.success.singular", "syncButton.success.plural", 1)).toBe("Synced: 1 new request found.");
		expect(tp("syncButton.success.singular", "syncButton.success.plural", 2)).toBe("Synced: 2 new requests found.");

		setLocale("zh-CN");
		expect(t("syncButton.idle")).toBe("同步数据库");
		expect(tp("syncButton.success.singular", "syncButton.success.plural", 1)).toBe("同步完成：新增 1 条请求。");
		expect(tp("syncButton.success.singular", "syncButton.success.plural", 2)).toBe("同步完成：新增 2 条请求。");
		expect(t("syncButton.error", { message: "provider/raw:42" })).toBe("同步失败：provider/raw:42");

		const original = CATALOGS["zh-CN"]["syncButton.idle"];
		delete CATALOGS["zh-CN"]["syncButton.idle"];
		try {
			expect(t("syncButton.idle")).toBe("Sync DB");
		} finally {
			CATALOGS["zh-CN"]["syncButton.idle"] = original;
		}
	});

	it("notifies useLocale subscribers on actual changes, skips same-locale no-ops, and updates document.lang", async () => {
		const renders: Locale[] = [];

		function Probe() {
			const current = useLocale();
			renders.push(current);
			return createElement("output", { id: "locale-probe" }, current);
		}

		const container = await mount(createElement(Probe), dom.document);
		expect(container.textContent).toBe("en");
		expect(dom.document.documentElement.lang).toBe("en");

		const beforeSwitch = renders.length;
		await act(async () => {
			setLocale("zh-CN");
		});
		expect(container.textContent).toBe("zh-CN");
		expect(dom.document.documentElement.lang).toBe("zh-CN");
		expect(renders.length).toBeGreaterThan(beforeSwitch);

		const afterSwitch = renders.length;
		await act(async () => {
			setLocale("zh-CN");
		});
		expect(container.textContent).toBe("zh-CN");
		expect(renders.length).toBe(afterSwitch);
	});

	it("re-localizes stored sync success status after a locale flip instead of freezing the old copy", async () => {
		vi.spyOn(syncApi, "sync").mockResolvedValue({ processed: 2, files: 1, totalMessages: 2 });

		const container = await mount(createElement(SyncButton, {}), dom.document);
		const button = container.querySelector("button");
		if (!button) throw new Error("missing sync button");

		await click(button, dom.window);
		expect(container.textContent).toContain("Synced: 2 new requests found.");

		await act(async () => {
			setLocale("zh-CN");
		});
		expect(container.textContent).toContain("同步完成：新增 2 条请求。");
	});

	it("keeps the raw sync error text intact across locale changes", async () => {
		vi.spyOn(syncApi, "sync").mockRejectedValue(new Error("provider/raw:42"));

		const container = await mount(createElement(SyncButton, {}), dom.document);
		const button = container.querySelector("button");
		if (!button) throw new Error("missing sync button");

		await click(button, dom.window);
		expect(container.textContent).toContain("Sync failed: provider/raw:42");

		await act(async () => {
			setLocale("zh-CN");
		});
		expect(container.textContent).toContain("同步失败：provider/raw:42");
	});
});
