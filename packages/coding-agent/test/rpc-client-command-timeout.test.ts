/**
 * Regression tests for per-command RPC timeout budgets.
 *
 * A child handler that blocks on a full LLM round trip (handoff generation,
 * compaction, tree summaries, BTW answers) must not inherit the 30-second
 * interactive budget: with it, the client gave up while the child kept
 * generating and committed the session switch anyway, so the user saw
 * "Timeout waiting for response to handoff" for a handoff that actually
 * happened.
 *
 * The budget is observed through the registered `setTimeout` delay rather than
 * fake timers: `#send` arms its timer synchronously, so that delay is the exact
 * contract, while advancing 10 minutes of fake time would also have to drive
 * the transport's async iterator (Bun fake timers + async generators are a
 * hanging-test hazard).
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcTransport } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-transport";

class InMemoryRpcTransport implements RpcTransport {
	readonly writes: Record<string, unknown>[] = [];
	stderrText = "";
	writeHandler: ((frame: unknown) => void) | undefined;
	#incoming: unknown[] = [];
	#waiter: (() => void) | undefined;
	#stopped = false;

	async start(): Promise<void> {
		this.#stopped = false;
		this.send({ type: "ready" });
	}

	async *read(signal: AbortSignal): AsyncIterable<unknown> {
		while (!signal.aborted && !this.#stopped) {
			const frame = this.#incoming.shift();
			if (frame !== undefined) {
				yield frame;
				continue;
			}
			await new Promise<void>(resolve => {
				const wake = () => {
					signal.removeEventListener("abort", wake);
					if (this.#waiter === wake) this.#waiter = undefined;
					resolve();
				};
				this.#waiter = wake;
				signal.addEventListener("abort", wake, { once: true });
				if (signal.aborted || this.#stopped) wake();
			});
		}
	}

	write(frame: unknown): void {
		this.writes.push(frame as Record<string, unknown>);
		this.writeHandler?.(frame);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#wake();
	}

	getStderr(): string {
		return this.stderrText;
	}

	onClose(_listener: () => void): () => void {
		return () => undefined;
	}

	onError(_listener: (error: Error) => void): () => void {
		return () => undefined;
	}

	send(frame: unknown): void {
		this.#incoming.push(frame);
		this.#wake();
	}

	#wake(): void {
		const wake = this.#waiter;
		this.#waiter = undefined;
		wake?.();
	}
}

/** Answer every command with a success response except the listed ones. */
function installResponder(transport: InMemoryRpcTransport, ignore: readonly string[] = []): void {
	transport.writeHandler = frame => {
		const command = frame as { id?: string; type?: string };
		if (typeof command.id !== "string" || typeof command.type !== "string") return;
		if (ignore.includes(command.type)) return;
		transport.send({ id: command.id, type: "response", command: command.type, success: true });
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RpcClient command timeout budgets", () => {
	test("handoff gets the 10-minute budget instead of the interactive 30s", async () => {
		const transport = new InMemoryRpcTransport();
		installResponder(transport, ["handoff"]);
		const client = new RpcClient({ transport });
		await client.start();
		const spy = vi.spyOn(globalThis, "setTimeout");
		const pending = client.handoff();
		// `#send` arms its budget synchronously before it awaits the response.
		const delays = spy.mock.calls.map(call => call[1]);
		expect(delays).toContain(600_000);
		expect(delays).not.toContain(30_000);
		await client.stop();
		await pending.catch(() => undefined);
	});

	test("interactive commands keep the 30-second budget", async () => {
		const transport = new InMemoryRpcTransport();
		installResponder(transport, ["get_session_stats"]);
		const client = new RpcClient({ transport });
		await client.start();
		const spy = vi.spyOn(globalThis, "setTimeout");
		const pending = client.getSessionStats();
		const delays = spy.mock.calls.map(call => call[1]);
		expect(delays).toContain(30_000);
		expect(delays).not.toContain(600_000);
		await client.stop();
		await pending.catch(() => undefined);
	});

	test("timeout errors cap the echoed stderr and keep its tail", async () => {
		const transport = new InMemoryRpcTransport();
		transport.stderrText =
			"MallocStackLogging: can't turn off malloc stack logging because it was not enabled.\n".repeat(100) +
			"real failure line";
		const client = new RpcClient({ transport });
		await client.start();
		let message = "";
		try {
			await client.waitForIdle(1);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		await client.stop();

		expect(message).toContain("Timeout waiting for agent to become idle");
		expect(message).toContain("real failure line");
		expect(message.length).toBeLessThan(2500);
		const marker = message.indexOf("\u2026");
		expect(marker).toBeGreaterThan(-1);
		expect(message.length - marker - 1).toBeLessThanOrEqual(2000);
	});
});
