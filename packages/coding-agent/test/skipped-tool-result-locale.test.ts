import { afterEach, describe, expect, it } from "bun:test";
import { getPromptLocale, setPromptLocale } from "../src/prompts/prompt-locale";
import { formatSkippedToolResult } from "../src/prompts/skipped-tool-result";

describe("skipped tool result locale", () => {
	const previousLocale = getPromptLocale();

	afterEach(() => {
		setPromptLocale(previousLocale);
	});

	it("renders the peer-interrupt result in zh-CN", () => {
		setPromptLocale("zh-CN");

		const text = formatSkippedToolResult("irc");

		expect(text).toContain("对等代理中断");
		expect(text).toContain("不要将这个跳过结果视为已完成的工作或验证");
		expect(text).toContain("请重试被跳过的工具");
		expect(text).not.toContain("Skipped due");
	});
});
