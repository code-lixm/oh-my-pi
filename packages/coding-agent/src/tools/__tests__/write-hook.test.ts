/**
 * Smoke test for the {@link WriteTool} -> `onFileMutation` integration.
 *
 * Validates the contract documented in `local://codegraph-contract.md`:
 * every successful real persistence emits exactly one event with the right
 * `kind`, while no-op / archive / SQLite member writes stay silent.
 *
 * The harness runs against a temp cwd because the `WriteTool` resolves
 * `local://` paths through the session's local sandbox — we keep that out of
 * the way by writing absolute paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../../config/settings";
import { canonicalSnapshotKey } from "../../edit/file-snapshot-store";
import type { ToolSession } from "..";
import type { FileMutationEvent } from "../file-mutation-hook";
import { WriteTool } from "../write";

function makeSession(opts: {
	events: FileMutationEvent[];
	cwd: string;
	hook?: ToolSession["onFileMutation"];
	bridge?: {
		capabilities?: { writeTextFile?: boolean };
		writeTextFile?: (input: { path: string; content: string }) => Promise<void>;
	};
}): ToolSession {
	return {
		cwd: opts.cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		onFileMutation: opts.hook,
		getClientBridge: opts.bridge ? () => opts.bridge as never : undefined,
	} as unknown as ToolSession;
}

describe("WriteTool -> ToolSession.onFileMutation integration", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-hook-"));
	});
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	test("real source-file write emits a create event once", async () => {
		const seen: FileMutationEvent[] = [];
		const session = makeSession({ events: seen, cwd, hook: e => seen.push(e) });
		const tool = new WriteTool(session);
		const target = path.join(cwd, "src", "main.ts");
		await fs.mkdir(path.dirname(target), { recursive: true });

		const result = await tool.execute("call-1", { path: target, content: "export const x = 1;\n" });
		expect(result.isError).toBeUndefined();

		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("create");
		expect(seen[0]?.path).toBe(canonicalSnapshotKey(target));
	});

	test("second write to the same file emits an update, not a create", async () => {
		const seen: FileMutationEvent[] = [];
		const session = makeSession({ events: seen, cwd, hook: e => seen.push(e) });
		const tool = new WriteTool(session);
		const target = path.join(cwd, "src", "main.ts");
		await fs.mkdir(path.dirname(target), { recursive: true });

		await tool.execute("call-1", { path: target, content: "v1\n" });
		await tool.execute("call-2", { path: target, content: "v2\n" });

		expect(seen.map(e => e.kind)).toEqual(["create", "update"]);
	});

	test("ACP bridge write emits exactly one mutation with the correct kind and path", async () => {
		const seen: FileMutationEvent[] = [];
		let bridgeCalls = 0;
		const bridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: targetPath, content }: { path: string; content: string }) => {
				bridgeCalls += 1;
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, content, "utf8");
			},
		};
		const session = makeSession({ events: seen, cwd, hook: e => seen.push(e), bridge });
		const tool = new WriteTool(session);
		const target = path.join(cwd, "src", "bridge.ts");

		const result = await tool.execute("call-bridge", { path: target, content: "export const viaBridge = true;\n" });
		expect(result.isError).toBeUndefined();
		expect(bridgeCalls).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("create");
		expect(seen[0]?.path).toBe(canonicalSnapshotKey(target));
		expect(await Bun.file(target).text()).toContain("viaBridge");
	});

	test("archive member write is filtered by the hook gate", async () => {
		const seen: FileMutationEvent[] = [];
		const session = makeSession({ events: seen, cwd, hook: e => seen.push(e) });
		const tool = new WriteTool(session);

		// Write to a zip archive member; the WriteTool rewrites the whole
		// archive under the hood. The hook gate filters the archive path.
		const archivePath = path.join(cwd, "bundle.zip:src/main.ts");
		const result = await tool.execute("call-1", { path: archivePath, content: "export const x = 1;\n" });
		expect(result.isError).toBeUndefined();

		// archive path itself is filtered; the archive is not a source file.
		expect(seen).toEqual([]);
	});

	test("sqlite member write is filtered by the hook gate", async () => {
		const seen: FileMutationEvent[] = [];
		const session = makeSession({ events: seen, cwd, hook: e => seen.push(e) });
		const tool = new WriteTool(session);

		const dbPath = path.join(cwd, "store.sqlite");
		await fs.writeFile(dbPath, "");
		const result = await tool.execute("call-1", {
			path: `${dbPath}:rows/1`,
			content: JSON.stringify({ id: 1, name: "alpha" }),
		});
		// SQLite paths are routed through the writer; the gate filters them.
		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([]);
	});
});
