import { useSyncExternalStore } from "react";

export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "zh-CN"] as const;
export const DEFAULT_LOCALE: Locale = "en";

const STORAGE_KEY = "omp-stats-locale";

function readStoredLocale(): Locale | null {
	if (typeof localStorage === "undefined") return null;
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "en" || stored === "zh-CN" ? stored : null;
}

function detectLocale(): Locale {
	if (typeof navigator === "undefined") return DEFAULT_LOCALE;
	const lang = navigator.language?.toLowerCase();
	return lang?.startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE;
}

function applyLangAttribute(locale: Locale): void {
	if (typeof document === "undefined") return;
	document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
}

let current: Locale = readStoredLocale() ?? detectLocale();
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
	applyLangAttribute(current);
}

function emit(): void {
	for (const listener of listeners) listener();
}

export function setLocale(next: Locale): void {
	if (next !== "en" && next !== "zh-CN") return;
	if (next === current) return;
	current = next;
	if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
	applyLangAttribute(next);
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

/** Synchronous reader for use inside non-React contexts (event handlers, useMemo, plain callers). */
export function getLocale(): Locale {
	return current;
}

/** Reader hook: subscribes via useSyncExternalStore so locale changes re-render the component. */
export function useLocale(): Locale {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => DEFAULT_LOCALE,
	);
}
