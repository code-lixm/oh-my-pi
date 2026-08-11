import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	AutonomousController,
	createAutonomousRuntimeState,
	refreshQualityGates,
	shouldAutonomouslyContinue,
} from "../../src/autonomous/controller";
import type { AutonomousRuntimeState } from "../../src/autonomous/types";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-autonomous-${label}-`));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function completedMessage(usage: { input: number; output: number; cacheWrite: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 10_000,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.input + usage.output + usage.cacheWrite + 10_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as AssistantMessage;
}

function enabledState(): AutonomousRuntimeState {
	const state = createAutonomousRuntimeState({
		enabled: true,
		maxContinuations: 3,
		maxTurns: 4,
		maxTokens: 5,
		timeoutMs: 6,
		continuationPrompt: "Keep investigating the observable failure.",
		gates: { commands: [], maxRetries: 2, timeoutMs: 50 },
	});
	state.startedAt = 1_000;
	return state;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const [status, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (status !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initializeRepository(cwd: string): Promise<void> {
	await runGit(cwd, ["init", "--quiet"]);
	await runGit(cwd, ["config", "user.email", "autonomous-test@example.invalid"]);
	await runGit(cwd, ["config", "user.name", "Autonomous Test"]);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "baseline\n");
	await runGit(cwd, ["add", "baseline.txt"]);
	await runGit(cwd, ["commit", "--quiet", "-m", "baseline"]);
}

describe("AutonomousController budgets and gates", () => {
	it("monotonically charges every continued assistant turn and its billable token usage", async () => {
		const controller = new AutonomousController({
			enabled: true,
			maxContinuations: 6,
			maxTurns: 6,
			maxTokens: 100,
			timeoutMs: 60_000,
			continuationPrompt: "Continue until evidence is terminal.",
			gates: { commands: [], maxRetries: 2, timeoutMs: 5_000 },
		});

		const first = await controller.checkContinuation(completedMessage({ input: 3, output: 5, cacheWrite: 7 }), {
			cwd: process.cwd(),
		});
		const afterFirst = controller.status();
		const second = await controller.checkContinuation(completedMessage({ input: 11, output: 13, cacheWrite: 17 }), {
			cwd: process.cwd(),
		});
		const afterSecond = controller.status();

		expect(first.shouldContinue).toBe(true);
		expect(second.shouldContinue).toBe(true);
		expect([afterFirst.continuationsUsed, afterFirst.turnsUsed, afterFirst.tokensUsed]).toEqual([1, 1, 15]);
		expect([afterSecond.continuationsUsed, afterSecond.turnsUsed, afterSecond.tokensUsed]).toEqual([2, 2, 56]);
		expect(afterSecond.continuationsUsed).toBeGreaterThanOrEqual(afterFirst.continuationsUsed);
		expect(afterSecond.turnsUsed).toBeGreaterThanOrEqual(afterFirst.turnsUsed);
		expect(afterSecond.tokensUsed).toBeGreaterThanOrEqual(afterFirst.tokensUsed);
	});

	it("charges the terminal assistant response before rejecting a continuation that exceeds its token budget", async () => {
		const controller = new AutonomousController({
			enabled: true,
			maxContinuations: 6,
			maxTurns: 6,
			maxTokens: 14,
			timeoutMs: 60_000,
			continuationPrompt: "Continue until evidence is terminal.",
			gates: { commands: [], maxRetries: 2, timeoutMs: 5_000 },
		});

		const decision = await controller.checkContinuation(completedMessage({ input: 3, output: 5, cacheWrite: 7 }), {
			cwd: process.cwd(),
		});

		expect(decision).toEqual({ shouldContinue: false });
		expect(controller.status()).toMatchObject({
			continuationsUsed: 0,
			turnsUsed: 1,
			tokensUsed: 15,
		});
	});

	it.each([
		{
			name: "continuations",
			consume: (state: AutonomousRuntimeState) => {
				state.continuationsUsed = state.limits.maxContinuations;
			},
			now: 1_000,
		},
		{
			name: "turns",
			consume: (state: AutonomousRuntimeState) => {
				state.turnsUsed = state.limits.maxTurns;
			},
			now: 1_000,
		},
		{
			name: "tokens",
			consume: (state: AutonomousRuntimeState) => {
				state.tokensUsed = state.limits.maxTokens;
			},
			now: 1_000,
		},
		{
			name: "elapsed runtime",
			consume: () => {},
			now: 1_006,
		},
	])("stops continuation at the exhausted $name budget boundary", async ({ consume, now }) => {
		const state = enabledState();
		consume(state);

		const decision = await shouldAutonomouslyContinue(
			state,
			completedMessage({ input: 0, output: 0, cacheWrite: 0 }),
			{},
			now,
		);

		expect(decision).toEqual({ shouldContinue: false, reason: "limit_reached" });
	});

	it.skipIf(Bun.which("git") === null)(
		"does not rerun an unchanged failed gate and exhausts its retry budget",
		async () => {
			const workspace = await makeTemporaryRoot("unchanged-gate");
			const observationRoot = await makeTemporaryRoot("gate-observation");
			const executionsPath = path.join(observationRoot, "executions.log");
			await initializeRepository(workspace);

			const command = `printf 'executed\\n' >> ${shellQuote(executionsPath)}; exit 17`;
			const state = createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 6,
				maxTurns: 6,
				maxTokens: 1_000,
				timeoutMs: 60_000,
				continuationPrompt: "Repair the failed gate with a real workspace change.",
				gates: { commands: [command], maxRetries: 2, timeoutMs: 5_000 },
			});

			const outcomes = [
				await refreshQualityGates(state, { cwd: workspace }),
				await refreshQualityGates(state, { cwd: workspace }),
				await refreshQualityGates(state, { cwd: workspace }),
			];

			expect(outcomes).toEqual(["failed", "failed", "retry_exhausted"]);
			expect(await fs.readFile(executionsPath, "utf8")).toBe("executed\n");
			expect(state.gateAttempts[command]).toBe(3);
			expect(state.lastGateFailure).toMatchObject({
				command,
				attempt: 3,
				exitText: "not rerun: workspace unchanged since previous failed gate",
			});
			expect(state.lastGateFailure?.output).toContain("workspace has not changed");
		},
	);
});
