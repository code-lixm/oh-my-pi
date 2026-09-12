import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import {
	approximateGpt2ImageCost,
	estimateGpt2ImageCost,
	formatGpt2ImageUsd,
	GPT2_IMAGE_DEFAULT_BASE_URL,
	getGpt2ImageTools,
	gpt2ImageTool,
	resolveGpt2ImageOutputDir,
	validateGpt2ImageSize,
} from "@oh-my-pi/pi-coding-agent/tools/gpt-2-image";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const originalApiKey = process.env.GPT2_IMAGE_API_KEY;
const originalOutputDir = process.env.GPT2_IMAGE_OUTPUT_DIR;
const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt2-image-test-"));
	tempDirs.push(dir);
	return dir;
}

function createContext(fetchMock: typeof fetch, cwd: string): CustomToolContext {
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "test-session",
		} as unknown as CustomToolContext["sessionManager"],
		modelRegistry: {} as CustomToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function imageResponse(base64: string, index = 0): Response {
	const payload = {
		data: [{ b64_json: base64 }],
		usage: {
			input_tokens: 100,
			output_tokens: 500,
			total_tokens: 600,
			input_tokens_details: { text_tokens: 90, image_tokens: 10 },
			output_tokens_details: { image_tokens: 500 },
		},
		size: "1024x1024",
		quality: "high",
		background: "opaque",
		output_format: "png",
	};
	void index;
	return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	currentSettings().set("gpt2image.apiKey", "test-openai-key");
	currentSettings().set("gpt2image.baseUrl", "https://api.openai.com/v1");
});

afterEach(async () => {
	const apiKey = originalApiKey;
	if (apiKey === undefined) {
		delete process.env.GPT2_IMAGE_API_KEY;
	} else {
		process.env.GPT2_IMAGE_API_KEY = apiKey;
	}
	const outputDir = originalOutputDir;
	if (outputDir === undefined) {
		delete process.env.GPT2_IMAGE_OUTPUT_DIR;
	} else {
		process.env.GPT2_IMAGE_OUTPUT_DIR = outputDir;
	}
	await Promise.all(tempDirs.map(dir => removeWithRetries(dir)));
	tempDirs.length = 0;
	resetSettingsForTest();
});

function currentSettings(): Settings {
	return Settings.instance;
}

describe("validateGpt2ImageSize", () => {
	it("accepts presets and canonical custom sizes", () => {
		expect(validateGpt2ImageSize("auto")).toEqual({ ok: true, kind: "preset", canonical: "auto" });
		expect(validateGpt2ImageSize("1536x1024").ok).toBe(true);
		expect(validateGpt2ImageSize("2048x1152")).toMatchObject({ ok: true, kind: "custom", canonical: "2048x1152" });
	});

	it("rejects non-multiple-of-16 edges and out-of-range pixel counts", () => {
		expect(validateGpt2ImageSize("100x100")).toMatchObject({ ok: false });
		expect(validateGpt2ImageSize("99999x16")).toMatchObject({ ok: false });
		expect(validateGpt2ImageSize("banana")).toMatchObject({ ok: false });
		expect(validateGpt2ImageSize("16x16")).toMatchObject({ ok: false });
	});

	it("flags experimental sizes as a note, not an error", () => {
		expect(validateGpt2ImageSize("3072x2048")).toMatchObject({ ok: true, kind: "custom", note: expect.any(String) });
	});
});

describe("cost helpers", () => {
	it("estimates pre-flight cost from the published table", () => {
		expect(approximateGpt2ImageCost({ quality: "low", size: "1024x1024", n: 1 })).toBe(0.006);
		expect(approximateGpt2ImageCost({ quality: "high", size: "1536x1024", n: 2 })).toBeCloseTo(0.33);
		expect(approximateGpt2ImageCost({ quality: "auto", size: "1024x1024", n: 1 })).toBe(0.053);
		expect(approximateGpt2ImageCost({ quality: "high", size: "999x999", n: 1 })).toBeNull();
	});

	it("derives billed cost from usage token details", () => {
		const usage = {
			input_tokens: 100,
			output_tokens: 500,
			total_tokens: 600,
			input_tokens_details: { text_tokens: 90, image_tokens: 10 },
			output_tokens_details: { image_tokens: 500 },
		};
		const cost = estimateGpt2ImageCost(usage);
		expect(cost).not.toBeNull();
		expect(cost!).toBeGreaterThan(0);
		expect(formatGpt2ImageUsd(cost)).toMatch(/^\$\d/);
		expect(estimateGpt2ImageCost(null)).toBeNull();
	});
});

describe("resolveGpt2ImageOutputDir", () => {
	it("prefers explicit arg over env and settings", () => {
		process.env.GPT2_IMAGE_OUTPUT_DIR = "/tmp/env-out";
		currentSettings().set("gpt2image.outputDir", "/tmp/settings-out");
		const explicit = path.join(os.tmpdir(), "explicit-out");
		expect(resolveGpt2ImageOutputDir(explicit)).toBe(explicit);
	});

	it("falls back through env to the configured setting", () => {
		process.env.GPT2_IMAGE_OUTPUT_DIR = path.join(os.tmpdir(), "env-out");
		expect(resolveGpt2ImageOutputDir(undefined)).toBe(path.join(os.tmpdir(), "env-out"));
		delete process.env.GPT2_IMAGE_OUTPUT_DIR;
		const settingDir = path.join(os.tmpdir(), "settings-out");
		currentSettings().set("gpt2image.outputDir", settingDir);
		expect(resolveGpt2ImageOutputDir(undefined)).toBe(settingDir);
	});
});

describe("gpt2ImageTool", () => {
	it("registers with a stable name and schema", async () => {
		expect(await getGpt2ImageTools()).toEqual([gpt2ImageTool]);
		expect(gpt2ImageTool.name).toBe("gpt_2_image");
		expect(gpt2ImageTool.parameters).toBeDefined();
	});

	it("posts to {baseUrl}/images/generations with the model and saves base64 to the output dir", async () => {
		const outDir = tempDir();
		const requestLog: Array<{ url: string; headers: Headers; body: unknown }> = [];
		const fetchMock = async (url: unknown, init?: unknown): Promise<Response> => {
			const req = init as { headers: Headers; body: string };
			requestLog.push({
				url: String(url),
				headers: req.headers,
				body: JSON.parse(req.body),
			});
			return imageResponse("aGVsbG8=");
		};
		const ctx = createContext(fetchMock as unknown as typeof fetch, os.tmpdir());

		const result = await gpt2ImageTool.execute(
			"call-1",
			{ prompt: "a red panda in a bamboo forest", output_dir: outDir, size: "1024x1024", quality: "high" },
			undefined,
			ctx,
		);

		expect(requestLog).toHaveLength(1);
		expect(requestLog[0]!.url).toBe(`${GPT2_IMAGE_DEFAULT_BASE_URL}/images/generations`);
		const sentHeaders = requestLog[0]!.headers as unknown as Record<string, string>;
		expect(sentHeaders.Authorization).toBe("Bearer test-openai-key");
		const body = requestLog[0]!.body as Record<string, unknown>;
		expect(body).toMatchObject({
			model: "gpt-image-2",
			prompt: "a red panda in a bamboo forest",
			size: "1024x1024",
			quality: "high",
			n: 1,
		});

		expect(result.content.length).toBeGreaterThan(0);
		const details = result.details as {
			imageCount: number;
			imagePaths: string[];
			images: Array<{ data: string; mimeType: string }>;
		};
		expect(details.imageCount).toBe(1);
		expect(details.imagePaths[0]!.startsWith(outDir)).toBe(true);
		expect(fs.existsSync(details.imagePaths[0]!)).toBe(true);
		expect(details.images[0]!.data).toBe("aGVsbG8=");
		expect(details.images[0]!.mimeType).toBe("image/png");
		expect(result.isError).not.toBe(true);
	});

	it("uses the configured base URL and model from settings", async () => {
		const outDir = tempDir();
		currentSettings().set("gpt2image.baseUrl", "https://proxy.example.com/v1/");
		currentSettings().set("gpt2image.model", "custom-image-x");
		let seenUrl = "";
		const fetchMock = async (url: unknown): Promise<Response> => {
			seenUrl = String(url);
			return imageResponse("aGVsbG8=");
		};
		const ctx = createContext(fetchMock as unknown as typeof fetch, os.tmpdir());

		await gpt2ImageTool.execute(
			"call-2",
			{ prompt: "test", output_dir: outDir, filename_prefix: "hero-banner" },
			undefined,
			ctx,
		);

		expect(seenUrl).toBe("https://proxy.example.com/v1/images/generations");
		const files = fs.readdirSync(outDir);
		expect(files.some(name => name.includes("hero-banner"))).toBe(true);
	});

	it("rejects transparent background with jpeg before the API call", async () => {
		const fetchMock = async (): Promise<Response> => {
			throw new Error("API should not be called");
		};
		const ctx = createContext(fetchMock as unknown as typeof fetch, os.tmpdir());

		const result = await gpt2ImageTool.execute(
			"call-3",
			{ prompt: "test", background: "transparent", output_format: "jpeg" },
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		const text = result.content.find(c => c.type === "text");
		expect(text && "text" in text ? text.text : "").toContain("no alpha channel");
	});

	it("surfaces non-2xx API responses as tool errors", async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		const ctx = createContext(fetchMock as unknown as typeof fetch, os.tmpdir());

		const result = await gpt2ImageTool.execute("call-4", { prompt: "test" }, undefined, ctx);

		expect(result.isError).toBe(true);
		const text = result.content.find(c => c.type === "text");
		expect(text && "text" in text ? text.text : "").toContain("invalid_api_key");
	});

	it("prunes the oldest files once the output dir exceeds the caps", async () => {
		const outDir = tempDir();
		currentSettings().set("gpt2image.maxFiles", 2);
		currentSettings().set("gpt2image.maxDirBytes", 1024 * 1024 * 1024);
		// Two old files, one fresh: only the old ones are eligible for eviction.
		const oldFiles = ["image-20260101-000000-aaaaaa.png", "image-20260102-000000-bbbbbb.png"];
		await Promise.all(oldFiles.map(name => Bun.write(path.join(outDir, name), "x".repeat(1024))));
		const old = Date.now() - 3 * 60 * 60 * 1000;
		for (const name of oldFiles) {
			fs.utimesSync(path.join(outDir, name), new Date(old), new Date(old));
		}

		const fetchMock = async (): Promise<Response> => imageResponse("aGVsbG8=");
		const ctx = createContext(fetchMock as unknown as typeof fetch, os.tmpdir());

		const result = await gpt2ImageTool.execute("call-5", { prompt: "test", output_dir: outDir }, undefined, ctx);

		expect(result.isError).not.toBe(true);
		const remaining = fs.readdirSync(outDir);
		// New generation plus at most one surviving old file (cap 2).
		expect(remaining.length).toBeLessThanOrEqual(2);
		expect(remaining.some(name => name.startsWith("image-"))).toBe(true);
	});
});
