import type { RpcCommand, RpcResponse } from "../rpc/rpc-types";
import type {
	InteractiveSessionCursor,
	InteractiveSessionProjection,
	InteractiveSessionReliableFrame,
	InteractiveSessionSnapshot,
	InteractiveSessionViewFrame,
} from "./types";

export type InteractiveSessionConnectionState =
	| { status: "connecting" }
	| { status: "connected" }
	| { status: "disconnected"; error?: string };

export type InteractiveSessionReliableListener = (frame: InteractiveSessionReliableFrame) => void;
export type InteractiveSessionViewListener = (frame: InteractiveSessionViewFrame) => void;
export type InteractiveSessionConnectionListener = (state: InteractiveSessionConnectionState) => void;

/** Transport-neutral frontend boundary for one interactive session. */
export interface InteractiveSessionPort {
	readonly projection: InteractiveSessionProjection;
	readonly cursor: InteractiveSessionCursor;
	dispatch(command: RpcCommand): Promise<RpcResponse>;
	requestSnapshot(): Promise<InteractiveSessionSnapshot>;
	onReliable(listener: InteractiveSessionReliableListener): () => void;
	onView(listener: InteractiveSessionViewListener): () => void;
	onConnection(listener: InteractiveSessionConnectionListener): () => void;
	dispose(): Promise<void>;
}
