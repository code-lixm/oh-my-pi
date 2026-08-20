export type RpcTransportCloseListener = () => void;
export type RpcTransportErrorListener = (error: Error) => void;

/**
 * Physical connection used by {@link RpcClient}.
 *
 * `read()` yields parsed JSONL records. Protocol framing and negotiation remain
 * the client's responsibility.
 */
export interface RpcTransport {
	start(): Promise<void>;
	read(signal: AbortSignal): AsyncIterable<unknown>;
	write(frame: unknown): Promise<void> | void;
	stop(): Promise<void>;
	getStderr(): string;
	/** Await the terminal transport error briefly after its read stream closes. */
	waitForClose?(timeoutMs: number): Promise<Error | undefined>;
	onClose(listener: RpcTransportCloseListener): () => void;
	onError(listener: RpcTransportErrorListener): () => void;
}
