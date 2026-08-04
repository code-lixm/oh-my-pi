import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalSnapshotKey,
	DEFAULT_FUZZY_THRESHOLD,
	type EditToolDetails,
	executeHashlineSingle,
	executePatchSingle,
	executeReplace,
	type hashlineEditParamsSchema,
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

/**
 * Stand-in for an ACP client whose save pipeline reformats content before it
 * settles on disk (e.g. Zed's `format_on_save` rewriting indentation). Unlike
 * `makeBridge`, the bytes actually persisted differ from what was requested —
 * exercising the read-back/drift-detection path in `routeWriteThroughBridge`.
 */
function makeDriftingBridge() {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		writeTextFile: async ({ path: p, content: c }) => {
			await Bun.write(p, c.replace(/^ {4}/gm, "\t"));
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

	it("returns the client's actually-persisted content, not the requested content, when the bridge reformats on save", async () => {
		const { bridge } = makeDriftingBridge();
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const filesystem = new HashlineFilesystem({
			session,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const requested = "function f() {\n    return 1;\n}\n";
		const relPath = "output.ts";
		const absPath = path.join(tmpDir, relPath);

		const result = await filesystem.writeText(relPath, requested);

		// Ground truth: the "editor" reformatted spaces to tabs on save.
		const onDisk = await fs.readFile(absPath, "utf8");
		expect(onDisk).toBe("function f() {\n\treturn 1;\n}\n");
		expect(onDisk).not.toBe(requested);

		// `writeText`'s result MUST reflect reality, not the pre-write intent —
		// this is what the patcher keys the next snapshot tag on.
		expect(result.text).toBe(onDisk);
	});
});

// ─── executeHashlineSingle end-to-end (model-visible payload) ────────────────

function getText(result: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

function extractTag(text: string): string {
	const match = /#([0-9A-Fa-f]{4})\]/.exec(text);
	if (!match) throw new Error(`no snapshot tag found in: ${text}`);
	return match[1] ?? "";
}

describe("executeHashlineSingle model-visible payload under write-time drift", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-hashline-e2e-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	it("keeps the model-visible diff scoped to the intended hunk, not the whole reformatted file, when the bridge drifts", async () => {
		// Source-shaped content (short lines, closing braces at col 0) is exactly
		// what defeats the compact-diff-preview's contiguous-run collapse, so this
		// is the worst case for payload inflation, not a favorable one.
		const lines = ["function f() {"];
		for (let i = 0; i < 60; i++) lines.push(`    const v${i} = ${i};`);
		lines.push("}", "");
		const original = lines.join("\n");
		const relPath = "big.ts";
		const absPath = path.join(tmpDir, relPath);
		await fs.writeFile(absPath, original);

		const { bridge } = makeDriftingBridge();
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const realTag = computeFileHash(original);

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+    const v0 = 100;`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const text = getText(result);

		// Ground truth: the "editor" reformatted every untouched indented line.
		const onDisk = await fs.readFile(absPath, "utf8");
		expect(onDisk).not.toBe(original);
		expect(onDisk.split("\n").filter(l => l.startsWith("\t")).length).toBeGreaterThan(50);

		// The model-visible response must stay small: a few lines around the
		// intended hunk plus a short warning, not a diff spanning ~60 reformatted
		// lines. This is the regression a naive "key the diff on the verified
		// content" fix would introduce.
		expect(text.length).toBeLessThan(600);
		expect(text).toMatch(/reformatted it on save/);
		expect(text).not.toContain("v59"); // an untouched, far-away line never appears

		// And the returned tag must still be valid for a follow-up edit.
		const nextTag = extractTag(text);
		const followUp = await executeHashlineSingle({
			session,
			input: `[${relPath}#${nextTag}]\nPUT 1-1:\n+function g() {`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		expect(getText(followUp)).not.toMatch(/mismatch|stale/i);
	});

	it("does not warn about drift for a byte-perfect (non-reformatting) bridge write on a BOM'd file", async () => {
		const { bridge } = makeBridge(); // verbatim: writes exactly what it's given
		const { writethrough } = makeWritethroughMock();
		const session = createSession(tmpDir, { bridge });

		const relPath = "bom.txt";
		const absPath = path.join(tmpDir, relPath);
		const original = "\uFEFFhello\nworld\n";
		await fs.writeFile(absPath, original);

		const realTag = computeFileHash("hello\nworld\n"); // tag hashes BOM-stripped content

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+earth`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const text = getText(result);
		expect(text).not.toMatch(/reformatted it on save/);
	});

	it("propagates a notebook's editable view (not raw JSON) as the write result, so a follow-up edit's tag stays valid", async () => {
		const relPath = "nb.ipynb";
		const absPath = path.join(tmpDir, relPath);
		const notebook = {
			cells: [{ cell_type: "code", source: ["print('old')\n"], metadata: {}, outputs: [], execution_count: null }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		};
		await fs.writeFile(absPath, JSON.stringify(notebook));

		const { writethrough } = makeWritethroughMock();
		// No bridge at all: this reproduces the bug on the plain writethrough
		// path, where the notebook's view-space (cell text) and storage-space
		// (full JSON) were being conflated regardless of any ACP client.
		const session = createSession(tmpDir);

		const cellView = "# %% [code] cell:0\nprint('old')\n";
		const realTag = computeFileHash(cellView);

		const result = await executeHashlineSingle({
			session,
			input: `[${relPath}#${realTag}]\nPUT 2-2:\n+print('new')`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		const text = getText(result);
		expect(text).not.toMatch(/mismatch|stale/i);

		const nextTag = extractTag(text);
		const followUp = await executeHashlineSingle({
			session,
			input: `[${relPath}#${nextTag}]\nPUT 2-2:\n+print('newer')`,
			writethrough,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});
		expect(getText(followUp)).not.toMatch(/mismatch|stale/i);

		const updated = JSON.parse(await fs.readFile(absPath, "utf8"));
		expect(updated.cells[0].source.join("")).toContain("newer");
	});
});

// ─── executeReplace ─────────────────────────────────────────────────────────

describe("executeReplace ACP fs routing", () => {
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

		await executeReplace({
			session,
			path: filePath,
			params: { old_string: "old content", new_string: "new content", replace_all: false },
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
			executeReplace({
				session,
				path: filePath,
				params: { old_string: "preserve replace", new_string: "must not persist", replace_all: false },
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

		await executeReplace({
			session,
			path: planPath,
			params: { old_string: "old plan", new_string: "new plan", replace_all: false },
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
			executeReplace({
				session,
				path: planPath,
				params: { old_string: "keep plan", new_string: "must not persist", replace_all: false },
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
