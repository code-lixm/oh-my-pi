import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nativeLoader from "@oh-my-pi/pi-natives/loader";

import { tryLoadNative } from "../src/codegraph/native";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("codegraph native loader", () => {
	it("returns null when loadNative throws", async () => {
		const loadSpy = vi.spyOn(nativeLoader, "loadNative").mockImplementation(() => {
			throw new Error("native loader exploded");
		});

		const result = await tryLoadNative();
		expect(result).toBeNull();
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});
});
