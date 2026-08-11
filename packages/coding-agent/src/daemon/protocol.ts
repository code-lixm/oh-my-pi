import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../session/agent-session-events";

/** Stable identifier for the local daemon JSONL protocol. */
export const OMP_DAEMON_PROTOCOL_NAME = "omp.daemon";

/** Protocol wire-version. Increment for incompatible wire changes. */
export const OMP_DAEMON_PROTOCOL_VERSION = 1;

/** Monotonic schema revision for additive, field-sensitive compatibility checks. */
export const OMP_DAEMON_SCHEMA_REVISION = 2;
/** Hard bounds shared by daemon client, supervisor, and worker JSONL endpoints. */
export const OMP_DAEMON_MAX_JSONL_RECORD_BYTES = 1024 * 1024;
/** Leave room for the snapshot event envelope and cursor. */
export const OMP_DAEMON_MAX_SNAPSHOT_BYTES = 768 * 1024;
/** Maximum number of event records retained for cursor replay. */
export const OMP_DAEMON_MAX_REPLAY_EVENTS = 1024;
/** Maximum number of session summaries returned in one response. */
export const OMP_DAEMON_MAX_SESSION_LIST_ENTRIES = 256;

/** Decode arbitrary stream chunks without splitting UTF-8 code points. */
export class OmpDaemonJsonlDecoder {
	readonly #decoder = new TextDecoder("utf-8", { fatal: true });
	#buffer = "";

	push(chunk: Uint8Array | string): string[] {
		let text: string;
		try {
			text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		} catch {
			throw new Error("Invalid UTF-8 daemon JSONL record");
		}
		this.#buffer += text;
		const lines: string[] = [];
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > OMP_DAEMON_MAX_JSONL_RECORD_BYTES) {
				throw new Error("Daemon JSONL record exceeds size limit");
			}
			lines.push(line);
		}
		if (Buffer.byteLength(this.#buffer, "utf8") > OMP_DAEMON_MAX_JSONL_RECORD_BYTES) {
			throw new Error("Daemon JSONL record exceeds size limit");
		}
		return lines;
	}
}

/** Encode one bounded JSONL record; undefined means it cannot cross the wire. */
export function encodeOmpDaemonRecord(record: unknown): string | undefined {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(record);
	} catch {
		return undefined;
	}
	if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > OMP_DAEMON_MAX_JSONL_RECORD_BYTES)
		return undefined;
	return `${encoded}\n`;
}

/** Keep snapshots bounded while retaining the newest transcript messages. */
export function boundOmpSessionSnapshot(snapshot: OmpSessionSnapshot): OmpSessionSnapshot {
	const candidate: Record<string, unknown> = { ...snapshot };
	const messages = Array.isArray(snapshot.messages) ? [...snapshot.messages] : undefined;
	if (messages !== undefined) candidate.messages = messages;
	const fits = (): boolean => {
		try {
			const encoded = JSON.stringify(candidate);
			return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= OMP_DAEMON_MAX_SNAPSHOT_BYTES;
		} catch {
			return false;
		}
	};
	if (fits()) return candidate as OmpSessionSnapshot;

	let omittedMessages = 0;
	if (messages !== undefined) {
		while (!fits() && messages.length > 0) {
			messages.shift();
			omittedMessages++;
			candidate.messages = messages;
		}
	}
	if (omittedMessages > 0) {
		candidate.truncated = true;
		candidate.omittedMessages = (snapshot.omittedMessages ?? 0) + omittedMessages;
	}
	for (const key of ["rlmChildren", "cronJobs", "autonomousState", "todoState", "goalState", "activeTools"] as const) {
		if (fits()) break;
		delete candidate[key];
		candidate.truncated = true;
	}
	if (fits()) return candidate as OmpSessionSnapshot;
	return { messages: [], truncated: true, omittedMessages: (snapshot.omittedMessages ?? 0) + omittedMessages };
}

/** Features a daemon client understands. */
export type OmpDaemonClientCapability = "attach_snapshot" | "event_sequence" | "extension_ui" | "chunked_snapshot";

/** Features a daemon supervisor advertises to connected clients. */
export type OmpDaemonServerCapability =
	| OmpDaemonClientCapability
	| "heartbeat_management"
	| "cron_management"
	| "agent_messaging"
	| "rlm_subagents"
	| "model_catalog"
	/**
	 * An in-flight prompt turn can be interrupted by a cancel command. The
	 * cancel may name the target session explicitly, so a second client can
	 * interrupt a turn started by another client.
	 *
	 * This is active-turn cancellation (`cancel` → session abort), not Prime's
	 * pre-ownership `prompt_admission_cancellation` withdrawal window.
	 */
	| "prompt_cancellation";

/** Position in a per-session event stream. */
export interface OmpDaemonEventCursor {
	generation: string;
	sequence: number;
}

/** A point-in-time state transfer used when a client attaches to a session. */
export interface OmpSessionSnapshot {
	messages?: readonly unknown[];
	model?: string;
	thinkingLevel?: string;
	activeTools?: readonly string[];
	goalState?: unknown;
	todoState?: unknown;
	autonomousState?: unknown;
	cronJobs?: readonly unknown[];
	rlmChildren?: readonly unknown[];
	/** True when optional state or oldest messages were omitted to fit the bound. */
	truncated?: boolean;
	omittedMessages?: number;
}

/** A lightweight description of a daemon-resident session. */
export interface OmpSessionSummary {
	activeSessionId: string;
	/** Persisted SessionManager identity, stable across worker recovery. */
	sessionId?: string;
	cwd?: string;
	sessionPath?: string;
	status?: "starting" | "ready" | "running" | "resident" | "recovering" | "failed" | "stopped";
}

/**
 * Client-to-supervisor commands. Each command is a standalone JSONL record;
 * `id`, when present, is echoed by {@link OmpDaemonResponse}.
 */
export type OmpDaemonCommand =
	| { id?: string; type: "hello"; capabilities?: readonly OmpDaemonClientCapability[] }
	| { id?: string; type: "create"; cwd: string; sessionPath?: string }
	| { id?: string; type: "attach"; activeSessionId?: string; resumeCursor?: OmpDaemonEventCursor }
	| { id?: string; type: "detach" }
	| { id?: string; type: "prompt"; message: string; images?: readonly ImageContent[] }
	| { id?: string; type: "cancel"; activeSessionId?: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "set_model"; model: string }
	| { id?: string; type: "heartbeat_set"; prompt: string; interval: string }
	| { id?: string; type: "heartbeat_clear" }
	| { id?: string; type: "heartbeat_status" }
	| { id?: string; type: "cron_add"; schedule: string; prompt: string }
	| { id?: string; type: "cron_cancel"; jobId: string }
	| { id?: string; type: "cron_list" }
	| { id?: string; type: "agent_message_send"; target: string; message: string }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "stop_session"; activeSessionId: string }
	| { id?: string; type: "shutdown" };

/** Events the supervisor streams to a daemon client as JSONL records. */
export type OmpDaemonEvent =
	| {
			type: "daemon_hello";
			capabilities: readonly OmpDaemonServerCapability[];
			name?: typeof OMP_DAEMON_PROTOCOL_NAME;
			version?: typeof OMP_DAEMON_PROTOCOL_VERSION;
			schemaRevision?: typeof OMP_DAEMON_SCHEMA_REVISION;
	  }
	| {
			type: "session_event";
			activeSessionId: string;
			event: AgentSessionEvent;
			cursor?: OmpDaemonEventCursor;
	  }
	| {
			type: "session_event_omitted";
			activeSessionId: string;
			cursor?: OmpDaemonEventCursor;
			reason: "record_too_large";
	  }
	| {
			type: "snapshot";
			activeSessionId: string;
			state: OmpSessionSnapshot;
			cursor?: OmpDaemonEventCursor;
	  }
	| { type: "replay_complete"; activeSessionId: string; cursor?: OmpDaemonEventCursor; resyncRequired?: boolean }
	| { type: "session_list"; sessions: readonly OmpSessionSummary[] }
	| { type: "error"; message: string; id?: string };

/** Completion record for an identified daemon command. */
export type OmpDaemonResponse = { id: string; ok: true; data?: unknown } | { id: string; ok: false; error: string };

/** Any standalone JSONL record exchanged over a daemon client connection. */
export type OmpDaemonWireMessage = OmpDaemonCommand | OmpDaemonEvent | OmpDaemonResponse;
