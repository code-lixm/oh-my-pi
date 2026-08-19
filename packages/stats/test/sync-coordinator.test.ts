import { describe, expect, it } from "bun:test";
import { StatsSyncCoordinator } from "@oh-my-pi/omp-stats/sync-coordinator";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-coordinator-");

describe("StatsSyncCoordinator", () => {
	it("routes a dirty session through the scoped backend instead of a global scan", async () => {
		const dirtySession = "/tmp/sessions/dirty.jsonl";
		const scopedSyncs: string[][] = [];
		let allSyncs = 0;
		const coordinator = new StatsSyncCoordinator({
			async syncAllSessions() {
				allSyncs++;
				return { processed: 99, files: 99 };
			},
			async syncSessionFiles(sessionFiles) {
				scopedSyncs.push([...sessionFiles]);
				return { processed: 1, files: 1 };
			},
		});

		coordinator.markDirty(dirtySession);

		expect(await coordinator.sync()).toEqual({ processed: 1, files: 1, mode: "dirty" });
		expect(scopedSyncs).toEqual([[dirtySession]]);
		expect(allSyncs).toBe(0);
	});

	it("reuses a recent clean result within an explicit freshness window", async () => {
		const freshnessMs = 60_000;
		let allSyncs = 0;
		const coordinator = new StatsSyncCoordinator({
			async syncAllSessions() {
				allSyncs++;
				return { processed: 3, files: 2 };
			},
			async syncSessionFiles() {
				throw new Error("clean sync should not use the scoped backend");
			},
		});

		const first = await coordinator.sync({ freshnessMs });
		const second = await coordinator.sync({ freshnessMs });

		expect(first).toEqual({ processed: 3, files: 2, mode: "full" });
		expect(second).toEqual({ processed: 0, files: 0, mode: "fresh" });
		expect(allSyncs).toBe(1);
	});

	it("shares one pending full sync between concurrent clean callers", async () => {
		let allSyncs = 0;
		const { promise: untilUnblocked, resolve: unblock } = Promise.withResolvers<void>();
		const coordinator = new StatsSyncCoordinator({
			async syncAllSessions() {
				allSyncs++;
				await untilUnblocked;
				return { processed: 4, files: 2 };
			},
			async syncSessionFiles() {
				throw new Error("clean sync should not use the scoped backend");
			},
		});

		const first = coordinator.sync({ freshnessMs: 60_000 });
		const second = coordinator.sync({ freshnessMs: 60_000 });
		try {
			expect(allSyncs).toBe(1);
		} finally {
			unblock();
		}

		expect(await Promise.all([first, second])).toEqual([
			{ processed: 4, files: 2, mode: "full" },
			{ processed: 4, files: 2, mode: "full" },
		]);
		expect(allSyncs).toBe(1);
	});
});
