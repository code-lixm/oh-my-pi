import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { type SettingPath, Settings } from "../../src/config/settings";
import { getPromptLocale, setPromptLocale } from "../../src/prompts/prompt-locale";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";
import * as imageResize from "../../src/utils/image-resize";
import * as scrapers from "../../src/web/scrapers/types";
import * as scraperUtils from "../../src/web/scrapers/utils";

describe("fetch image locale smoke", () => {
	let testDir: string;
	let initialPromptLocale: string;

	beforeEach(() => {
		initialPromptLocale = getPromptLocale();
		testDir = path.join(os.tmpdir(), `fetch-image-locale-smoke-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		setPromptLocale(initialPromptLocale);
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	const createSession = (locale: string, overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession => {
		const sessionFile = path.join(testDir, `session-${locale}.jsonl`);
		const artifactsDir = sessionFile.slice(0, -6);
		let nextArtifactId = 0;
		const settings = Settings.isolated({
			displayLanguage: locale,
			"fetch.enabled": true,
			...overrides,
		});
		setPromptLocale(locale);
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => ({
				id: String(nextArtifactId++),
				path: path.join(artifactsDir, `${nextArtifactId - 1}.${toolType}.log`),
			}),
			settings,
		};
	};

	function textOf(result: Awaited<ReturnType<ReadTool["execute"]>>): string {
		return result.content.find(content => content.type === "text")?.text ?? "";
	}

	it("localizes image summary and dimension note", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([137, 80, 78, 71]),
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([1, 2, 3]),
			mimeType: "image/jpeg",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
			get data() {
				return "cmVzaXplZA==";
			},
		});

		const english = await new ReadTool(createSession("en")).execute("fetch-image-en", {
			path: "https://example.com/image.png",
		});
		const chinese = await new ReadTool(createSession("zh-CN")).execute("fetch-image-zh", {
			path: "https://example.com/image.png",
		});

		expect(textOf(english)).toContain("Fetched image content (image/jpeg).");
		expect(textOf(english)).toContain("displayed at 1000x500");
		expect(textOf(chinese)).toContain("已获取图片内容（image/jpeg）。");
		expect(textOf(chinese)).toContain("当前显示为 1000x500");
		expect(textOf(chinese)).not.toContain("Fetched image content");
	});

	it("localizes unsupported MIME notes", async () => {
		const fetchBinarySpy = vi.spyOn(scraperUtils, "fetchBinary");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/svg+xml",
			finalUrl: "https://example.com/image.svg",
			content: "<svg></svg>",
		});

		const english = await new ReadTool(createSession("en")).execute("fetch-unsupported-en", {
			path: "https://example.com/image.svg",
		});
		const chinese = await new ReadTool(createSession("zh-CN")).execute("fetch-unsupported-zh", {
			path: "https://example.com/image.svg",
		});

		expect(fetchBinarySpy).not.toHaveBeenCalled();
		expect(english.details?.notes).toContain(
			"Image MIME type image/svg+xml is unsupported for inline model serialization; returning text metadata only",
		);
		expect(english.details?.notes).toContain("Falling back to textual rendering from initial response");
		expect(chinese.details?.notes).toContain("图片 MIME 类型 image/svg+xml 不支持内联模型序列化；仅返回文本元数据");
		expect(chinese.details?.notes).toContain("回退为使用初始响应的文本渲染");
	});

	it("localizes inline-limit output and note", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/large.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: { byteLength: 20 * 1024 * 1024 + 1 } as Uint8Array,
		});

		const english = await new ReadTool(createSession("en")).execute("fetch-large-en", {
			path: "https://example.com/large.png",
		});
		const chinese = await new ReadTool(createSession("zh-CN")).execute("fetch-large-zh", {
			path: "https://example.com/large.png",
		});

		expect(textOf(english)).toContain("Fetched image content (image/png), but it is too large to inline render.");
		expect(english.details?.notes).toContain(
			`Image exceeds inline source limit (${20 * 1024 * 1024 + 1} bytes > ${20 * 1024 * 1024} bytes)`,
		);
		expect(textOf(chinese)).toContain("已获取图片内容（image/png），但体积过大，无法以内联方式渲染。");
		expect(chinese.details?.notes).toContain(
			`图片超出内联源大小限制（${20 * 1024 * 1024 + 1} 字节 > ${20 * 1024 * 1024} 字节）`,
		);
	});

	it("localizes binary-refetch fallback notes", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/transient.png",
			content: "<html><body>temporary gateway page</body></html>",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({ ok: false, error: "upstream blocked" });

		const english = await new ReadTool(createSession("en")).execute("fetch-binary-fail-en", {
			path: "https://example.com/transient.png",
		});
		const chinese = await new ReadTool(createSession("zh-CN")).execute("fetch-binary-fail-zh", {
			path: "https://example.com/transient.png",
		});

		expect(english.details?.notes).toContain("Binary fetch failed: upstream blocked");
		expect(english.details?.notes).toContain("Falling back to textual rendering from initial response");
		expect(chinese.details?.notes).toContain("二进制抓取失败: upstream blocked");
		expect(chinese.details?.notes).toContain("回退为使用初始响应的文本渲染");
	});

	it("localizes invalid-image note and fallback text", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/broken.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
			mimeType: "image/png",
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
			get data() {
				return "PGh0bWw=";
			},
		});

		const english = await new ReadTool(createSession("en")).execute("fetch-invalid-en", {
			path: "https://example.com/broken.png",
		});
		const chinese = await new ReadTool(createSession("zh-CN")).execute("fetch-invalid-zh", {
			path: "https://example.com/broken.png",
		});

		expect(english.details?.notes).toContain(
			"Fetched payload could not be decoded as image/png; returning text metadata only",
		);
		expect(textOf(english)).toContain("Fetched payload was labeled image/png, but bytes were not a valid image.");
		expect(chinese.details?.notes).toContain("获取到的载荷无法按 image/png 解码；仅返回文本元数据");
		expect(textOf(chinese)).toContain("获取到的载荷标记为 image/png，但其字节并非有效图片。");
	});
});
