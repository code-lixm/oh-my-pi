import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import {
	TaskRequestConcurrency,
	wrapStreamFnWithTaskConcurrency,
} from "@oh-my-pi/pi-coding-agent/task/request-concurrency";

type WrappedStream = Awaited<ReturnType<StreamFn>>;

const CONTEXT = { messages: [] } as unknown as Context;
const ANTHROPIC = { provider: "anthropic", id: "claude-sonnet-4-5" } as unknown as Model;
const OPENAI = { provider: "openai", id: "gpt-5" } as unknown as Model;

function controlledStream(): {
	stream: WrappedStream;
	resolve: (value: string) => void;
	reject: (reason?: unknown) => void;
} {
	const gate = Promise.withResolvers<string>();
	return {
		stream: { result: () => gate.promise } as unknown as WrappedStream,
		resolve: gate.resolve,
		reject: gate.reject,
	};
}

describe("TaskRequestConcurrency", () => {
	it("tracks active and queued snapshots while a second stream waits at the root limit", async () => {
		const limiter = new TaskRequestConcurrency(() => 1);
		const first = controlledStream();
		const second = controlledStream();
		const started: string[] = [];
		let call = 0;
		const wrapped = wrapStreamFnWithTaskConcurrency(limiter, async model => {
			started.push(String((model as { provider?: string }).provider));
			call += 1;
			return call === 1 ? first.stream : second.stream;
		});

		const firstRun = await wrapped(ANTHROPIC, CONTEXT);
		expect(firstRun).toBe(first.stream);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		const secondRun = wrapped(OPENAI, CONTEXT);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 1, limit: 1 });
		expect(started).toEqual(["anthropic"]);

		first.resolve("first done");
		const secondStream = await secondRun;
		expect(secondStream).toBe(second.stream);
		expect(started).toEqual(["anthropic", "openai"]);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		second.resolve("second done");
		await Promise.all([first.stream.result(), second.stream.result()]);
		expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
	});

	it("releases the permit when stream construction throws before a stream is returned", async () => {
		const limiter = new TaskRequestConcurrency(() => 1);
		const fallback = controlledStream();
		let call = 0;
		const wrapped = wrapStreamFnWithTaskConcurrency(limiter, async () => {
			call += 1;
			if (call === 1) throw new Error("provider setup failed");
			return fallback.stream;
		});

		let constructionError: unknown;
		try {
			await wrapped(ANTHROPIC, CONTEXT);
		} catch (error) {
			constructionError = error;
		}
		expect(constructionError).toBeInstanceOf(Error);
		expect((constructionError as Error).message).toBe("provider setup failed");
		expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });

		const recovered = await wrapped(OPENAI, CONTEXT);
		expect(recovered).toBe(fallback.stream);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		fallback.resolve("recovered");
		await fallback.stream.result();
		expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
	});

	it("releases the permit after an aborted stream result rejects", async () => {
		const limiter = new TaskRequestConcurrency(() => 1);
		const first = controlledStream();
		const second = controlledStream();
		let call = 0;
		const wrapped = wrapStreamFnWithTaskConcurrency(limiter, async () => {
			call += 1;
			return call === 1 ? first.stream : second.stream;
		});

		const firstStream = await wrapped(ANTHROPIC, CONTEXT);
		const secondRun = wrapped(OPENAI, CONTEXT);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 1, limit: 1 });

		first.reject(new Error("stream aborted"));
		const secondStream = await secondRun;
		expect(secondStream).toBe(second.stream);
		let abortError: unknown;
		try {
			await firstStream.result();
		} catch (error) {
			abortError = error;
		}
		expect(abortError).toBeInstanceOf(Error);
		expect((abortError as Error).message).toBe("stream aborted");
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		second.resolve("continued");
		await second.stream.result();
		expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
	});

	it("shares one total limit across different providers and independently wrapped child streams", async () => {
		const limiter = new TaskRequestConcurrency(() => 1);
		const parent = controlledStream();
		const child = controlledStream();
		const started: string[] = [];
		const parentWrapped = wrapStreamFnWithTaskConcurrency(limiter, async model => {
			started.push(`parent:${String((model as { provider?: string }).provider)}`);
			return parent.stream;
		});
		const childWrapped = wrapStreamFnWithTaskConcurrency(limiter, async model => {
			started.push(`child:${String((model as { provider?: string }).provider)}`);
			return child.stream;
		});

		const parentStream = await parentWrapped(ANTHROPIC, CONTEXT);
		expect(parentStream).toBe(parent.stream);

		const childRun = childWrapped(OPENAI, CONTEXT);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 1, limit: 1 });
		expect(started).toEqual(["parent:anthropic"]);

		parent.resolve("parent turn finished before child request");
		const childStream = await childRun;
		expect(childStream).toBe(child.stream);
		expect(started).toEqual(["parent:anthropic", "child:openai"]);
		expect(limiter.snapshot()).toEqual({ active: 1, queued: 0, limit: 1 });

		child.resolve("child done");
		await Promise.all([parent.stream.result(), child.stream.result()]);
		expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
	});
});
