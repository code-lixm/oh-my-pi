import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import {
	CrossTurnThinkingLoopGuard,
	type CrossTurnThinkingLoopTurn,
} from "../src/utils/cross-turn-thinking-loop-guard";
import { normalizeSegment } from "../src/utils/thinking-loop";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function turn(thinking: string): CrossTurnThinkingLoopTurn {
	return {
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking }],
			timestamp: Date.now(),
			usage: { ...EMPTY_USAGE },
			stopReason: "toolUse",
		} as AssistantMessage,
	};
}

/**
 * Verbatim reasoning re-emitted across turns of a real session
 * (deepseek-v4-flash, 2026-09-04): the model repeatedly declared it would call
 * `inspect_image` while issuing placeholder `bash` calls with different
 * arguments every turn, so the verbatim tool-call guard never matched. The
 * same paragraph appeared 8-9 times before the turn finally settled.
 */
const REAL_ZH_LOOP = [
	"我陷入了循环，一直在用 bash 写 JSON 文件而不是直接调用 inspect_image 工具。inspect_image 是内置工具，我应该直接调用它。让我直接调用。",
	"我陷入了循环，一直在用 bash 输出占位符而不是直接调用 inspect_image 工具。让我直接调用 inspect_image 工具来检查截图。",
	"我一直在错误地使用 bash 而不是直接调用 inspect_image 工具。让我直接调用 inspect_image 工具来检查截图。",
	"我陷入了循环，一直在用 bash 写占位符。我应该直接调用 inspect_image 工具来检查截图。让我直接调用它。",
	"我陷入了循环，一直在用 bash 输出占位符而不是直接调用 inspect_image 工具。inspect_image 是内置工具，我应该直接调用它。让我直接调用。",
	"我陷入了循环，一直在用 bash 写占位符。我应该直接调用 inspect_image 工具来检查截图。让我直接调用它。",
];

const HEALTHY_EN = [
	"Read the config file to understand the schema. Found three required fields that must be provided by the caller before the request can be dispatched.",
	"Tests are failing because the mock is missing setCollapsedText. Fix the mock implementation and rerun the focused suite.",
	"The retry budget is exhausted. Check the fallback chain configuration next, then probe connectivity to the primary endpoint.",
	"Compaction succeeded. The summary preserves active work, constraints, and unresolved failures for the continuation turn.",
	"Now verify the build passes by running the focused test suite before moving on to the changelog entry.",
];

const HEALTHY_ZH = [
	"先读取配置文件，理解 schema 结构，找到三个必填字段，再决定如何构造请求。",
	"测试失败的原因是 mock 缺少 setCollapsedText 方法，需要补上这个方法再重跑。",
	"重试预算已经耗尽，下一步检查 fallback 链配置是否正确，然后验证连通性。",
	"压缩完成，摘要保留了当前的工作内容和约束条件，可以直接继续后续回合。",
	"现在运行聚焦测试套件验证构建通过，然后再补充变更日志条目。",
];

describe("CrossTurnThinkingLoopGuard", () => {
	it("normalizes Chinese thinking to a non-empty fingerprint (regression: /[^a-z0-9]/ emptied CJK)", () => {
		expect(normalizeSegment(REAL_ZH_LOOP[0]).length).toBeGreaterThan(24);
	});

	it("fires on the real Chinese loop shape at the 4th near-duplicate turn", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		let fired: number | undefined;
		for (let i = 0; i < REAL_ZH_LOOP.length; i++) {
			const detection = guard.recordTurn(turn(REAL_ZH_LOOP[i]));
			if (detection) {
				fired = i + 1;
				expect(detection.kind).toBe("repeated_reasoning");
				expect(detection.count).toBe(4);
				expect(detection.summary.length).toBeGreaterThan(0);
				break;
			}
		}
		expect(fired).toBe(4);
	});

	it("does not fire on healthy distinct Chinese turns", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		for (const thinking of HEALTHY_ZH) {
			expect(guard.recordTurn(turn(thinking))).toBeNull();
		}
	});

	it("does not fire on healthy distinct English turns", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		for (const thinking of HEALTHY_EN) {
			expect(guard.recordTurn(turn(thinking))).toBeNull();
		}
	});

	it("fires on verbatim English thinking repeated across turns", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		const reasoning =
			"I keep writing placeholder bash commands instead of calling the inspect_image tool directly. Let me call inspect_image to check the screenshots now.";
		let detection = null;
		for (let i = 0; i < 6; i++) {
			detection = guard.recordTurn(turn(reasoning));
			if (detection) break;
		}
		expect(detection).not.toBeNull();
		expect(detection?.count).toBe(4);
	});

	it("resets the streak when a turn has no substantial thinking", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		let fired = false;
		for (let i = 0; i < 7; i++) {
			// Interleave: loop thinking, then a short thinking turn that breaks
			// the streak (it neither matches nor extends).
			const detection = guard.recordTurn(turn(i % 2 === 0 ? "Ok." : REAL_ZH_LOOP[0]));
			if (detection) fired = true;
		}
		expect(fired).toBe(false);
	});

	it("does not fire when substantive different thinking interleaves the loop", () => {
		// A → real work → A → real work → A → real work → A: the windowed
		// cluster count fired here; the consecutive-streak contract must not.
		const guard = new CrossTurnThinkingLoopGuard();
		let fired = false;
		for (let i = 0; i < 7; i++) {
			const detection = guard.recordTurn(turn(i % 2 === 0 ? REAL_ZH_LOOP[0] : HEALTHY_ZH[i % HEALTHY_ZH.length]));
			if (detection) fired = true;
		}
		expect(fired).toBe(false);
	});

	it("does not cross-compare Latin and CJK fingerprints", () => {
		const guard = new CrossTurnThinkingLoopGuard();
		// Mixed-script alternation must never cluster: the shingle spaces are
		// incomparable, so each script's window stays below the threshold.
		for (let i = 0; i < 8; i++) {
			expect(guard.recordTurn(turn(HEALTHY_EN[i % HEALTHY_EN.length]))).toBeNull();
			expect(guard.recordTurn(turn(HEALTHY_ZH[i % HEALTHY_ZH.length]))).toBeNull();
		}
	});
});
