import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>, agentId?: string) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
			agentId,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	it("keeps the primary session's manager installed after a uniquely identified secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondaryAgentId = `top-level:${Snowflake.next()}`;
			const secondary = await spawnTopLevelSession(undefined, secondaryAgentId);
			try {
				// A live top-level session with its own identity shares the process
				// manager, but observes only jobs owned by that identity.
				expect(secondary.asyncJobManager).toBe(primaryManager);
				expect(secondary.getAsyncJobSnapshot()).not.toBeNull();
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// Disposing a non-owning secondary must leave the primary's singleton
			// reachable for its own background bash and task jobs.
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("isolates a uniquely identified secondary's async bash and disposal from primary jobs", async () => {
		const asyncBashSettings = { "async.enabled": true, "bash.async.enabled": true, "async.maxJobs": 2 };
		const primary = await spawnTopLevelSession(asyncBashSettings);
		const releasePrimary = Promise.withResolvers<string>();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			if (!primaryManager) throw new Error("Expected primary async job manager");
			const primaryOwnerId = primary.getAgentId();
			if (!primaryOwnerId) throw new Error("Expected primary agent identity");

			const primaryJobId = primaryManager.register(
				"task",
				"primary running job",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([releasePrimary.promise, aborted.promise]);
					return signal.aborted ? "cancelled" : "completed";
				},
				{ ownerId: primaryOwnerId },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === primaryJobId)).toBe(true);

			const secondaryAgentId = `top-level:${Snowflake.next()}`;
			const secondary = await spawnTopLevelSession(asyncBashSettings, secondaryAgentId);
			try {
				expect(secondary.asyncJobManager).toBe(primaryManager);
				const bashTool = secondary.getToolByName("bash");
				if (!bashTool) throw new Error("Expected Bash tool");

				const result = await bashTool.execute("secondary-async-bash", { command: "sleep 60", async: true });
				const asyncDetails = result.details?.async;
				expect(asyncDetails).toEqual(expect.objectContaining({ state: "running", type: "bash" }));
				if (!asyncDetails) throw new Error("Expected secondary async Bash job");
				const secondaryJobId = asyncDetails.jobId;

				// The id returned by the tool is opaque: only its owner and visibility
				// determine whether this secondary was routed safely.
				expect(primaryManager.getJob(secondaryJobId)?.ownerId).toBe(secondaryAgentId);
				expect(primaryManager.getJob(secondaryJobId)?.status).toBe("running");
				const secondarySnapshot = secondary.getAsyncJobSnapshot();
				expect(secondarySnapshot).not.toBeNull();
				if (!secondarySnapshot) throw new Error("Expected secondary async job snapshot");
				expect(secondarySnapshot.running.some(job => job.id === secondaryJobId)).toBe(true);
				expect(secondarySnapshot.running.some(job => job.id === primaryJobId)).toBe(false);
				expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === secondaryJobId)).toBe(false);

				await secondary.dispose();

				// Session disposal cancels its own work, not another top-level
				// session's job sharing the same process manager.
				expect(primaryManager.getJob(secondaryJobId)?.status).toBe("cancelled");
				expect(primaryManager.getJob(primaryJobId)?.status).toBe("running");
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			releasePrimary.resolve("completed");
			await primaryManager.waitForAll();
		} finally {
			releasePrimary.resolve("completed");
			await primary.dispose();
		}
	}, 60000);

	it("refuses async bash from an anonymous secondary session instead of routing it to the primary's manager", async () => {
		const asyncBashSettings = { "async.enabled": true, "bash.async.enabled": true };
		const primary = await spawnTopLevelSession(asyncBashSettings);
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession(asyncBashSettings);
			try {
				expect(secondary.asyncJobManager).toBeUndefined();
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The anonymous helper cannot leak a job into the primary manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
