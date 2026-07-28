import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalSnapshotKey,
	DEFAULT_FUZZY_THRESHOLD,
	executePatchSingle,
	executeReplaceSingle,
} from "@oh-my-pi/pi-coding-agent/edit";
import { HashlineFilesystem } from "@oh-my-pi/pi-coding-agent/edit/hashline/filesystem";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { WritethroughCallback } from "@oh-my-pi/pi-coding-agent/lsp";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
	beforeFileMutation?: ToolSession["beforeFileMutation"];
	onFileMutation?: ToolSession["onFileMutation"];
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		beforeFileMutation: options.beforeFileMutation,
		onFileMutation: options.onFileMutation,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

function makeBridge() {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		// Per ACP spec, writeTextFile writes to disk then notifies the editor buffer.
		// The mock fulfils the disk-write half so post-write verification passes.
		writeTextFile: async ({ path: p, content: c }) => {
			await Bun.write(p, c);
		},
	};
	const spy = spyOn(bridge, "writeTextFile");
	return { bridge, spy };
}

function makeWritethroughMock(): { writethrough: WritethroughCallback; spy: { calledWith: string[] } } {
	const spy = { calledWith: [] as string[] };
	// The writethrough must actually write to disk so post-write verification passes.
	const writethrough: WritethroughCallback = async (dst, content) => {
		spy.calledWith.push(dst);
		await Bun.write(dst, content);
		return undefined;
	};
	return { writethrough, spy };
}

// ─── HashlineFilesystem ───────────────────────────────────────────────────────

describe("HashlineFilesystem ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-hashline-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("runs before and a single post around ACP Hashline persistence", async () => {
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const phases: string[] = [];
		let beforeObservedContent: string | undefined;
		let postObservedContent: string | undefined;
		const relPath = "output.txt";
		const absPath = path.join(tmpDir, relPath);
		const content = "hello world\n";
		await Bun.write(absPath, "old value\n");
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				phases.push("before");
				beforeObservedContent = fsSync.readFileSync(absPath, "utf8");
			},
			onFileMutation: event => {
				postKinds.push(event.kind);
				phases.push("post");
				postObservedContent = fsSync.readFileSync(absPath, "utf8");
			},
		});
		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		await filesystem.writeText(relPath, content);

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(bridgeSpy).toHaveBeenCalledWith({ path: absPath, content });
		expect(writeSpy.calledWith).toHaveLength(0);
		expect(beforeObservedContent).toBe("old value\n");
		expect(postObservedContent).toBe(content);
		expect(phases).toEqual(["before", "post"]);
		expect(beforeKinds).toEqual(["update"]);
		expect(postKinds).toEqual(["update"]);
	});

	it("rejects ACP Hashline writes before the bridge or post hook can run", async () => {
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const relPath = "blocked.txt";
		const absPath = path.join(tmpDir, relPath);
		await Bun.write(absPath, "preserve this\n");
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				throw new Error("hashline write denied by policy");
			},
			onFileMutation: event => postKinds.push(event.kind),
		});
		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		await expect(filesystem.writeText(relPath, "must not persist\n")).rejects.toThrow(
			"hashline write denied by policy",
		);

		expect(beforeKinds).toEqual(["update"]);
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([]);
		expect(postKinds).toEqual([]);
		expect(fsSync.readFileSync(absPath, "utf8")).toBe("preserve this\n");
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});
		// Use a no-op writethrough so the call succeeds without real LSP
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		await filesystem.writeText(planPath, planContent);

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith.length).toBeGreaterThan(0);
	});

	it("keeps a local sandbox artifact addressed by absolute path off the ACP bridge", async () => {
		// Tag-based path recovery rebinds a bare `cfg-…-plan.md` edit onto its
		// absolute sandbox path. Even though it is NOT the active plan file
		// (planFilePath is still the default local://PLAN.md, a fresh-slug plan),
		// the OMP-owned artifact must be written to disk, never pushed to the editor.
		const { bridge, spy: bridgeSpy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: false },
		});
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const sandboxAbs = resolveLocalUrlToPath("local://cfg-module-hygiene-plan.md", {
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			getSessionId: () => "session-a",
		});

		await filesystem.writeText(sandboxAbs, "# Plan\n");

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toContain(sandboxAbs);
	});
});

// ─── executeReplaceSingle ─────────────────────────────────────────────────────

describe("executeReplaceSingle ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-replace-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("runs before and a single post around ACP replace persistence", async () => {
		const filePath = path.join(tmpDir, "target.txt");
		await Bun.write(filePath, "old content\n");
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const phases: string[] = [];
		let beforeObservedContent: string | undefined;
		let postObservedContent: string | undefined;
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				phases.push("before");
				beforeObservedContent = fsSync.readFileSync(filePath, "utf8");
			},
			onFileMutation: event => {
				postKinds.push(event.kind);
				phases.push("post");
				postObservedContent = fsSync.readFileSync(filePath, "utf8");
			},
		});

		await executeReplaceSingle({
			session,
			path: filePath,
			params: { old_text: "old content", new_text: "new content", all: false },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		const [[callArg]] = bridgeSpy.mock.calls;
		expect(callArg.path).toBe(filePath);
		expect(callArg.content).toContain("new content");
		expect(writeSpy.calledWith).toHaveLength(0);
		expect(beforeObservedContent).toBe("old content\n");
		expect(postObservedContent).toBe("new content\n");
		expect(phases).toEqual(["before", "post"]);
		expect(beforeKinds).toEqual(["update"]);
		expect(postKinds).toEqual(["update"]);
	});

	it("rejects ACP replace before the bridge changes bytes or emits a post", async () => {
		const filePath = path.join(tmpDir, "blocked-replace.txt");
		await Bun.write(filePath, "preserve replace\n");
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				throw new Error("ACP replace denied by policy");
			},
			onFileMutation: event => postKinds.push(event.kind),
		});

		await expect(
			executeReplaceSingle({
				session,
				path: filePath,
				params: { old_text: "preserve replace", new_text: "must not persist", all: false },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		).rejects.toThrow("ACP replace denied by policy");

		expect(beforeKinds).toEqual(["update"]);
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([]);
		expect(postKinds).toEqual([]);
		expect(fsSync.readFileSync(filePath, "utf8")).toBe("preserve replace\n");
	});

	it("runs before and a single post around fallback replace persistence", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const phases: string[] = [];
		let beforeObservedContent: string | undefined;
		let postObservedContent: string | undefined;
		let resolvedPlanPath = "";
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				phases.push("before");
				beforeObservedContent = fsSync.readFileSync(resolvedPlanPath, "utf8");
			},
			onFileMutation: event => {
				postKinds.push(event.kind);
				phases.push("post");
				postObservedContent = fsSync.readFileSync(resolvedPlanPath, "utf8");
			},
		});

		resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "old plan\n");
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await executeReplaceSingle({
			session,
			path: planPath,
			params: { old_text: "old plan", new_text: "new plan", all: false },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([resolvedPlanPath]);
		expect(beforeObservedContent).toBe("old plan\n");
		expect(postObservedContent).toBe("new plan\n");
		expect(phases).toEqual(["before", "post"]);
		expect(beforeKinds).toEqual(["update"]);
		expect(postKinds).toEqual(["update"]);
	});

	it("rejects fallback replace before it changes bytes or emits a post", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				throw new Error("replace denied by policy");
			},
			onFileMutation: event => postKinds.push(event.kind),
		});
		const resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "keep plan\n");
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await expect(
			executeReplaceSingle({
				session,
				path: planPath,
				params: { old_text: "keep plan", new_text: "must not persist", all: false },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		).rejects.toThrow("replace denied by policy");

		expect(beforeKinds).toEqual(["update"]);
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([]);
		expect(postKinds).toEqual([]);
		expect(fsSync.readFileSync(resolvedPlanPath, "utf8")).toBe("keep plan\n");
	});
});

// ─── executePatchSingle ───────────────────────────────────────────────────────

describe("executePatchSingle ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-patch-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("runs before and a single post around ACP patch persistence", async () => {
		const filePath = path.join(tmpDir, "target.txt");
		await Bun.write(filePath, "a\n");
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const phases: string[] = [];
		let beforeObservedContent: string | undefined;
		let postObservedContent: string | undefined;
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				phases.push("before");
				beforeObservedContent = fsSync.readFileSync(filePath, "utf8");
			},
			onFileMutation: event => {
				postKinds.push(event.kind);
				phases.push("post");
				postObservedContent = fsSync.readFileSync(filePath, "utf8");
			},
		});

		await executePatchSingle({
			session,
			path: filePath,
			params: { op: "update", diff: "@@\n-a\n+b" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		const [[callArg]] = bridgeSpy.mock.calls;
		expect(callArg.path).toBe(filePath);
		expect(callArg.content).toContain("b");
		expect(writeSpy.calledWith).toHaveLength(0);
		expect(beforeObservedContent).toBe("a\n");
		expect(postObservedContent).toContain("b");
		expect(phases).toEqual(["before", "post"]);
		expect(beforeKinds).toEqual(["update"]);
		expect(postKinds).toEqual(["update"]);
	});

	it("prepares canonical rename before ACP patch moves the source and posts once after", async () => {
		const sourcePath = path.join(tmpDir, "original.ts");
		const destinationPath = path.join(tmpDir, "renamed.ts");
		const before: Array<{ kind: string; path: string; previousPath?: string }> = [];
		const post: Array<{ kind: string; path: string; previousPath?: string }> = [];
		const phases: string[] = [];
		let beforeSourceExists: boolean | undefined;
		let beforeDestinationExists: boolean | undefined;
		let postSourceExists: boolean | undefined;
		let postDestinationContent: string | undefined;
		await Bun.write(sourcePath, "a\n");
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				before.push(event);
				phases.push("before");
				beforeSourceExists = fsSync.existsSync(sourcePath);
				beforeDestinationExists = fsSync.existsSync(destinationPath);
			},
			onFileMutation: event => {
				post.push(event);
				phases.push("post");
				postSourceExists = fsSync.existsSync(sourcePath);
				postDestinationContent = fsSync.existsSync(destinationPath)
					? fsSync.readFileSync(destinationPath, "utf8")
					: undefined;
			},
		});

		await executePatchSingle({
			session,
			path: sourcePath,
			params: { op: "update", rename: destinationPath, diff: "@@\n-a\n+b" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const renameEvent = {
			kind: "rename",
			path: canonicalSnapshotKey(destinationPath),
			previousPath: canonicalSnapshotKey(sourcePath),
		};
		expect(bridgeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy.calledWith).toEqual([]);
		expect(beforeSourceExists).toBe(true);
		expect(beforeDestinationExists).toBe(false);
		expect(postSourceExists).toBe(false);
		expect(postDestinationContent).toContain("b");
		expect(phases).toEqual(["before", "post"]);
		expect(before).toEqual([renameEvent]);
		expect(post).toEqual([renameEvent]);
	});

	it("rejects ACP patch before the bridge changes bytes or emits a post", async () => {
		const filePath = path.join(tmpDir, "blocked-patch.txt");
		await Bun.write(filePath, "preserve patch\n");
		const { bridge, spy: bridgeSpy } = makeBridge();
		const { writethrough, spy: writeSpy } = makeWritethroughMock();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const session = createSession(tmpDir, {
			bridge,
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				throw new Error("ACP patch denied by policy");
			},
			onFileMutation: event => postKinds.push(event.kind),
		});

		await expect(
			executePatchSingle({
				session,
				path: filePath,
				params: { op: "update", diff: "@@\n-preserve patch\n+must not persist" },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		).rejects.toThrow("ACP patch denied by policy");

		expect(beforeKinds).toEqual(["update"]);
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([]);
		expect(postKinds).toEqual([]);
		expect(fsSync.readFileSync(filePath, "utf8")).toBe("preserve patch\n");
	});

	it("runs before and a single post around fallback patch persistence", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const phases: string[] = [];
		let beforeObservedContent: string | undefined;
		let postObservedContent: string | undefined;
		let resolvedPlanPath = "";
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				phases.push("before");
				beforeObservedContent = fsSync.readFileSync(resolvedPlanPath, "utf8");
			},
			onFileMutation: event => {
				postKinds.push(event.kind);
				phases.push("post");
				postObservedContent = fsSync.readFileSync(resolvedPlanPath, "utf8");
			},
		});

		resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "a\n");
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await executePatchSingle({
			session,
			path: planPath,
			params: { op: "update", diff: "@@\n-a\n+b" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([resolvedPlanPath]);
		expect(beforeObservedContent).toBe("a\n");
		expect(postObservedContent).toContain("b");
		expect(phases).toEqual(["before", "post"]);
		expect(beforeKinds).toEqual(["update"]);
		expect(postKinds).toEqual(["update"]);
	});

	it("rejects fallback patch before it changes bytes or emits a post", async () => {
		const planPath = "local://PLAN.md";
		const { bridge, spy: bridgeSpy } = makeBridge();
		const beforeKinds: string[] = [];
		const postKinds: string[] = [];
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
			beforeFileMutation: async event => {
				beforeKinds.push(event.kind);
				throw new Error("patch denied by policy");
			},
			onFileMutation: event => postKinds.push(event.kind),
		});
		const resolvedPlanPath = resolveLocalUrlToPath(planPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
		await Bun.write(resolvedPlanPath, "keep patch\n");
		const { writethrough, spy: writeSpy } = makeWritethroughMock();

		await expect(
			executePatchSingle({
				session,
				path: planPath,
				params: { op: "update", diff: "@@\n-keep patch\n+must not persist" },
				allowFuzzy: false,
				fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
				writethrough,
				beginDeferredDiagnosticsForPath: noopBeginDeferred,
			}),
		).rejects.toThrow("patch denied by policy");

		expect(beforeKinds).toEqual(["update"]);
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(writeSpy.calledWith).toEqual([]);
		expect(postKinds).toEqual([]);
		expect(fsSync.readFileSync(resolvedPlanPath, "utf8")).toBe("keep patch\n");
	});
});
