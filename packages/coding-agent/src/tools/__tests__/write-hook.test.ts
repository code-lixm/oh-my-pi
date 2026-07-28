/**
 * Contract tests for {@link WriteTool}'s file-mutation lifecycle.
 *
 * A real persistence must invoke `beforeFileMutation` before its bytes change,
 * then emit exactly one `onFileMutation` event after the write resolves. A
 * rejected pre-hook must leave both bytes and post-hook untouched.
 *
 * The harness runs against a temp cwd because the `WriteTool` resolves
 * `local://` paths through the session's local sandbox — we keep that out of
 * the way by writing absolute paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
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
	before?: ToolSession["beforeFileMutation"];
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
		beforeFileMutation: opts.before,
		onFileMutation: opts.hook,
		getClientBridge: opts.bridge ? () => opts.bridge as never : undefined,
	} as unknown as ToolSession;
}

describe("WriteTool -> ToolSession file-mutation lifecycle", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-hook-"));
	});
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	test("direct source-file write runs before before persistence and one post after", async () => {
		const before: FileMutationEvent[] = [];
		const post: FileMutationEvent[] = [];
		const phases: string[] = [];
		let beforeObservedExisting: boolean | undefined;
		let postObservedContent: string | undefined;
		const target = path.join(cwd, "src", "main.ts");
		const content = "export const x = 1;\n";
		const session = makeSession({
			events: post,
			cwd,
			before: async event => {
				before.push(event);
				phases.push("before");
				beforeObservedExisting = fsSync.existsSync(target);
			},
			hook: event => {
				post.push(event);
				phases.push("post");
				postObservedContent = fsSync.existsSync(target) ? fsSync.readFileSync(target, "utf8") : undefined;
			},
		});
		const tool = new WriteTool(session);
		await fs.mkdir(path.dirname(target), { recursive: true });

		const result = await tool.execute("call-1", { path: target, content });
		expect(result.isError).toBeUndefined();

		expect(beforeObservedExisting).toBe(false);
		expect(postObservedContent).toBe(content);
		expect(phases).toEqual(["before", "post"]);
		expect(before).toEqual([{ kind: "create", path: canonicalSnapshotKey(target) }]);
		expect(post).toEqual([{ kind: "create", path: canonicalSnapshotKey(target) }]);
	});

	test("direct write rejection preserves existing bytes and suppresses the post hook", async () => {
		const before: FileMutationEvent[] = [];
		const post: FileMutationEvent[] = [];
		const target = path.join(cwd, "src", "protected.ts");
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, "keep this\n", "utf8");
		const session = makeSession({
			events: post,
			cwd,
			before: async event => {
				before.push(event);
				throw new Error("write denied by policy");
			},
			hook: event => post.push(event),
		});
		const tool = new WriteTool(session);

		await expect(tool.execute("call-rejected", { path: target, content: "must not persist\n" })).rejects.toThrow(
			"write denied by policy",
		);
		expect(before).toEqual([{ kind: "update", path: canonicalSnapshotKey(target) }]);
		expect(post).toEqual([]);
		expect(fsSync.readFileSync(target, "utf8")).toBe("keep this\n");
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

	test("ACP bridge write runs one before and one post around persistence", async () => {
		const before: FileMutationEvent[] = [];
		const post: FileMutationEvent[] = [];
		const phases: string[] = [];
		let beforeObservedExisting: boolean | undefined;
		let postObservedContent: string | undefined;
		let bridgeCalls = 0;
		const target = path.join(cwd, "src", "bridge.ts");
		await fs.mkdir(path.dirname(target), { recursive: true });
		const content = "export const viaBridge = true;\n";
		const bridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: targetPath, content: bridgeContent }: { path: string; content: string }) => {
				bridgeCalls += 1;
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, bridgeContent, "utf8");
			},
		};
		const session = makeSession({
			events: post,
			cwd,
			before: async event => {
				before.push(event);
				phases.push("before");
				beforeObservedExisting = fsSync.existsSync(target);
			},
			hook: event => {
				post.push(event);
				phases.push("post");
				postObservedContent = fsSync.existsSync(target) ? fsSync.readFileSync(target, "utf8") : undefined;
			},
			bridge,
		});
		const tool = new WriteTool(session);

		const result = await tool.execute("call-bridge", { path: target, content });
		expect(result.isError).toBeUndefined();
		expect(beforeObservedExisting).toBe(false);
		expect(postObservedContent).toBe(content);
		expect(phases).toEqual(["before", "post"]);
		expect(bridgeCalls).toBe(1);
		expect(before).toEqual([{ kind: "create", path: canonicalSnapshotKey(target) }]);
		expect(post).toEqual([{ kind: "create", path: canonicalSnapshotKey(target) }]);
	});

	test("ACP bridge write rejection starts no bridge write and emits no post", async () => {
		const before: FileMutationEvent[] = [];
		const post: FileMutationEvent[] = [];
		let bridgeCalls = 0;
		const target = path.join(cwd, "src", "blocked-bridge.ts");
		await fs.mkdir(path.dirname(target), { recursive: true });
		const bridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: targetPath, content }: { path: string; content: string }) => {
				bridgeCalls += 1;
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, content, "utf8");
			},
		};
		const session = makeSession({
			events: post,
			cwd,
			before: async event => {
				before.push(event);
				throw new Error("bridge write denied by policy");
			},
			hook: event => post.push(event),
			bridge,
		});
		const tool = new WriteTool(session);

		await expect(
			tool.execute("call-bridge-rejected", { path: target, content: "must not persist\n" }),
		).rejects.toThrow("bridge write denied by policy");
		expect(before).toEqual([{ kind: "create", path: canonicalSnapshotKey(target) }]);
		expect(bridgeCalls).toBe(0);
		expect(post).toEqual([]);
		expect(fsSync.existsSync(target)).toBe(false);
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
