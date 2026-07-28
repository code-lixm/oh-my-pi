/**
 * Smoke test for the `ToolSession.onFileMutation` hook wiring.
 *
 * Exercises the four call sites that live in `notifyFileMutation`:
 *   1. Single-ownership semantics: with a callback installed, events fire
 *      through the callback only — the pending collector stays empty.
 *   2. Without a callback, events buffer in the pending collector and a
 *      drain returns them.
 *   3. Archive / SQLite paths are filtered out by the source-file gate.
 *   4. Renames carry `previousPath`; consecutive same-path updates collapse.
 *
 * Does NOT exercise the live write/edit tools — that needs a full session
 * harness. The goal here is to pin down the helper-level guarantees that the
 * downstream wiring relies on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../../config/settings";
import type { ToolSession } from "..";
import {
	buildFileMutationEvent,
	clearPendingFileMutations,
	drainPendingFileMutations,
	isSourceFilePath,
	notifyFileCreated,
	notifyFileDeleted,
	notifyFileRenamed,
	notifyFileUpdated,
	peekPendingFileMutations,
	prepareFileMutation,
} from "../file-mutation-hook";

function canonical(p: string): string {
	require("node:fs");
	const fs = require("node:fs") as typeof import("node:fs");
	try {
		return fs.realpathSync.native(p);
	} catch {
		const path = require("node:path") as typeof import("node:path");
		const parent = fs.realpathSync.native(path.dirname(p));
		return path.join(parent, path.basename(p));
	}
}

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

describe("ToolSession.onFileMutation hook helper", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mutation-hook-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	test("filters archive / sqlite / unknown suffixes", () => {
		expect(isSourceFilePath("/tmp/repo/main.ts")).toBe(true);
		expect(isSourceFilePath("/tmp/repo/main.py")).toBe(true);
		expect(isSourceFilePath("/tmp/repo/.gitignore")).toBe(true);
		expect(isSourceFilePath("/tmp/repo/bundle.zip")).toBe(false);
		expect(isSourceFilePath("/tmp/repo/bundle.tar.gz")).toBe(false);
		expect(isSourceFilePath("/tmp/repo/bundle.TAR.GZ")).toBe(false);
		expect(isSourceFilePath("/tmp/repo/data.sqlite")).toBe(false);
		expect(isSourceFilePath("/tmp/repo/data.sqlite3")).toBe(false);
		expect(isSourceFilePath("/tmp/repo/data.db")).toBe(false);
	});

	test("single ownership: callback installed -> no buffer write", async () => {
		const session = makeSession();
		const seen: { path: string; kind: string }[] = [];
		session.onFileMutation = event => {
			seen.push({ path: event.path, kind: event.kind });
		};

		const file = path.join(tmp, "main.ts");
		await Bun.write(file, "export const x = 1;\n");
		expect(notifyFileCreated(session, file)).toBe(true);
		expect(notifyFileUpdated(session, file)).toBe(true);

		expect(seen).toEqual([
			{ path: canonical(file), kind: "create" },
			{ path: canonical(file), kind: "update" },
		]);
		// Pending collector must be untouched when the callback is installed.
		expect(peekPendingFileMutations(session)).toEqual([]);
		expect(drainPendingFileMutations(session)).toEqual([]);
	});

	test("buffered path: no callback -> events land in pending collector", async () => {
		const session = makeSession();
		const file = path.join(tmp, "main.ts");

		expect(notifyFileCreated(session, file)).toBe(true);
		expect(notifyFileUpdated(session, file)).toBe(true);
		expect(notifyFileDeleted(session, file)).toBe(true);

		const pending = drainPendingFileMutations(session);
		// create + update on the same path collapse into a single create-then-update;
		// the update is then superseded by the later delete event.
		expect(pending.map(e => e.kind)).toEqual(["delete"]);
		for (const event of pending) expect(event.path).toBe(canonical(file));
		// After drain the buffer is empty.
		expect(drainPendingFileMutations(session)).toEqual([]);
	});

	test("archive / sqlite paths never reach the callback or buffer", async () => {
		const session = makeSession();
		const seen: string[] = [];
		session.onFileMutation = event => seen.push(event.kind);

		expect(notifyFileCreated(session, path.join(tmp, "bundle.zip"))).toBe(false);
		expect(notifyFileUpdated(session, path.join(tmp, "data.sqlite"))).toBe(false);
		expect(notifyFileDeleted(session, path.join(tmp, "blob.tar.gz"))).toBe(false);
		expect(seen).toEqual([]);
		expect(peekPendingFileMutations(session)).toEqual([]);
	});

	test("rename event carries previousPath and collapses with prior events on the same path", () => {
		const session = makeSession();
		const oldPath = path.join(tmp, "old.ts");
		const newPath = path.join(tmp, "new.ts");

		notifyFileCreated(session, oldPath);
		notifyFileRenamed(session, oldPath, newPath);
		notifyFileUpdated(session, newPath);

		const pending = drainPendingFileMutations(session);
		expect(pending).toHaveLength(2);
		// create(old) survives as its own event.
		expect(pending[0]?.kind).toBe("create");
		expect(pending[0]?.path).toBe(canonical(oldPath));
		// rename + update on the same path collapse to the later update.
		expect(pending[1]?.kind).toBe("update");
		expect(pending[1]?.path).toBe(canonical(newPath));
	});

	test("delete followed by re-create on the same path becomes a single create event", () => {
		const session = makeSession();
		const file = path.join(tmp, "ephemeral.ts");

		notifyFileCreated(session, file);
		notifyFileUpdated(session, file);
		notifyFileDeleted(session, file);
		notifyFileCreated(session, file);

		const pending = drainPendingFileMutations(session);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.kind).toBe("create");
		expect(pending[0]?.path).toBe(canonical(file));
	});

	test("buildFileMutationEvent rejects rename events without previousPath", () => {
		const session = makeSession();
		expect(buildFileMutationEvent(session, "/tmp/main.ts", "rename")).toBeUndefined();
		expect(buildFileMutationEvent(session, "/tmp/main.ts", "rename", { previousPath: "/tmp/old.ts" })).toEqual({
			path: canonical("/tmp/main.ts"),
			kind: "rename",
			previousPath: canonical("/tmp/old.ts"),
		});
	});

	test("pre hook skips non-source storage and propagates a source policy rejection", async () => {
		const session = makeSession();
		const observed: Array<{ kind: string; path: string }> = [];
		session.beforeFileMutation = async event => {
			observed.push({ kind: event.kind, path: event.path });
			if (event.path.endsWith("blocked.ts")) throw new Error("mutation denied by policy");
		};

		await expect(prepareFileMutation(session, path.join(tmp, "bundle.zip"), "update")).resolves.toBeUndefined();
		await expect(prepareFileMutation(session, path.join(tmp, "main.ts"), "create")).resolves.toBeUndefined();
		await expect(prepareFileMutation(session, path.join(tmp, "blocked.ts"), "update")).rejects.toThrow(
			"mutation denied by policy",
		);

		expect(observed).toEqual([
			{ kind: "create", path: canonical(path.join(tmp, "main.ts")) },
			{ kind: "update", path: canonical(path.join(tmp, "blocked.ts")) },
		]);
	});

	test("buffer can be cleared explicitly", () => {
		const session = makeSession();
		const file = path.join(tmp, "x.ts");
		notifyFileCreated(session, file);
		expect(peekPendingFileMutations(session)).toHaveLength(1);
		clearPendingFileMutations(session);
		expect(peekPendingFileMutations(session)).toEqual([]);
	});

	test("callback throwing does not leak events into the buffer", () => {
		const session = makeSession();
		const file = path.join(tmp, "main.ts");
		session.onFileMutation = () => {
			throw new Error("downstream exploded");
		};

		// notifyFileMutation intentionally swallows the throw — exact-once is
		// still honored: the callback saw it exactly once, and it never lands
		// in the buffer (single-ownership rule).
		expect(() => notifyFileCreated(session, file)).not.toThrow();
		expect(peekPendingFileMutations(session)).toEqual([]);
	});
});
