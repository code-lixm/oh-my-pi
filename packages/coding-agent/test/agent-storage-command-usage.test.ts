import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentStorage command usage", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.resetInstance();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	it("accumulates model and skill command counts across a database reopen", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-command-usage-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const storage = await AgentStorage.open(dbPath);

		storage.recordCommandUsage("model");
		storage.recordCommandUsage("model");
		storage.recordCommandUsage("skill:review");
		storage.recordCommandUsage("skill:review");
		storage.recordCommandUsage("skill:review");
		expect(storage.listCommandUsage()).toEqual({ model: 2, "skill:review": 3 });

		AgentStorage.resetInstance();
		const reopenedStorage = await AgentStorage.open(dbPath);
		expect(reopenedStorage.listCommandUsage()).toEqual({ model: 2, "skill:review": 3 });
	});
});
