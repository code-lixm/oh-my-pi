import { afterEach, describe, expect, it } from "bun:test";
import type { FileFinderApi, InitOptions, Result } from "@ff-labs/fff-bun";
import { FffFinderManager, type FffFinderStatic } from "../../src/tools/fff-manager";

class FakeFinder implements Pick<FileFinderApi, "destroy" | "isDestroyed" | "waitForScan"> {
	isDestroyed = false;

	destroy(): void {
		this.isDestroyed = true;
	}

	async waitForScan(): Promise<Result<boolean>> {
		return { ok: true, value: true };
	}
}

const managers = new Set<FffFinderManager>();

afterEach(() => {
	for (const manager of managers) manager.dispose();
	managers.clear();
});

function createManager(finderStatic: FffFinderStatic): FffFinderManager {
	const manager = new FffFinderManager({
		finderStatic,
		frecencyDbPath: "/tmp/fff-manager-test-frecency",
		historyDbPath: "/tmp/fff-manager-test-history",
	});
	managers.add(manager);
	return manager;
}

describe("FffFinderManager workspace initialization", () => {
	it("retries without durable ranking databases when frecency reader slots are exhausted", async () => {
		const finder = new FakeFinder();
		const finderApi = finder as unknown as FileFinderApi;
		const createCalls: InitOptions[] = [];
		const manager = createManager({
			create(options) {
				createCalls.push(options);
				if ("frecencyDbPath" in options || "historyDbPath" in options) {
					return {
						ok: false,
						error: "Failed to init frecency db: MDB_READERS_FULL: Environment maxreaders limit reached",
					};
				}
				return { ok: true, value: finderApi };
			},
		});

		const workspace = await manager.acquireWorkspace("/tmp/fff-manager-reader-fallback");

		expect(workspace.finder).toBe(finderApi);
		expect(workspace.finder.isDestroyed).toBe(false);
		expect(createCalls).toHaveLength(2);
		expect(createCalls[1]).not.toHaveProperty("frecencyDbPath");
		expect(createCalls[1]).not.toHaveProperty("historyDbPath");
	});

	it("propagates other initialization errors without retrying", async () => {
		const createCalls: InitOptions[] = [];
		const error = "Failed to init frecency db: database is unavailable";
		const manager = createManager({
			create(options) {
				createCalls.push(options);
				return { ok: false, error };
			},
		});

		let failure: Error | undefined;
		try {
			await manager.acquireWorkspace("/tmp/fff-manager-ordinary-error");
		} catch (caught) {
			if (!(caught instanceof Error)) throw caught;
			failure = caught;
		}
		expect(failure?.message).toBe(
			"Failed to create FFF index for /tmp/fff-manager-ordinary-error: Failed to init frecency db: database is unavailable",
		);
		expect(createCalls).toHaveLength(1);
	});
});
