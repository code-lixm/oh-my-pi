import { describe, expect, it } from "bun:test";
import {
	boundOmpSessionSnapshot,
	encodeOmpDaemonRecord,
	OMP_DAEMON_MAX_JSONL_RECORD_BYTES,
	OMP_DAEMON_MAX_SNAPSHOT_BYTES,
	OmpDaemonJsonlDecoder,
} from "../../src/daemon/protocol";
import {
	isOmpDaemonCommand,
	isOmpDaemonResponse,
	isOmpDaemonWorkerAuthentication,
	isOmpDaemonWorkerReady,
} from "../../src/daemon/worker";

describe("daemon JSONL protocol", () => {
	it("encodes and decodes records round-trip", () => {
		const decoder = new OmpDaemonJsonlDecoder();
		const record = { id: "x1", type: "hello", capabilities: ["attach_snapshot"] };
		const encoded = encodeOmpDaemonRecord(record);
		expect(encoded).toBe(`${JSON.stringify(record)}\n`);
		const decoded = decoder.push(encoded!);
		expect(decoded).toHaveLength(1);
		expect(JSON.parse(decoded[0]!)).toEqual(record);
	});

	it("preserves a UTF-8 code point split across socket chunks", () => {
		const decoder = new OmpDaemonJsonlDecoder();
		const record = { id: "u1", type: "prompt", message: "你好，世界" };
		const encoded = encodeOmpDaemonRecord(record)!;
		const bytes = new TextEncoder().encode(encoded);
		const firstMultibyteByte = new TextEncoder().encode(record.message)[0]!;
		const split = bytes.indexOf(firstMultibyteByte) + 1;
		const lines = [...decoder.push(bytes.slice(0, split)), ...decoder.push(bytes.slice(split))];
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual(record);
	});

	it("bounds oversized worker snapshots before they cross the JSONL wire", () => {
		const messages = Array.from({ length: 4 }, (_, index) => ({
			role: "user",
			content: `${index}:${"x".repeat(200 * 1024)}`,
		}));
		const snapshot = boundOmpSessionSnapshot({ messages });

		expect(snapshot).toMatchObject({ truncated: true, omittedMessages: 1 });
		expect(snapshot.messages).toEqual(messages.slice(1));
		expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(OMP_DAEMON_MAX_SNAPSHOT_BYTES);

		const record = { type: "snapshot", activeSessionId: "snapshot-1", state: snapshot };
		const encoded = encodeOmpDaemonRecord(record);
		expect(encoded).toBeDefined();
		expect(JSON.parse(encoded!)).toEqual(record);
	});

	it("rejects records above the size bound", () => {
		const huge = { id: "h", type: "prompt", message: "x".repeat(OMP_DAEMON_MAX_JSONL_RECORD_BYTES) };
		expect(encodeOmpDaemonRecord(huge)).toBeUndefined();
	});
	it("rejects an oversized supervisor-cursor event without emitting a partial line", () => {
		const decoder = new OmpDaemonJsonlDecoder();
		const event = {
			type: "session_event",
			activeSessionId: "session-boundary",
			event: { type: "message_updated", content: "x".repeat(OMP_DAEMON_MAX_JSONL_RECORD_BYTES) },
			cursor: { generation: "generation-1", sequence: 1 },
		};
		const encoded = encodeOmpDaemonRecord(event);

		expect(encoded).toBeUndefined();
		expect(() => decoder.push(`${JSON.stringify(event)}\n`)).toThrow("Daemon JSONL record exceeds size limit");
	});
});

describe("daemon command validation", () => {
	it("accepts every supported command shape", () => {
		expect(isOmpDaemonCommand({ type: "hello", capabilities: ["attach_snapshot"] })).toBe(true);
		expect(isOmpDaemonCommand({ type: "create", cwd: "/tmp" })).toBe(true);
		expect(
			isOmpDaemonCommand({ type: "attach", activeSessionId: "abc", resumeCursor: { generation: "g", sequence: 3 } }),
		).toBe(true);
		expect(isOmpDaemonCommand({ type: "prompt", message: "hi" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "cancel" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "cancel", activeSessionId: "abc" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "cancel", activeSessionId: 3 })).toBe(false);
		expect(
			isOmpDaemonCommand({
				type: "prompt",
				message: "hi",
				images: [{ type: "image", mimeType: "image/png", data: "x" }],
			}),
		).toBe(true);
		expect(isOmpDaemonCommand({ type: "steer", message: "go" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "set_model", model: "a/b" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "heartbeat_set", prompt: "p", interval: "5m" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "cron_add", schedule: "* * * * *", prompt: "p" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "list_sessions" })).toBe(true);
		expect(isOmpDaemonCommand({ type: "shutdown" })).toBe(true);
	});

	it("rejects malformed commands", () => {
		expect(isOmpDaemonCommand(null)).toBe(false);
		expect(isOmpDaemonCommand({})).toBe(false);
		expect(isOmpDaemonCommand({ type: "create" })).toBe(false);
		expect(isOmpDaemonCommand({ type: "prompt" })).toBe(false);
		expect(isOmpDaemonCommand({ type: "steer" })).toBe(false);
		expect(isOmpDaemonCommand({ type: "set_model" })).toBe(false);
		expect(isOmpDaemonCommand({ type: "bogus" })).toBe(false);
		expect(isOmpDaemonCommand({ type: "attach", resumeCursor: { generation: 1 } })).toBe(false);
	});

	it("distinguishes responses and worker auth/ready records", () => {
		expect(isOmpDaemonResponse({ id: "r1", ok: true, data: {} })).toBe(true);
		expect(isOmpDaemonResponse({ id: "r1", ok: false, error: "boom" })).toBe(true);
		expect(isOmpDaemonWorkerAuthentication({ id: "a1", type: "worker_auth", token: "t", activeSessionId: "s" })).toBe(
			true,
		);
		expect(
			isOmpDaemonWorkerReady({ type: "worker_ready", activeSessionId: "s", summary: { activeSessionId: "s" } }),
		).toBe(true);
	});
});
