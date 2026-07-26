/**
 * Kernel loader — ported from upstream
 * `codegraph/src/extraction/kernel/loader.ts` (MIT, Copyright (c) 2026
 * Colby Mchenry — see ../ATTRIBUTION.md and ../../UPSTREAM_LICENSE).
 *
 * Probes `@oh-my-pi/pi-natives` for the optional codegraph host
 * bindings; returns `null` when the addon is missing, its ABI
 * mismatches, or the grammar is absent. The codepath that *uses* the
 * loader is the runtime's `extractFile` — it falls back to the wasm
 * extractor on `null`, so a missing/stale kernel never blocks indexing.
 */

import * as logger from "@oh-my-pi/pi-utils/logger";
import type { NativeBindings } from "../../native";
import { nativeContractMatches, tryLoadNative } from "../../native";
import { KERNEL_ABI_VERSION } from "./layout";

export type { ExtractBuffers as KernelBuffers } from "../../native";

type KernelModule = NativeBindings;

let cached: KernelModule | null | undefined;
let kernelLanguages: ReadonlySet<string> = new Set();

function debug(message: string): void {
	if (process.env.CODEGRAPH_KERNEL_DEBUG === "1") logger.debug("CodeGraph kernel", { message });
}

function verifyContract(mod: KernelModule): boolean {
	try {
		const info = mod.contractInfo();
		if (!info || !nativeContractMatches(info)) return false;
		kernelLanguages = new Set(info.languages);
		return true;
	} catch (err) {
		debug(`contractInfo failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/**
 * Load (once per process) and verify the codegraph host module.
 * Returns `null` for every unavailability state.
 */
export async function getKernel(): Promise<KernelModule | null> {
	if (cached !== undefined) return cached;

	const mod = await tryLoadNative();
	if (!mod) {
		cached = null;
		return null;
	}
	if (!verifyContract(mod)) {
		debug(`contract mismatch (expected ${KERNEL_ABI_VERSION}); falling back to wasm`);
		cached = null;
		return null;
	}
	cached = mod;
	return cached;
}

/** True if a verified addon is loaded and supports `language`. */
export async function kernelSupports(language: string): Promise<boolean> {
	if (process.env.CODEGRAPH_KERNEL === "0") return false;
	const mod = await getKernel();
	if (!mod || !kernelLanguages.has(language)) return false;
	try {
		return mod.grammarInfo(language) !== null;
	} catch {
		return false;
	}
}

/** Test hook: forget the cached kernel so an env change is honored next call. */
export function resetKernelForTests(): void {
	cached = undefined;
	kernelLanguages = new Set();
}
