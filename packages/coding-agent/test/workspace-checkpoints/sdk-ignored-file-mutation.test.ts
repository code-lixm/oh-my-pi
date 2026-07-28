import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as git from "../../src/utils/git";
import { objectPathFor } from "../../src/workspace-checkpoints/content-store";
import { workspaceIdForRoot } from "../../src/workspace-checkpoints/store";

const roots: string[] = [];
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_ASKPASS: "true",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
}

async function createGitWorkspace(label: string): Promise<{ agentDir: string; repo: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-sdk-ignored-baseline-${label}-`));
	roots.push(root);
	const physicalParent = path.join(root, "physical");
	const workspace = path.join(physicalParent, "workspace");
	const linkedParent = path.join(root, "workspace-parent-link");
	const repo = path.join(linkedParent, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await runGit(workspace, ["init", "-q", "-b", "main"]);
	await runGit(workspace, ["config", "user.name", "Test User"]);
	await runGit(workspace, ["config", "user.email", "test@example.com"]);
	await fs.writeFile(path.join(workspace, ".gitignore"), "ignored/\n", "utf8");
	await runGit(workspace, ["add", ".gitignore"]);
	await runGit(workspace, ["commit", "-q", "--no-gpg-sign", "-m", "baseline"]);
	await fs.symlink(physicalParent, linkedParent, "dir");
	return { agentDir, repo };
}

async function createSdkSession(repo: string, agentDir: string) {
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled gpt-4o-mini model");
	return createAgentSession({
		cwd: repo,
		agentDir,
		agentRegistry: new AgentRegistry(),
		ownsAgentLifecycle: false,
		modelRegistry,
		sessionManager: SessionManager.inMemory(repo),
		settings: Settings.isolated({
			"edit.mode": "patch",
			"workspaceCheckpoint.auto": "off",
			"workspaceCheckpoint.enabled": true,
			"workspaceCheckpoint.failurePolicy": "block",
		}),
		model,
		disableExtensionDiscovery: true,
		enableLsp: false,
		enableMCP: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		toolNames: ["write", "edit"],
		workspaceTree: { rootPath: repo, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
}

function requireValue<T>(access: { available: boolean; value?: T }): T {
	if (!access.available || access.value === undefined) {
		throw new Error("Expected workspace checkpoint service to return a value");
	}
	return access.value;
}

beforeAll(async () => {
	authStorage = await AuthStorage.create(":memory:");
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	AsyncJobManager.resetForTests();
	await Promise.allSettled(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

afterAll(() => {
	authStorage.close();
	AsyncJobManager.resetForTests();
});

describe.skipIf(!git.isGitAvailable())("SDK ignored-path mutation baselines", () => {
	it("restores ignored update, create absence, and rename source/destination through real write and edit tools", async () => {
		const { agentDir, repo } = await createGitWorkspace("restore");
		const ignoredDir = path.join(repo, "ignored");
		const existingPath = path.join(ignoredDir, "existing.txt");
		const createdPath = path.join(ignoredDir, "created.txt");
		const sourcePath = path.join(ignoredDir, "source.txt");
		const destinationPath = path.join(ignoredDir, "destination.txt");
		await fs.mkdir(ignoredDir, { recursive: true });
		await fs.writeFile(existingPath, "existing before\n", "utf8");
		await fs.writeFile(sourcePath, "source before\n", "utf8");

		const { session } = await createSdkSession(repo, agentDir);
		try {
			const checkpoint = requireValue(
				await session.createWorkspaceCheckpoint("before ignored mutations", { rootPath: repo }),
			);
			const write = session.getToolByName("write");
			const edit = session.getToolByName("edit");
			if (!write || !edit) throw new Error("Expected SDK session to expose write and edit tools");

			const updated = await write.execute("ignored-update", {
				path: "ignored/existing.txt",
				content: "existing after\n",
			});
			const created = await write.execute("ignored-create", {
				path: "ignored/created.txt",
				content: "created after\n",
			});
			const renamed = await edit.execute("ignored-rename", {
				path: "ignored/source.txt",
				edits: [{ op: "update", rename: "ignored/destination.txt", diff: "@@\n-source before\n+source after" }],
			});
			expect(updated.isError).toBeUndefined();
			expect(created.isError).toBeUndefined();
			expect(renamed.isError).toBeUndefined();
			expect(await fs.readFile(existingPath, "utf8")).toBe("existing after\n");
			expect(await fs.readFile(createdPath, "utf8")).toBe("created after\n");
			expect(await fs.readFile(destinationPath, "utf8")).toBe("source after\n");
			expect(await Bun.file(sourcePath).exists()).toBe(false);

			const preview = requireValue(
				await session.previewWorkspaceRestore({
					checkpointId: checkpoint.id,
					scope: "code",
					strategy: "exact",
					rootPath: repo,
				}),
			);
			expect(preview.conflicts).toEqual([]);
			expect(preview.operations.map(operation => `${operation.kind}:${operation.path}`).sort()).toEqual([
				"create:ignored/source.txt",
				"delete:ignored/created.txt",
				"delete:ignored/destination.txt",
				"update:ignored/existing.txt",
			]);

			const restored = requireValue(await session.applyWorkspaceRestore(preview.id));
			expect(restored.restoredPaths.sort()).toEqual([
				"ignored/created.txt",
				"ignored/destination.txt",
				"ignored/existing.txt",
				"ignored/source.txt",
			]);
			expect(await fs.readFile(existingPath, "utf8")).toBe("existing before\n");
			expect(await fs.readFile(sourcePath, "utf8")).toBe("source before\n");
			expect(await Bun.file(createdPath).exists()).toBe(false);
			expect(await Bun.file(destinationPath).exists()).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("blocks the real WriteTool before persisting ignored bytes when baseline capture fails", async () => {
		const { agentDir, repo } = await createGitWorkspace("block");
		const blockedPath = path.join(repo, "ignored", "blocked.txt");
		await fs.mkdir(path.dirname(blockedPath), { recursive: true });
		await fs.writeFile(blockedPath, "preserve this\n", "utf8");

		const { session } = await createSdkSession(repo, agentDir);
		try {
			const checkpoint = requireValue(
				await session.createWorkspaceCheckpoint("before blocked write", { rootPath: repo }),
			);
			const contentStoreRoot = path.join(agentDir, "checkpoints", "v1", "workspaces", workspaceIdForRoot(repo));
			await fs.rm(objectPathFor(contentStoreRoot, checkpoint.manifestObjectId));

			const write = session.getToolByName("write");
			if (!write) throw new Error("Expected SDK session to expose the write tool");
			await expect(
				write.execute("blocked-ignored-write", { path: "ignored/blocked.txt", content: "must not persist\n" }),
			).rejects.toThrow(/manifest missing/i);
			expect(await fs.readFile(blockedPath, "utf8")).toBe("preserve this\n");
		} finally {
			await session.dispose();
		}
	});
});
