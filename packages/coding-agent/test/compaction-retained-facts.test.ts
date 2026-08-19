import { expect, test } from "bun:test";
import { renderCompactionSummaryContext } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { toolOperationKey } from "@oh-my-pi/pi-agent-core/compaction/pruning";

import { withCompactionRetainedFacts } from "../src/session/compaction-retained-facts";

const gitStatusOperationKey = toolOperationKey("bash", { command: "git status" });

const usage = {
	input: 4,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

const todoPhases = [
	{
		name: "Implementation",
		tasks: [
			{ content: "pending task", status: "pending" },
			{ content: "active task", status: "in_progress" },
			{ content: "blocked task", status: "blocked", blocker: "dependency" },
			{ content: "done task", status: "completed" },
			{ content: "dropped task", status: "abandoned" },
		],
	},
];

const workspaceCheckpoint = {
	type: "workspace_checkpoint",
	id: "wc-entry",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	checkpointId: "cp-1",
	workspaceId: "ws-1",
	rootPath: "/tmp/project",
	reason: "turn",
	label: "before test",
	manifestObjectId: "manifest-1",
	fileCount: 1,
	totalBytes: 10,
	guardCheckpointId: null,
	createdAt: new Date(0).toISOString(),
};

const bashToolCall = (command: string) => ({
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "bash-1",
			name: "bash",
			arguments: { command },
		},
	],
	api: "openai-responses",
	provider: "test",
	model: "test-model",
	usage,
	stopReason: "toolUse",
	timestamp: 0,
});

const bashResult = (text: string, exitCode: number) => ({
	role: "toolResult",
	toolCallId: "bash-1",
	toolName: "bash",
	content: [{ type: "text", text }],
	details: { exitCode },
	isError: exitCode !== 0,
	timestamp: 1,
});

const preparation = (messagesToSummarize: unknown[], recentMessages: unknown[] = []) =>
	({
		firstKeptEntryId: "keep",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages,
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, keepRecentTokens: 20_000 },
	}) as Parameters<typeof withCompactionRetainedFacts>[1];

const baseCompactionDetails = { readFiles: [], modifiedFiles: [] };

const factsFromFailedBash = () =>
	withCompactionRetainedFacts(
		baseCompactionDetails,
		preparation([bashToolCall("git status"), bashResult("command failed; inspect artifact://7", 1)]),
		[workspaceCheckpoint] as Parameters<typeof withCompactionRetainedFacts>[2],
		todoPhases as Parameters<typeof withCompactionRetainedFacts>[3],
	).retainedFacts;

test("retains failed commands, unresolved work, artifacts, and checkpoints while resolving a later success", () => {
	const facts = factsFromFailedBash();

	expect(facts).toEqual(
		expect.objectContaining({
			todos: expect.arrayContaining([
				expect.objectContaining({ content: "pending task", status: "pending" }),
				expect.objectContaining({ content: "active task", status: "in_progress" }),
				expect.objectContaining({ content: "blocked task", status: "blocked" }),
			]),
			commands: expect.arrayContaining([
				expect.objectContaining({
					command: "git status",
					outcome: "failed",
					exitCode: 1,
				}),
			]),
			unresolvedFailures: expect.arrayContaining([
				expect.objectContaining({ tool: "bash", operation: "git status" }),
			]),
			recoverableUris: expect.arrayContaining(["artifact://7"]),
			workspaceCheckpoint: expect.objectContaining({ id: "cp-1" }),
		}),
	);
	expect(facts?.todos).not.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ content: "done task" }),
			expect.objectContaining({ content: "dropped task" }),
		]),
	);

	const previousCompaction = {
		type: "compaction",
		id: "previous-compaction",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: "previous summary",
		firstKeptEntryId: "keep",
		tokensBefore: 100,
		details: {
			readFiles: [],
			modifiedFiles: [],
			retainedFacts: {
				todos: [],
				commands: [],
				unresolvedFailures: [
					{
						operationKey: gitStatusOperationKey,
						tool: "bash",
						operation: "git status",
						error: "exit code 1",
					},
				],
				recoverableUris: ["history://old"],
			},
		},
	};
	const resolved = withCompactionRetainedFacts(
		baseCompactionDetails,
		preparation([], [bashToolCall("git status"), bashResult("clean", 0)]),
		[previousCompaction, workspaceCheckpoint] as Parameters<typeof withCompactionRetainedFacts>[2],
		todoPhases as Parameters<typeof withCompactionRetainedFacts>[3],
	);

	expect(resolved.retainedFacts).toBeDefined();
	const resolvedFacts = resolved.retainedFacts;
	if (!resolvedFacts) throw new Error("Expected retained facts");

	expect(resolvedFacts.unresolvedFailures).not.toContainEqual(
		expect.objectContaining({ operationKey: gitStatusOperationKey }),
	);
	expect(resolvedFacts.recoverableUris).toEqual(expect.arrayContaining(["history://old"]));
});

test("renders retained facts without changing summaries that have none", () => {
	const facts = factsFromFailedBash();
	const summary = "Summarized prior context.";
	const rendered = renderCompactionSummaryContext(summary, facts);

	expect(rendered).toContain("<retained-facts>");
	expect(rendered).toContain("pending task");
	expect(rendered).toContain("git status");
	expect(rendered).toContain("artifact://7");
	expect(rendered).toContain("cp-1");
	expect(renderCompactionSummaryContext(summary, undefined)).toBe(summary);
});
