import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

// `ast_grep` and `ast_edit` resolve internal URLs at read/write tier and can
// never produce a backing file for ssh://, so they must reject it before
// `InternalUrlRouter.resolve` opens an outbound SSH connection.
describe("ssh:// is rejected before any connection in AST tools", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolveToolSearchScope (ast_grep + ast_edit) throws on ssh:// without resolving", async () => {
		// Reject if resolve is ever reached, so a guard regression fails loudly
		// instead of attempting a real connection.
		const spy = vi
			.spyOn(InternalUrlRouter.instance(), "resolve")
			.mockRejectedValue(new Error("resolve must not run for ssh://"));
		for (const internalUrlAction of ["search", "rewrite"]) {
			await expect(
				resolveToolSearchScope({ rawPaths: ["ssh://h/x"], cwd: os.tmpdir(), internalUrlAction }),
			).rejects.toThrow(/ssh:\/\//);
		}
		expect(spy).not.toHaveBeenCalled();
	});
});
