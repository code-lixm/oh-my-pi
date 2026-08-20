import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { OmpToolPart } from "../shared/omp-view-model";
import type { WebSessionRecord } from "./domain";
import { projectMessages } from "./projection";

const session: WebSessionRecord = {
	id: "session_1",
	projectID: "project_1",
	directory: "/repo",
	title: "Projection fixture",
	createdAt: 1,
	updatedAt: 1,
};

function assistantToolCall(tool: string, input: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		timestamp: 100,
		model: "model",
		provider: "provider",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		content: [{ type: "toolCall", id: "call_1", name: tool, arguments: input }],
	};
}

function toolResult(tool: string, content: unknown, details: unknown): AgentMessage {
	return {
		role: "toolResult",
		timestamp: 101,
		toolCallId: "call_1",
		toolName: tool,
		isError: false,
		content,
		details,
	};
}

function completedTool(messages: AgentMessage[]): OmpToolPart {
	const part = projectMessages(messages, session)
		.flatMap(message => message.parts)
		.find(part => part.type === "tool");
	if (part?.type !== "tool" || part.state.status !== "completed") {
		throw new Error("Expected a completed projected tool part");
	}
	return part;
}

describe("projectMessages", () => {
	test.each([
		{ tool: "read", path: "/repo/src/read.ts", output: "read-result-marker" },
		{ tool: "write", path: "/repo/src/write.ts", output: "write-result-marker" },
		{ tool: "edit", path: "/repo/src/edit.ts", output: "edit-result-marker" },
	])("normalizes $tool path to filePath while retaining the tool output", ({ tool, path, output }) => {
		const part = completedTool([assistantToolCall(tool, { path }), toolResult(tool, output, {})]);

		if (part.state.status !== "completed") throw new Error("Expected completed state");
		expect(part.state.input).toMatchObject({ path, filePath: path });
		expect(part.state.output).toBe(output);
	});

	test("normalizes a single-file OMP edit result into filediff and files", () => {
		const path = "/repo/src/single.ts";
		const patch = "@@ -1 +1 @@\n-before\n+after";
		const part = completedTool([
			assistantToolCall("edit", { path }),
			toolResult("edit", "single-edit-output-marker", {
				path,
				diff: patch,
				oldText: "before\n",
				newText: "after\n",
			}),
		]);

		if (part.state.status !== "completed") throw new Error("Expected completed state");
		expect(part.state.output).toBe("single-edit-output-marker");
		expect(part.state.metadata).toMatchObject({
			filediff: {
				file: path,
				patch,
				before: "before\n",
				after: "after\n",
				additions: 1,
				deletions: 1,
			},
			files: [
				{
					filePath: path,
					relativePath: path,
					patch,
					before: "before\n",
					after: "after\n",
					additions: 1,
					deletions: 1,
				},
			],
		});
	});

	test("normalizes OMP perFileResults into Web files without inventing a single filediff", () => {
		const firstPath = "/repo/src/first.ts";
		const secondPath = "/repo/src/second.ts";
		const firstPatch = "@@ -1 +1 @@\n-old-first\n+new-first";
		const secondPatch = "@@ -1 +1 @@\n-old-second\n+new-second";
		const part = completedTool([
			assistantToolCall("edit", { paths: [firstPath, secondPath] }),
			toolResult("edit", "multi-edit-output-marker", {
				diff: `${firstPatch}\n${secondPatch}`,
				perFileResults: [
					{ path: firstPath, diff: firstPatch, oldText: "old-first\n", newText: "new-first\n" },
					{ path: secondPath, diff: secondPatch, oldText: "old-second\n", newText: "new-second\n" },
				],
			}),
		]);

		if (part.state.status !== "completed") throw new Error("Expected completed state");
		expect(part.state.output).toBe("multi-edit-output-marker");
		expect(part.state.metadata).toMatchObject({
			files: [
				{
					filePath: firstPath,
					relativePath: firstPath,
					patch: firstPatch,
					before: "old-first\n",
					after: "new-first\n",
					additions: 1,
					deletions: 1,
				},
				{
					filePath: secondPath,
					relativePath: secondPath,
					patch: secondPatch,
					before: "old-second\n",
					after: "new-second\n",
					additions: 1,
					deletions: 1,
				},
			],
		});
		expect(part.state.metadata).not.toHaveProperty("filediff");
	});

	test.each([
		{ name: "a completed shell execution", exitCode: 0, expectedStatus: "completed" as const },
		{ name: "a non-zero shell execution", exitCode: 17, expectedStatus: "error" as const },
	])(
		"projects $name into a synthetic request and parented Bash tool instead of an orphan card",
		({ exitCode, expectedStatus }) => {
			const command = "printf bash-projection-command";
			const output = "bash-projection-output";
			const projected = projectMessages(
				[
					{
						role: "bashExecution",
						timestamp: 102,
						command,
						output,
						exitCode,
						cancelled: false,
						truncated: false,
					},
				],
				session,
			);

			expect(projected).toHaveLength(2);
			const [request, response] = projected;
			if (request?.info.role !== "user" || response?.info.role !== "assistant") {
				throw new Error("Expected a synthetic shell request followed by an assistant tool response");
			}
			expect(request.parts).toEqual([
				expect.objectContaining({ type: "text", messageID: request.info.id, text: command }),
			]);
			expect(response.info.parentID).toBe(request.info.id);

			const [part] = response.parts;
			if (part?.type !== "tool") throw new Error("Expected the synthetic shell response to contain a tool");
			expect(part.tool).toBe("bash");
			expect(part.state.status).toBe(expectedStatus);
			expect(part.state.metadata).toMatchObject({ exitCode, output });
			if (part.state.status === "completed") {
				expect(part.state.output).toBe(output);
			} else {
				expect(part.state.error).toContain(`Command exited with code ${exitCode}`);
				expect(part.state.error).toContain(output);
			}
		},
	);

	test("preserves a user text-image-text sequence so attachments retain their intended position", () => {
		const image = {
			type: "image" as const,
			data: "dXNlci1hdHRhY2htZW50",
			mimeType: "image/png",
		};
		const projected = projectMessages(
			[
				{
					role: "user",
					timestamp: 110,
					content: [
						{ type: "text", text: "before attachment" },
						image,
						{ type: "text", text: "after attachment" },
					],
				},
			],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "user") throw new Error("Expected a projected user message");
		expect(message.parts.map(part => part.type)).toEqual(["text", "file", "text"]);
		expect(message.parts[0]).toMatchObject({ type: "text", text: "before attachment" });
		const attachment = message.parts[1];
		if (attachment?.type !== "file") throw new Error("Expected the user attachment to remain a file part");
		expect(attachment).toMatchObject({
			messageID: message.info.id,
			mime: "image/png",
			url: "data:image/png;base64,dXNlci1hdHRhY2htZW50",
		});
		expect(attachment.source).toBeUndefined();
		expect(message.parts[2]).toMatchObject({ type: "text", text: "after attachment" });
	});

	test("projects assistant image blocks as file parts instead of discarding generated media", () => {
		const image = {
			type: "image" as const,
			data: "YXNzaXN0YW50LWltYWdl",
			mimeType: "image/png",
		};
		const projected = projectMessages(
			[
				{
					role: "assistant",
					timestamp: 100,
					model: "model",
					provider: "provider",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					content: [{ type: "text", text: "generated" }, image],
				},
			],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "assistant") throw new Error("Expected a projected assistant message");
		expect(message.parts.map(part => part.type)).toEqual(["text", "file"]);
		const attachment = message.parts[1];
		if (attachment?.type !== "file") throw new Error("Expected the assistant image to remain a file part");
		expect(attachment).toMatchObject({
			messageID: message.info.id,
			mime: "image/png",
			url: "data:image/png;base64,YXNzaXN0YW50LWltYWdl",
		});
		expect(attachment.source).toBeUndefined();
	});

	test("keeps mixed tool-result text and image content in the originating assistant message", () => {
		const image = {
			type: "image" as const,
			data: "dG9vbC1yZXN1bHQtaW1hZ2U=",
			mimeType: "image/png",
		};
		const projected = projectMessages(
			[
				assistantToolCall("read", { path: "/repo/mixed-result.ts" }),
				toolResult("read", [{ type: "text", text: "tool result text" }, image], {}),
			],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "assistant") {
			throw new Error("Expected the tool result to stay on its assistant message");
		}
		const tool = message.parts.find(part => part.type === "tool");
		if (tool?.type !== "tool" || tool.state.status !== "completed") {
			throw new Error("Expected the matching tool to complete");
		}
		expect(tool.state.output).toBe("tool result text");
		const attachment = message.parts.find(part => part.type === "file");
		if (attachment?.type !== "file") throw new Error("Expected a tool-result image sibling");
		expect(attachment).toMatchObject({
			messageID: message.info.id,
			mime: "image/png",
			url: "data:image/png;base64,dG9vbC1yZXN1bHQtaW1hZ2U=",
		});
		expect(attachment.source).toBeUndefined();
	});

	test("renders an orphan tool result with its text and image instead of silently dropping it", () => {
		const image = {
			type: "image" as const,
			data: "b3JwaGFuLXRvb2wtaW1hZ2U=",
			mimeType: "image/png",
		};
		const projected = projectMessages(
			[toolResult("read", [{ type: "text", text: "orphan tool output" }, image], {})],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "assistant") {
			throw new Error("Expected an orphan tool result to create an assistant message");
		}
		expect(message.parts).toHaveLength(2);
		const tool = message.parts.find(part => part.type === "tool");
		if (tool?.type !== "tool" || tool.state.status !== "completed") {
			throw new Error("Expected an orphan tool result to expose a completed tool");
		}
		expect(tool.tool).toBe("read");
		expect(tool.callID).toBe("call_1");
		expect(tool.state.output).toBe("orphan tool output");
		const attachment = message.parts.find(part => part.type === "file");
		if (attachment?.type !== "file") throw new Error("Expected an orphan tool-result image sibling");
		expect(attachment).toMatchObject({
			messageID: message.info.id,
			mime: "image/png",
			url: "data:image/png;base64,b3JwaGFuLXRvb2wtaW1hZ2U=",
		});
	});

	test("projects compaction frames as downloadable resources while retaining semantic summary metadata", () => {
		const images = [
			{
				type: "image" as const,
				data: "Y29tcGFjdGlvbi1pbWFnZQ==",
				mimeType: "image/png",
			},
			{
				type: "image" as const,
				data: "c2Vjb25kLWNvbXBhY3Rpb24taW1hZ2U=",
				mimeType: "image/webp",
			},
		];
		const projected = projectMessages(
			[
				{
					role: "compactionSummary",
					timestamp: 120,
					summary: "Compacted earlier work",
					tokensBefore: 8_192,
					warning: "Retained facts need review",
					images,
				},
				{
					role: "branchSummary",
					timestamp: 121,
					fromId: "branch-source",
					summary: "Branch context",
				},
			],
			session,
		);
		expect(projected).toHaveLength(2);
		const [compaction, branch] = projected;

		if (compaction?.info.role !== "assistant" || branch?.info.role !== "assistant") {
			throw new Error("Expected semantic summary messages to project as assistant messages");
		}
		const compactionPart = compaction.parts.find(part => part.type === "compaction");
		if (compactionPart?.type !== "compaction") throw new Error("Expected a compaction summary part");
		expect(compactionPart).toMatchObject({
			auto: true,
			summary: "Compacted earlier work",
			warning: "Retained facts need review",
			tokensBefore: 8_192,
		});
		const attachments = compaction.parts.filter(part => part.type === "file");
		expect(attachments).toHaveLength(2);
		expect(attachments).toMatchObject([
			{
				messageID: compaction.info.id,
				mime: "image/png",
				url: "data:image/png;base64,Y29tcGFjdGlvbi1pbWFnZQ==",
				source: {
					type: "resource",
					clientName: "omp-snapcompact",
					uri: `omp://snapcompact/${session.id}/${compaction.info.id}/1`,
				},
			},
			{
				messageID: compaction.info.id,
				mime: "image/webp",
				url: "data:image/webp;base64,c2Vjb25kLWNvbXBhY3Rpb24taW1hZ2U=",
				source: {
					type: "resource",
					clientName: "omp-snapcompact",
					uri: `omp://snapcompact/${session.id}/${compaction.info.id}/2`,
				},
			},
		]);

		const branchPart = branch.parts.find(part => part.type === "compaction");
		if (branchPart?.type !== "compaction") throw new Error("Expected a branch summary compaction part");
		expect(branchPart).toMatchObject({ auto: false, summary: "Branch context" });
	});

	test("marks an aborted assistant stop as MessageAbortedError for interrupted-turn consumers", () => {
		const projected = projectMessages(
			[
				{
					role: "assistant",
					timestamp: 101,
					model: "model",
					provider: "provider",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "aborted",
					content: [{ type: "text", text: "partial response" }],
				},
			],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "assistant") throw new Error("Expected a projected assistant message");
		expect(message.info.finish).toBe("aborted");
		expect(message.info.error).toEqual(
			expect.objectContaining({
				name: "MessageAbortedError",
				data: expect.objectContaining({ message: expect.any(String) }),
			}),
		);
	});

	test("omits custom and hook events explicitly marked display false", () => {
		const projected = projectMessages(
			[
				{
					role: "custom",
					customType: "hidden-custom",
					content: [
						{ type: "text", text: "do not render custom" },
						{ type: "image", data: "aGlkZGVuLWN1c3RvbQ==", mimeType: "image/png" },
					],
					display: false,
					timestamp: 130,
				},
				{
					role: "hookMessage",
					customType: "hidden-hook",
					content: [
						{ type: "text", text: "do not render hook" },
						{ type: "image", data: "aGlkZGVuLWhvb2s=", mimeType: "image/png" },
					],
					display: false,
					timestamp: 131,
				},
			],
			session,
		);

		expect(projected).toEqual([]);
	});

	test.each([
		{ role: "custom" as const, customType: "displayed-custom", imageData: "Y3VzdG9tLWltYWdl" },
		{ role: "hookMessage" as const, customType: "displayed-hook", imageData: "aG9vay1pbWFnZQ==" },
	])("retains image attachments from display-true $role events", ({ role, customType, imageData }) => {
		const image = {
			type: "image" as const,
			data: imageData,
			mimeType: "image/png",
		};
		const projected = projectMessages(
			[
				{
					role,
					customType,
					content: [{ type: "text", text: `${customType} text` }, image],
					display: true,
					timestamp: 140,
				},
			],
			session,
		);
		expect(projected).toHaveLength(1);
		const [message] = projected;

		if (message?.info.role !== "assistant") throw new Error("Expected a displayed extension event");
		const attachment = message.parts.find(part => part.type === "file");
		if (attachment?.type !== "file") throw new Error("Expected a displayed extension image sibling");
		expect(attachment).toMatchObject({
			messageID: message.info.id,
			mime: "image/png",
			url: `data:image/png;base64,${imageData}`,
		});
	});
});
