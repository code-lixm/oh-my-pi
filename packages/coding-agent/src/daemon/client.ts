import {
	encodeOmpDaemonRecord,
	OMP_DAEMON_PROTOCOL_NAME,
	OMP_DAEMON_PROTOCOL_VERSION,
	OMP_DAEMON_SCHEMA_REVISION,
	type OmpDaemonCommand,
	type OmpDaemonEvent,
	OmpDaemonJsonlDecoder,
	type OmpDaemonResponse,
} from "./protocol";

/** Bound every client command so a dead daemon cannot hold a CLI process open. */
export const DAEMON_CLIENT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * A prompt is an open-ended agent turn (LLM + tools) that can run for minutes,
 * unlike bounded control commands. The wall-clock bound stays generous as a
 * backstop; a dead supervisor/worker is still detected fast by the socket
 * closing, so this cannot silently hold a CLI process open.
 */
export const DAEMON_PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

export interface DaemonClientRequestOptions {
	timeoutMs?: number;
	/** Called for each non-response daemon event (snapshot, session_event, error) received while awaiting the command. */
	onEvent?: (event: OmpDaemonEvent) => void;
	/**
	 * When aborted while a prompt turn is in flight, a cancel is sent to
	 * interrupt the turn. Aborting before the prompt is sent fails immediately.
	 */
	signal?: AbortSignal;
}

export type DaemonPromptResult = { ok: true; cancelled?: boolean } | { ok: false; error: string; cancelled?: boolean };

function isOmpDaemonResponse(value: unknown): value is OmpDaemonResponse {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as { id?: unknown; ok?: unknown; error?: unknown };
	return (
		typeof record.id === "string" && typeof record.ok === "boolean" && (record.ok || typeof record.error === "string")
	);
}

function isDaemonHello(value: unknown): value is Extract<OmpDaemonEvent, { type: "daemon_hello" }> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "daemon_hello" &&
		Array.isArray(record.capabilities) &&
		record.capabilities.every(capability => typeof capability === "string")
	);
}

function daemonHelloError(hello: Extract<OmpDaemonEvent, { type: "daemon_hello" }> | undefined): string | undefined {
	if (!hello) return "Daemon did not send the required hello metadata";
	if (hello.name !== OMP_DAEMON_PROTOCOL_NAME) return `Unsupported daemon protocol: ${String(hello.name)}`;
	if (hello.version !== OMP_DAEMON_PROTOCOL_VERSION) {
		return `Unsupported daemon protocol version: ${String(hello.version)}`;
	}
	if (typeof hello.schemaRevision !== "number" || hello.schemaRevision < OMP_DAEMON_SCHEMA_REVISION) {
		return `Daemon schema revision ${String(hello.schemaRevision)} is older than required revision ${OMP_DAEMON_SCHEMA_REVISION}`;
	}
	if (!hello.capabilities.includes("prompt_cancellation")) {
		return "Daemon does not support prompt_cancellation; restart it with the current OMP version";
	}
	return undefined;
}

function closeSocket(socket: Bun.Socket<undefined> | undefined): void {
	try {
		socket?.close();
	} catch {
		// The transport can close while a timeout or error handler cleans it up.
	}
}

function writeCommand(socket: Bun.Socket<undefined>, command: OmpDaemonCommand): boolean {
	const encoded = encodeOmpDaemonRecord(command);
	if (!encoded) return false;
	try {
		return socket.write(encoded) >= 0;
	} catch {
		return false;
	}
}

/** Send one correlated daemon command and always release its socket and timer. */
export async function sendDaemonCommand(
	socketPath: string,
	command: OmpDaemonCommand,
	options: DaemonClientRequestOptions = {},
): Promise<OmpDaemonResponse> {
	const timeoutMs = options.timeoutMs ?? DAEMON_CLIENT_REQUEST_TIMEOUT_MS;
	const decoder = new OmpDaemonJsonlDecoder();
	const { promise, resolve, reject } = Promise.withResolvers<OmpDaemonResponse>();
	let socket: Bun.Socket<undefined> | undefined;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;

	const finish = (response: OmpDaemonResponse): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(response);
		closeSocket(socket);
	};
	const fail = (error: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		reject(error instanceof Error ? error : new Error(String(error)));
		closeSocket(socket);
	};

	timer = setTimeout(() => fail(new Error(`Timed out waiting for daemon ${command.type} response`)), timeoutMs);
	try {
		void Bun.connect({
			unix: socketPath,
			socket: {
				open: openedSocket => {
					socket = openedSocket;
					if (settled) {
						closeSocket(openedSocket);
						return;
					}
					if (!writeCommand(openedSocket, command)) {
						fail(new Error(`Daemon socket is unavailable while sending ${command.type}`));
					}
				},
				data: (_socket, data) => {
					let lines: string[];
					try {
						lines = decoder.push(data);
					} catch (error) {
						fail(error);
						return;
					}
					for (const line of lines) {
						let record: unknown;
						try {
							record = JSON.parse(line);
						} catch {
							continue;
						}
						if (isOmpDaemonResponse(record) && record.id === command.id) finish(record);
					}
				},
				close: () => fail(new Error("Daemon connection closed before a response")),
				error: (_socket, error) => fail(new Error(`Daemon connection error: ${error.message}`)),
				connectError: (_socket, error) => fail(new Error(`Cannot connect to daemon: ${error.message}`)),
			},
		}).then(
			openedSocket => {
				if (settled) closeSocket(openedSocket);
			},
			error => fail(error),
		);
	} catch (error) {
		fail(error);
	}

	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		closeSocket(socket);
	}
}

/**
 * Attach, acknowledge a prompt, then detach on one bounded connection. The
 * acknowledgement ensures a caller never claims success for an unwritten prompt.
 */
export async function sendDaemonPrompt(
	socketPath: string,
	activeSessionId: string,
	message: string,
	options: DaemonClientRequestOptions = {},
): Promise<DaemonPromptResult> {
	const timeoutMs = options.timeoutMs ?? DAEMON_PROMPT_TIMEOUT_MS;
	const onEvent = options.onEvent;
	const signal = options.signal;
	const decoder = new OmpDaemonJsonlDecoder();
	const { promise, resolve, reject } = Promise.withResolvers<DaemonPromptResult>();
	let socket: Bun.Socket<undefined> | undefined;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	let expectedId = "hello-1";
	let cancelRequested = false;
	let daemonHello: Extract<OmpDaemonEvent, { type: "daemon_hello" }> | undefined;

	if (signal?.aborted) {
		return { ok: false, error: "cancelled", cancelled: true };
	}

	const cleanupSignal = (): void => {
		signal?.removeEventListener("abort", onAbort);
	};
	const finish = (result: DaemonPromptResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		cleanupSignal();
		resolve(result);
		closeSocket(socket);
	};
	const fail = (error: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		cleanupSignal();
		reject(error instanceof Error ? error : new Error(String(error)));
		closeSocket(socket);
	};
	const send = (command: OmpDaemonCommand): void => {
		if (!socket || !writeCommand(socket, command)) {
			fail(new Error(`Daemon socket is unavailable while sending ${command.type}`));
		}
	};
	const onAbort = (): void => {
		if (settled) return;
		if (expectedId === "detach-1") return;
		if (expectedId !== "prompt-1") {
			finish({ ok: false, error: "cancelled", cancelled: true });
			return;
		}
		// Interrupt the in-flight turn; if normal completion wins the race, the
		// successful prompt response below clears this request before detach.
		cancelRequested = true;
		send({ id: "cancel-1", type: "cancel", activeSessionId });
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	timer = setTimeout(() => fail(new Error(`Timed out waiting for daemon ${expectedId} response`)), timeoutMs);
	try {
		void Bun.connect({
			unix: socketPath,
			socket: {
				open: openedSocket => {
					socket = openedSocket;
					if (settled) {
						closeSocket(openedSocket);
						return;
					}
					// Negotiate capabilities and schema before attaching: the server
					// answers a daemon_hello event plus a correlated hello response.
					send({ id: "hello-1", type: "hello", capabilities: [] });
				},
				data: (_socket, data) => {
					let lines: string[];
					try {
						lines = decoder.push(data);
					} catch (error) {
						fail(error);
						return;
					}
					for (const line of lines) {
						let record: unknown;
						try {
							record = JSON.parse(line);
						} catch {
							continue;
						}
						if (isOmpDaemonResponse(record)) {
							if (record.id !== expectedId) continue;
							if (!record.ok) {
								finish({
									ok: false,
									error: record.error,
									...(cancelRequested ? { cancelled: true } : {}),
								});
								continue;
							}
							if (expectedId === "hello-1") {
								const error = daemonHelloError(daemonHello);
								if (error) {
									finish({ ok: false, error });
									continue;
								}
								expectedId = "attach-1";
								send({ id: "attach-1", type: "attach", activeSessionId });
								continue;
							}
							if (expectedId === "attach-1") {
								expectedId = "prompt-1";
								send({ id: "prompt-1", type: "prompt", message });
								continue;
							}
							if (expectedId === "prompt-1") {
								cancelRequested = false;
								expectedId = "detach-1";
								send({ id: "detach-1", type: "detach" });
								continue;
							}
							finish({ ok: true });
							continue;
						}
						if (isDaemonHello(record)) daemonHello = record;
						// A non-response event (snapshot, session_event, error): surface progress.
						if (onEvent && record !== null && typeof record === "object" && "type" in record) {
							onEvent(record as OmpDaemonEvent);
						}
					}
				},
				close: () => fail(new Error(`Daemon connection closed before ${expectedId} completed`)),
				error: (_socket, error) => fail(new Error(`Daemon connection error: ${error.message}`)),
				connectError: (_socket, error) => fail(new Error(`Cannot connect to daemon: ${error.message}`)),
			},
		}).then(
			openedSocket => {
				if (settled) closeSocket(openedSocket);
			},
			error => fail(error),
		);
	} catch (error) {
		fail(error);
	}

	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		closeSocket(socket);
	}
}
