import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	detectSiyuanCli,
	type SiyuanProcessResult,
	type SiyuanSpawnOptions,
	SiyuanTool,
	type SiyuanToolDetails,
	verifyOfficialMacSignature,
} from "@oh-my-pi/pi-coding-agent/tools/siyuan";

type SiyuanSpawn = (
	binary: string,
	args: readonly string[],
	options?: SiyuanSpawnOptions,
) => Promise<SiyuanProcessResult>;

const CLI_PATH = "/fake/SiYuan-Kernel";
const CLI_VERSION = "3.1.29";
const DETECTED_CLI = {
	available: true as const,
	path: CLI_PATH,
	version: CLI_VERSION,
	verification: "compatibility-signature" as const,
};

function createSession(settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/siyuan-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	} as unknown as ToolSession;
}

function ok(stdout: string, stderr = "", exitCode = 0): SiyuanProcessResult {
	return { stdout, stderr, exitCode };
}

function workspaceList(...workspaces: Array<{ name: string; path: string }>): SiyuanProcessResult {
	return ok(JSON.stringify(workspaces));
}

function textOf(result: AgentToolResult<SiyuanToolDetails>): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

let savedWorkspaceEnv: string | undefined;

beforeEach(() => {
	savedWorkspaceEnv = process.env.SIYUAN_WORKSPACE_PATH;
	delete process.env.SIYUAN_WORKSPACE_PATH;
});

afterEach(() => {
	if (savedWorkspaceEnv === undefined) delete process.env.SIYUAN_WORKSPACE_PATH;
	else process.env.SIYUAN_WORKSPACE_PATH = savedWorkspaceEnv;
	vi.restoreAllMocks();
});

describe("detectSiyuanCli", () => {
	it("accepts version and workspace-help signatures on non-macOS", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok(`siyuan version ${CLI_VERSION}\n`);
			if (args[0] === "workspace" && args[1] === "--help") return ok("Usage: siyuan workspace list\n");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});
		const verifyMacSignature = vi.fn(async () => true);

		const detection = await detectSiyuanCli({
			resolveBinary: () => CLI_PATH,
			spawn,
			platform: "linux",
			verifyMacSignature,
		});

		expect(detection).toEqual({
			available: true,
			path: CLI_PATH,
			version: CLI_VERSION,
			verification: "compatibility-signature",
		});
		expect(spawn.mock.calls.map(([, args]) => [...args])).toEqual([["--version"], ["workspace", "--help"]]);
		expect(verifyMacSignature).not.toHaveBeenCalled();
	});

	it("accepts official macOS signatures", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok(`siyuan version ${CLI_VERSION}`);
			if (args[0] === "workspace" && args[1] === "--help") return ok("Usage: siyuan workspace\n");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});
		const verifyMacSignature = vi.fn(async (binary: string) => binary === CLI_PATH);

		const detection = await detectSiyuanCli({
			resolveBinary: () => CLI_PATH,
			spawn,
			platform: "darwin",
			verifyMacSignature,
		});

		expect(detection).toEqual({
			available: true,
			path: CLI_PATH,
			version: CLI_VERSION,
			verification: "apple-signature",
		});
		expect(verifyMacSignature).toHaveBeenCalledWith(CLI_PATH);
	});

	it("rejects binaries whose version output does not match the official signature", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok("SiYuan 3.1.29");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});

		const detection = await detectSiyuanCli({ resolveBinary: () => CLI_PATH, spawn, platform: "linux" });

		expect(detection).toEqual({
			available: false,
			reason: "invalid-version",
			path: CLI_PATH,
			detail: "SiYuan 3.1.29",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("rejects untrusted macOS signatures even when version and help look valid", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok(`siyuan version ${CLI_VERSION}`);
			if (args[0] === "workspace" && args[1] === "--help") return ok("Usage: siyuan workspace list\n");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});
		const verifyMacSignature = vi.fn(async () => false);

		const detection = await detectSiyuanCli({
			resolveBinary: () => CLI_PATH,
			spawn,
			platform: "darwin",
			verifyMacSignature,
		});

		expect(detection).toEqual({
			available: false,
			reason: "untrusted-signature",
			path: CLI_PATH,
		});
		expect(spawn.mock.calls.map(([, args]) => [...args])).toEqual([["--version"], ["workspace", "--help"]]);
		expect(verifyMacSignature).toHaveBeenCalledWith(CLI_PATH);
	});

	it("returns incompatible-cli when workspace --help spawn throws instead of propagating", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok(`siyuan version ${CLI_VERSION}\n`);
			if (args[0] === "workspace" && args[1] === "--help") throw new Error("ENOENT");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});

		const detection = await detectSiyuanCli({ resolveBinary: () => CLI_PATH, spawn, platform: "linux" });

		expect(detection).toEqual({
			available: false,
			reason: "incompatible-cli",
			path: CLI_PATH,
			detail: "ENOENT",
		});
	});

	it("returns untrusted-signature when injected mac verifier throws instead of propagating", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--version") return ok(`siyuan version ${CLI_VERSION}`);
			if (args[0] === "workspace" && args[1] === "--help") return ok("Usage: siyuan workspace\n");
			throw new Error(`unexpected args: ${args.join(" ")}`);
		});
		const verifyMacSignature = vi.fn(async (_binary: string) => {
			throw new Error("codesign crashed");
		});

		const detection = await detectSiyuanCli({
			resolveBinary: () => CLI_PATH,
			spawn,
			platform: "darwin",
			verifyMacSignature,
		});

		expect(detection).toEqual({
			available: false,
			reason: "untrusted-signature",
			path: CLI_PATH,
			detail: "codesign crashed",
		});
	});
});
describe("verifyOfficialMacSignature", () => {
	function fakeCodesignSpawn(
		binary: string,
		strictExitCode: number,
		metadataExitCode: number,
		metadataStderr = `TeamIdentifier=FJT3K7XAD8\nIdentifier=SiYuan-Kernel\n`,
	): Mock<SiyuanSpawn> {
		return vi.fn(async (_bin: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--verify" && args[1] === "--strict" && args[2] === binary) {
				return ok("", "", strictExitCode);
			}
			if (args[0] === "-dv" && args[1] === "--verbose=4" && args[2] === binary) {
				return ok("", metadataStderr, metadataExitCode);
			}
			throw new Error(`unexpected codesign call: ${JSON.stringify(args)}`);
		});
	}

	it("returns true when --verify --strict passes and metadata contains official team id + identifier", async () => {
		const spawn = fakeCodesignSpawn(CLI_PATH, 0, 0);
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(2);
		const [[, args1], [, args2]] = spawn.mock.calls;
		expect(args1).toEqual(["--verify", "--strict", CLI_PATH]);
		expect(args2).toEqual(["-dv", "--verbose=4", CLI_PATH]);
	});

	it("returns false when --verify --strict exits non-zero without calling -dv", async () => {
		const spawn = fakeCodesignSpawn(CLI_PATH, 1, 0);
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [[, args]] = spawn.mock.calls;
		expect(args[0]).toBe("--verify");
		expect(args[1]).toBe("--strict");
	});

	it("returns false when -dv exits non-zero without throwing", async () => {
		const spawn = fakeCodesignSpawn(CLI_PATH, 0, 2);
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("returns false when -dv throws without throwing", async () => {
		const spawn = vi.fn(async (_bin: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--verify" && args[1] === "--strict") return ok("");
			throw new Error("codesign died");
		});
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("returns false when --verify throws without throwing", async () => {
		const spawn = vi.fn(async (_bin: string, _args: readonly string[], _options?: SiyuanSpawnOptions) => {
			throw new Error("codesign not found");
		});
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [[, args]] = spawn.mock.calls;
		expect(args[0]).toBe("--verify");
		expect(args[1]).toBe("--strict");
	});

	it("returns false when metadata omits the official team id", async () => {
		const spawn = fakeCodesignSpawn(CLI_PATH, 0, 0, `TeamIdentifier=WRONGTENANT\nIdentifier=SiYuan-Kernel\n`);
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("returns false when metadata omits SiYuan-Kernel identifier", async () => {
		const spawn = fakeCodesignSpawn(CLI_PATH, 0, 0, `TeamIdentifier=FJT3K7XAD8\nIdentifier=Other-Binary\n`);
		const result = await verifyOfficialMacSignature(CLI_PATH, { resolveCodesign: () => "/codesign", spawn });
		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});

describe("SiyuanTool workspace resolution", () => {
	it("runs workspace list without requiring a selected workspace", async () => {
		process.env.SIYUAN_WORKSPACE_PATH = "/env/should-not-be-used";
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			expect([...args]).toEqual(["--format", "json", "workspace", "list"]);
			return workspaceList({ name: "Main", path: "/vault/main" });
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("workspace-list", { op: "workspace", args: ["list"] });

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(textOf(result)).toBe('[{"name":"Main","path":"/vault/main"}]');
		expect(result.details?.workspace).toBeUndefined();
		expect(result.details?.dryRun).toBe(false);
		expect(result.details?.binary).toBe(CLI_PATH);
		expect(result.details?.version).toBe(CLI_VERSION);
	});

	it.each(["--help", "-h"] as const)(
		"bypasses workspace resolution for top-level help flag %s even with multiple registered workspaces",
		async helpFlag => {
			const helpText = `Usage: siyuan notebook ${helpFlag}\n\nShow help`;
			const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
				if (args[0] === "--format" && args[2] === "workspace") {
					return workspaceList({ name: "Alpha", path: "/vault/alpha" }, { name: "Beta", path: "/vault/beta" });
				}
				expect([...args]).toEqual(["--format", "json", "notebook", helpFlag]);
				return ok(helpText);
			});
			const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

			const result = await tool.execute("notebook-help", { op: "notebook", args: [helpFlag] });

			expect(spawn.mock.calls.map(([, args]) => [...args])).toEqual([["--format", "json", "notebook", helpFlag]]);
			expect(result.details?.workspace).toBeUndefined();
			expect(result.details?.dryRun).toBe(false);
			expect(textOf(result)).toBe(helpText);
		},
	);

	it("auto-selects the only registered workspace", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect([...args]).toEqual(["--workspace", "/vault/main", "--format", "json", "notebook", "list"]);
			return ok('[{"id":"nb-main"}]');
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("notebook-list", { op: "notebook", args: ["list"] });

		expect(spawn.mock.calls.map(([, args]) => [...args])).toEqual([
			["--format", "json", "workspace", "list"],
			["--workspace", "/vault/main", "--format", "json", "notebook", "list"],
		]);
		expect(result.details?.workspace).toBe("/vault/main");
		expect(result.details?.dryRun).toBe(false);
		expect(textOf(result)).toBe('[{"id":"nb-main"}]');
	});

	it("fails when multiple workspaces are registered and none was specified", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			expect([...args]).toEqual(["--format", "json", "workspace", "list"]);
			return workspaceList({ name: "Alpha", path: "/vault/alpha" }, { name: "Beta", path: "/vault/beta" });
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		await expect(tool.execute("doc-search", { op: "document", args: ["search", "roadmap"] })).rejects.toThrow(
			/Multiple SiYuan workspaces are registered; pass workspace explicitly\./,
		);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("resolves an explicit workspace name to its registered path", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Alpha", path: "/vault/alpha" }, { name: "Beta", path: "/vault/beta" });
			}
			expect([...args]).toEqual(["--workspace", "/vault/beta", "--format", "json", "document", "search", "draft"]);
			return ok('{"hits":1}');
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("doc-search", {
			op: "document",
			args: ["search", "draft"],
			workspace: "Beta",
		});

		expect(result.details?.workspace).toBe("/vault/beta");
		expect(textOf(result)).toBe('{"hits":1}');
	});
});

describe("SiyuanTool execution guards", () => {
	it("adds --dry-run by default for mutating operations and marks the result as dryRun", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect([...args]).toEqual([
				"--workspace",
				"/vault/main",
				"--format",
				"json",
				"--dry-run",
				"block",
				"update",
				"--id",
				"20240720",
				"--data",
				"Updated body",
			]);
			return ok("preview ok");
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("block-update-preview", {
			op: "block",
			args: ["update", "--id", "20240720", "--data", "Updated body"],
		});

		expect(result.details?.dryRun).toBe(true);
		expect(textOf(result)).toBe("Dry run only; no data changed.\n\npreview ok");
	});

	it("omits --dry-run when dryRun is false and reports a real write", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect([...args]).toEqual([
				"--workspace",
				"/vault/main",
				"--format",
				"json",
				"block",
				"update",
				"--id",
				"20240720",
				"--data",
				"Updated body",
			]);
			return ok("write ok");
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("block-update-live", {
			op: "block",
			args: ["update", "--id", "20240720", "--data", "Updated body"],
			dryRun: false,
		});

		expect(result.details?.dryRun).toBe(false);
		expect(textOf(result)).toBe("write ok");
	});

	it("executes SELECT queries through siyuan sql", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect([...args]).toEqual([
				"--workspace",
				"/vault/main",
				"--format",
				"json",
				"sql",
				"SELECT id FROM blocks LIMIT 1",
			]);
			return ok('[{"id":"block-1"}]');
		});
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("sql-select", {
			op: "sql",
			args: ["SELECT id FROM blocks LIMIT 1"],
		});

		expect(result.details?.dryRun).toBe(false);
		expect(textOf(result)).toBe('[{"id":"block-1"}]');
	});

	it("rejects non-SELECT SQL before spawning the CLI", async () => {
		const spawn = vi.fn(async () => ok("should not run"));
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, spawn as never);

		await expect(tool.execute("sql-delete", { op: "sql", args: ["DELETE FROM blocks"] })).rejects.toThrow(
			/siyuan sql only permits SELECT queries/,
		);
		expect(spawn).not.toHaveBeenCalled();
	});
});
describe("SiyuanTool plan mode", () => {
	function planModeSession(): ToolSession {
		return {
			cwd: "/tmp/siyuan-test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
		} as unknown as ToolSession;
	}

	it("allows read-only operations in plan mode", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect([...args]).toEqual(["--workspace", "/vault/main", "--format", "json", "document", "search", "draft"]);
			return ok('[{"id":"doc-1"}]');
		});
		const tool = new SiyuanTool(planModeSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("doc-search", { op: "document", args: ["search", "draft"] });

		expect(result.details?.dryRun).toBe(false);
		expect(textOf(result)).toBe('[{"id":"doc-1"}]');
	});

	it("allows default dry-run mutations in plan mode", async () => {
		const spawn = vi.fn(async (_binary: string, args: readonly string[], _options?: SiyuanSpawnOptions) => {
			if (args[0] === "--format" && args[2] === "workspace") {
				return workspaceList({ name: "Main", path: "/vault/main" });
			}
			expect(args).toContain("--dry-run");
			return ok("preview ok");
		});
		const tool = new SiyuanTool(planModeSession(), DETECTED_CLI, spawn);

		const result = await tool.execute("block-update-preview", {
			op: "block",
			args: ["update", "--id", "b1", "--data", "preview only"],
		});

		expect(result.details?.dryRun).toBe(true);
	});

	it("rejects dryRun:false mutations in plan mode before spawning the CLI", async () => {
		const spawn = vi.fn(async () => ok("should not run"));
		const tool = new SiyuanTool(planModeSession(), DETECTED_CLI, spawn as never);

		await expect(
			tool.execute("block-update-live", {
				op: "block",
				args: ["update", "--id", "b1", "--data", "live write"],
				dryRun: false,
			}),
		).rejects.toThrow("Plan mode: SiYuan mutations are not allowed.");
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("SiyuanTool approval", () => {
	it("returns read for read-only and preview operations, write for local real writes, and exec for sync", () => {
		const tool = new SiyuanTool(createSession(), DETECTED_CLI, vi.fn(async () => ok("")) as never);

		expect(tool.approval({ op: "document", args: ["search", "draft"] })).toBe("read");
		expect(tool.approval({ op: "block", args: ["update", "--id", "b1", "--data", "preview"] })).toBe("read");
		expect(tool.approval({ op: "block", args: ["update", "--id", "b1", "--data", "live"], dryRun: false })).toBe(
			"write",
		);
		expect(tool.approval({ op: "sync", args: ["push"] })).toBe("exec");
	});
});
