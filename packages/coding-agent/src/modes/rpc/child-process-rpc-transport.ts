import { isPromise } from "node:util/types";
import { ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { RpcTransport, RpcTransportCloseListener, RpcTransportErrorListener } from "./rpc-transport";

export interface ChildProcessRpcTransportOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js). */
	cliPath?: string;
	/** Full executable argv prefix; defaults to ["bun", cliPath]. */
	command?: string[];
	/** RPC transport mode; rpc-ui enables bidirectional extension UI. */
	mode?: "rpc" | "rpc-ui";
	/** Working directory for the agent. */
	cwd?: string;
	/** Environment variables. */
	env?: Record<string, string>;
	/** Provider to use. */
	provider?: string;
	/** Model ID to use. */
	model?: string;
	/** Session directory for the agent. */
	sessionDir?: string;
	/** Additional CLI arguments. */
	args?: string[];
}

/** RPC transport backed by a local coding-agent child process. */
export class ChildProcessRpcTransport implements RpcTransport {
	#process: ptree.ChildProcess | null = null;
	#reaping: Promise<void> | null = null;
	#lastStderr = "";
	#terminalError: Error | undefined;
	#stopRequested = false;
	#closeListeners = new Set<RpcTransportCloseListener>();
	#errorListeners = new Set<RpcTransportErrorListener>();

	constructor(private readonly options: ChildProcessRpcTransportOptions = {}) {}

	async start(): Promise<void> {
		await this.#reaping;
		if (this.#process) throw new Error("RPC transport already started");

		this.#stopRequested = false;
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", this.options.mode ?? "rpc"];
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
		if (this.options.args) args.push(...this.options.args);

		const command = this.options.command ?? ["bun", cliPath];
		if (command.length === 0) throw new Error("RPC command must contain an executable");

		const child = ptree.spawn([...command, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
		});
		this.#process = child;
		this.#lastStderr = "";
		this.#terminalError = undefined;

		const reaping = child.exited.then(
			exitCode => {
				this.#finish(
					child,
					this.#stopRequested
						? undefined
						: new Error(`Agent process exited with code ${exitCode}. Stderr: ${this.#stderr(child)}`),
				);
			},
			cause => {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				this.#finish(
					child,
					this.#stopRequested
						? undefined
						: new Error(`Agent process exited. Stderr: ${this.#stderr(child)}`, { cause: error }),
				);
			},
		);
		this.#reaping = reaping;
		void reaping.then(() => {
			if (this.#reaping === reaping) this.#reaping = null;
		});
	}

	read(signal: AbortSignal): AsyncIterable<unknown> {
		const child = this.#process;
		if (!child) throw new Error("RPC transport not started");
		return readJsonl(child.stdout, signal);
	}

	write(frame: unknown): Promise<void> | void {
		const child = this.#process;
		if (!child?.stdin) throw new Error("RPC transport not started");

		const stdin = child.stdin as FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) return flushResult.then(() => undefined);
	}

	async stop(): Promise<void> {
		const child = this.#process;
		const reaping = this.#reaping;
		if (!child) {
			await reaping;
			return;
		}

		this.#stopRequested = true;
		try {
			child.kill();
		} catch {
			// The process may already have exited.
		}
		await reaping;
	}

	getStderr(): string {
		return this.#process ? this.#stderr(this.#process) : this.#lastStderr;
	}

	async waitForClose(timeoutMs: number): Promise<Error | undefined> {
		const reaping = this.#reaping;
		if (!reaping) return this.#terminalError;
		return Promise.race([reaping.then(() => this.#terminalError), Bun.sleep(timeoutMs).then(() => undefined)]);
	}

	onClose(listener: RpcTransportCloseListener): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	onError(listener: RpcTransportErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	#finish(child: ptree.ChildProcess, error?: Error): void {
		if (this.#process !== child) return;

		this.#lastStderr = this.#stderr(child);
		this.#process = null;
		this.#terminalError = error;
		if (error) {
			for (const listener of this.#errorListeners) {
				try {
					listener(error);
				} catch {
					// Transport observers must not interfere with process cleanup.
				}
			}
		}
		for (const listener of this.#closeListeners) {
			try {
				listener();
			} catch {
				// Transport observers must not interfere with process cleanup.
			}
		}
	}

	#stderr(child: ptree.ChildProcess): string {
		return child.peekStderr();
	}
}
