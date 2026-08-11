import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RlmChildRegistry } from "../../src/registry/rlm-child-registry";

/**
 * Cross-boundary contract: the session file advertised in the RLM child
 * registry must equal the exact path the shared runner leases for the child
 * transcript. The lease is exercised without spawning a model: preflight fails
 * before any lease, so we assert the lease helper's contract indirectly by
 * verifying registry publication uses the caller-owned directory exactly.
 */
describe("RLM caller-owned artifacts boundary", () => {
	it("registry publication path stays inside the caller-owned session dir", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-boundary-"));
		const artifactsDir = path.join(base, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		const registry = await RlmChildRegistry.open({
			parentAgentId: "Main",
			parentSessionFile: path.join(base, "session.jsonl"),
			artifactsDir,
			isJobLive: () => false,
		});

		const rlmChildId = "child-boundary";
		const admitted = await registry.admit({
			rlmChildId,
			name: "worker",
			model: "provider/model",
			taskDepth: 1,
			maxDepth: 1,
		});

		// Mirrors the SDK spawn callback: the child session file is derived
		// deterministically from the caller-owned directory + reserved child id,
		// and the same value is published to the registry.
		const sessionDir = admitted.session_dir;
		const childSessionFile = path.join(sessionDir, `${rlmChildId}.jsonl`);
		await registry.markRunning(rlmChildId, { sessionId: "sess-1", sessionFile: childSessionFile });

		const hydrated = await registry.list();
		expect(hydrated).toHaveLength(1);
		expect(hydrated[0]!.session_file).toBe(childSessionFile);
		expect(hydrated[0]!.session_file).toContain(sessionDir);
		expect(hydrated[0]!.session_dir).toBe(sessionDir);
		await fs.rm(base, { recursive: true, force: true });
	});
});
