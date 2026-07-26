import { describe, expect, it } from "bun:test";

import { shortenPath } from "../../src/utils/path-display";

describe("shortenPath", () => {
	it("collapses the home directory itself to '~'", () => {
		expect(shortenPath("/Users/alice", "/Users/alice")).toBe("~");
	});

	it("collapses a child path under home and normalizes Windows separators", () => {
		expect(shortenPath("/Users/alice/project/src/index.ts", "/Users/alice")).toBe("~/project/src/index.ts");
		expect(shortenPath("C:\\Users\\alice\\project\\src\\index.ts", "C:\\Users\\alice")).toBe(
			"~/project/src/index.ts",
		);
	});

	it("does not collapse a same-prefix non-child path", () => {
		expect(shortenPath("/Users/alice-other/project", "/Users/alice")).toBe("/Users/alice-other/project");
		expect(shortenPath("C:\\Users\\alice-other\\project", "C:\\Users\\alice")).toBe(
			"C:\\Users\\alice-other\\project",
		);
	});
});
