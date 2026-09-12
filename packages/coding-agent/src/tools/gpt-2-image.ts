import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getConfigRootDir, isEnoent, logger, ptree, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { selectPrompt } from "../prompts/prompt-locale";
import gpt2ImageDescription from "../prompts/tools/gpt-2-image.md" with { type: "text" };
import gpt2ImageDescriptionZh from "../prompts/tools/gpt-2-image.zh-CN.md" with { type: "text" };

export const GPT2_IMAGE_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const GPT2_IMAGE_DEFAULT_MODEL = "gpt-image-2";
export const GPT2_IMAGE_TIMEOUT_MS = 3 * 60 * 1000;

const PRESET_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const QUALITY_LEVELS = ["auto", "low", "medium", "high"] as const;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const MODERATION_LEVELS = ["auto", "low"] as const;
const TRANSPARENCY_CAPABLE_FORMATS: Record<string, true> = { png: true, webp: true };

const MAX_PROMPT_CHARS = 32_000;
const MAX_N = 10;
const MAX_EDGE_PX = 3840;
const MIN_TOTAL_PIXELS = 655_360;
const MAX_TOTAL_PIXELS = 8_294_400;
const EDGE_STEP = 16;
const MAX_ASPECT_RATIO = 3;

/** Per-image USD price table for pre-flight cost hints (OpenAI published guide). */
const APPROX_PRICE_PER_IMAGE: Record<Exclude<(typeof QUALITY_LEVELS)[number], "auto">, Record<string, number>> = {
	low: { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 },
	medium: { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 },
	high: { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 },
};

/** $ per 1M tokens for gpt-image-2 (used for post-hoc usage-based estimates). */
const TOKEN_PRICES = {
	image: { input: 8.0, cachedInput: 2.0, output: 30.0 },
	text: { input: 5.0, cachedInput: 1.25, output: 10.0 },
} as const;

interface Gpt2ImageUsage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details?: { image_tokens?: number; text_tokens?: number };
	output_tokens_details?: { image_tokens?: number; text_tokens?: number };
}

export interface Gpt2ImageToolDetails {
	model: string;
	prompt: string;
	requested: {
		size: string;
		quality: string;
		n: number;
		format: string;
	};
	applied: {
		size?: string;
		quality?: string;
		background?: string | null;
		output_format?: string;
	};
	imageCount: number;
	imagePaths: string[];
	images: Array<{ data: string; mimeType: string }>;
	outputDir: string;
	usage?: Gpt2ImageUsage;
	costUsd: number | null;
	notes?: string[];
}

export type SizeCheck =
	| { ok: true; kind: "preset" | "custom"; canonical: string; note?: string }
	| { ok: false; error: string };

const PRESET_SET = new Set<string>(PRESET_SIZES);

/** Validate a size string against gpt-image-2's rules (presets or custom WxH). */
export function validateGpt2ImageSize(input: string): SizeCheck {
	const s = input.trim().toLowerCase().replace(/\s+/g, "");
	if (PRESET_SET.has(s)) {
		return { ok: true, kind: "preset", canonical: s };
	}
	const m = s.match(/^(\d+)x(\d+)$/);
	if (!m) {
		return {
			ok: false,
			error: `Invalid size "${input}". Use "auto" or WxH (e.g. "1024x1024", "2048x1152"). Allowed presets: ${PRESET_SIZES.join(", ")}.`,
		};
	}
	const w = Number(m[1]);
	const h = Number(m[2]);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return { ok: false, error: `Invalid size "${input}": both edges must be positive integers.` };
	}
	if (w % EDGE_STEP !== 0 || h % EDGE_STEP !== 0) {
		return {
			ok: false,
			error: `Invalid size ${w}x${h}: both edges must be multiples of ${EDGE_STEP}.`,
		};
	}
	if (Math.max(w, h) > MAX_EDGE_PX) {
		return {
			ok: false,
			error: `Invalid size ${w}x${h}: max edge is ${MAX_EDGE_PX}px.`,
		};
	}
	const ratio = Math.max(w, h) / Math.min(w, h);
	if (ratio > MAX_ASPECT_RATIO) {
		return {
			ok: false,
			error: `Invalid size ${w}x${h}: aspect ratio must be between 1:${MAX_ASPECT_RATIO} and ${MAX_ASPECT_RATIO}:1 (got ${ratio.toFixed(2)}:1).`,
		};
	}
	const total = w * h;
	if (total < MIN_TOTAL_PIXELS || total > MAX_TOTAL_PIXELS) {
		return {
			ok: false,
			error: `Invalid size ${w}x${h}: total pixels must be between ${MIN_TOTAL_PIXELS.toLocaleString()} and ${MAX_TOTAL_PIXELS.toLocaleString()} (got ${total.toLocaleString()}).`,
		};
	}
	const canonical = `${w}x${h}`;
	// OpenAI's guide calls anything past 2560x1440 experimental — warn, don't refuse.
	if (total > 2560 * 1440) {
		return {
			ok: true,
			kind: "custom",
			canonical,
			note: `Size ${canonical} exceeds 2560x1440; OpenAI labels outputs above that resolution experimental, so results may be less consistent.`,
		};
	}
	return { ok: true, kind: "custom", canonical };
}

/** Cheap pre-flight cost hint; returns null when no published row matches. */
export function approximateGpt2ImageCost(params: { quality: string; size: string; n: number }): number | null {
	const { quality, size, n } = params;
	const effectiveQuality = quality === "auto" ? "medium" : quality;
	const row = APPROX_PRICE_PER_IMAGE[effectiveQuality as keyof typeof APPROX_PRICE_PER_IMAGE];
	if (!row) return null;
	const unit = row[size];
	if (typeof unit !== "number") return null;
	return round4(unit * Math.max(1, n));
}

/** Derive an authoritative USD estimate from the token usage the API returned. */
export function estimateGpt2ImageCost(usage: Gpt2ImageUsage | undefined | null): number | null {
	if (!usage) return null;
	const inImgT = usage.input_tokens_details?.image_tokens ?? 0;
	const inTxtT = usage.input_tokens_details?.text_tokens ?? Math.max(usage.input_tokens - inImgT, 0);
	const outImgT = usage.output_tokens_details?.image_tokens ?? usage.output_tokens ?? 0;
	const outTxtT = usage.output_tokens_details?.text_tokens ?? 0;
	const perMillion = (tokens: number, pricePerMillion: number) => (tokens / 1_000_000) * pricePerMillion;
	return round4(
		perMillion(inTxtT, TOKEN_PRICES.text.input) +
			perMillion(inImgT, TOKEN_PRICES.image.input) +
			perMillion(outTxtT, TOKEN_PRICES.text.output) +
			perMillion(outImgT, TOKEN_PRICES.image.output),
	);
}

export function formatGpt2ImageUsd(n: number | null | undefined): string {
	if (n == null || Number.isNaN(n)) return "n/a";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

const imagePromptSchema = type("string")
	.atMostLength(MAX_PROMPT_CHARS)
	.describe(
		"Image description. gpt-image-2 handles very detailed prompts; use ALL CAPS or quote literal text you want rendered verbatim.",
	);

const imageSizeSchema = type("string").describe(
	'Output dimensions. "auto" (default), one of the presets "1024x1024", "1536x1024", "1024x1536", or a custom "WxH" where both edges are multiples of 16, max edge ≤ 3840px, aspect ratio within 1:3–3:1, and total pixels 655,360–8,294,400.',
);

const imageQualitySchema = type
	.enumerated(...QUALITY_LEVELS)
	.describe(
		'Generation quality. "low" for fast drafts, "medium" balanced, "high" for dense layouts and text, "auto" lets the model choose.',
	);

const imageNFieldSchema = type.number.integer
	.atLeast(1)
	.atMost(MAX_N)
	.describe(`How many images to generate (1–${MAX_N}). Each counts toward rate limits and cost.`);

const imageBackgroundSchema = type
	.enumerated(...BACKGROUNDS)
	.describe(
		'Background behavior. "auto" (default) lets the model pick; "opaque" forces a filled background; "transparent" produces an alpha channel and requires output_format "png" or "webp".',
	);

const imageOutputFormatSchema = type
	.enumerated(...OUTPUT_FORMATS)
	.describe(
		'File format. "png" (default, lossless), "jpeg" (smaller, lossy), "webp" (best compression). Only "png" and "webp" can carry a transparent background.',
	);

const imageOutputCompressionSchema = type.number.integer
	.atLeast(0)
	.atMost(100)
	.describe("Compression level 0–100 for jpeg/webp outputs. Ignored for png. Defaults to 100 (minimal compression).");

const imageModerationSchema = type
	.enumerated(...MODERATION_LEVELS)
	.describe(
		'Moderation strictness. "auto" (default) applies standard safety filtering; "low" is less restrictive (still subject to OpenAI policy).',
	);

const imageOutputDirSchema = type("string").describe(
	"Absolute or relative directory where generated images are written. Defaults to the configured output directory (settings gpt2image.outputDir, GPT2_IMAGE_OUTPUT_DIR, or ~/.omp/gpt-2-image/<project>/). Created if missing.",
);

const imageFilenamePrefixSchema = type("string").describe(
	'Short label appended to the generated filename so you can find it later (e.g. "hero-banner"). Letters/digits/hyphens only; auto-sanitized.',
);

const imageUserFieldSchema = type("string").describe(
	"Optional end-user identifier forwarded to OpenAI for abuse monitoring. Pass a stable hashed user ID, not PII.",
);

export const gpt2ImageSchema = type({
	prompt: imagePromptSchema,
	"size?": imageSizeSchema,
	"quality?": imageQualitySchema,
	"n?": imageNFieldSchema,
	"background?": imageBackgroundSchema,
	"output_format?": imageOutputFormatSchema,
	"output_compression?": imageOutputCompressionSchema,
	"moderation?": imageModerationSchema,
	"output_dir?": imageOutputDirSchema,
	"filename_prefix?": imageFilenamePrefixSchema,
	"user?": imageUserFieldSchema,
});
export type Gpt2ImageParams = typeof gpt2ImageSchema.infer;

interface Gpt2ImageResponseItem {
	// gpt-image-2 always returns base64 on the Images API (same contract as the
	// reference gpt-image-2-mcp server); there is no url fallback path.
	b64_json?: string;
}

interface Gpt2ImageResponse {
	data?: Gpt2ImageResponseItem[];
	usage?: Gpt2ImageUsage;
	size?: string;
	quality?: string;
	background?: string;
	output_format?: string;
}

/** Resolve the effective output directory: explicit arg > env > setting > default. */
export function resolveGpt2ImageOutputDir(explicit?: string): string {
	const trimmed = explicit?.trim();
	if (trimmed) {
		return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
	}
	const envDir = process.env.GPT2_IMAGE_OUTPUT_DIR?.trim();
	if (envDir) {
		return path.isAbsolute(envDir) ? envDir : path.resolve(process.cwd(), envDir);
	}
	const settingDir = settings.get("gpt2image.outputDir")?.trim();
	if (settingDir) {
		return path.isAbsolute(settingDir) ? settingDir : path.resolve(process.cwd(), settingDir);
	}
	const root = getConfigRootDir();
	const repoKey = repositoryKey(process.cwd());
	return path.join(root, "gpt-2-image", repoKey);
}

function repositoryKey(cwd: string): string {
	const resolved = (() => {
		try {
			return fs.realpathSync(cwd);
		} catch {
			return cwd;
		}
	})();
	const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	const basename = path
		.basename(resolved)
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.slice(0, 40);
	return basename ? `${basename}-${digest}` : digest;
}

function makeFilename(prefix: string, ext: string, extra?: string | null): string {
	const d = new Date();
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	const ts =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const id = Snowflake.next().slice(-6);
	const tail = extra && extra.length > 0 ? `-${sanitizeExtra(extra).slice(0, 30)}` : "";
	return `${prefix}-${ts}-${id}${tail}.${ext}`;
}

function sanitizeExtra(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

/**
 * Bound the output directory's disk footprint before a write. Files younger
 * than PRUNE_MIN_AGE_MS are protected so concurrent generations are never
 * wiped out mid-flight; eviction is FIFO by mtime past that window.
 */
async function pruneOutputDir(dir: string): Promise<void> {
	const maxBytes = settings.get("gpt2image.maxDirBytes");
	const maxFiles = settings.get("gpt2image.maxFiles");
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return;
		logger.debug("gpt-2-image output prune failed", { error: String(error) });
		return;
	}
	if (names.length === 0) return;

	const now = Date.now();
	const PRUNE_MIN_AGE_MS = 2 * 60 * 60 * 1000;
	const files: Array<{ fullPath: string; size: number; mtimeMs: number }> = [];
	let totalBytes = 0;
	for (const name of names) {
		const fullPath = path.join(dir, name);
		let stat: Stats;
		try {
			stat = await fs.promises.stat(fullPath);
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!stat.isFile()) continue;
		files.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
		totalBytes += stat.size;
	}

	if (totalBytes <= maxBytes && files.length <= maxFiles) return;

	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let remainingFiles = files.length;
	for (const file of files) {
		if (totalBytes <= maxBytes && remainingFiles <= maxFiles) break;
		if (now - file.mtimeMs < PRUNE_MIN_AGE_MS) continue;
		try {
			await fs.promises.rm(file.fullPath, { force: true });
			totalBytes -= file.size;
			remainingFiles -= 1;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("gpt-2-image output prune remove failed", { error: String(error) });
			}
		}
	}
}

/** Resolve credentials: settings override env, matching the project's env fallback pattern. */
function resolveGpt2ImageCredentials(): { apiKey: string; baseUrl: string; model: string } {
	const settingKey = settings.get("gpt2image.apiKey");
	const envKey = process.env.GPT2_IMAGE_API_KEY ?? process.env.OPENAI_API_KEY;
	const apiKey = settingKey || envKey;
	if (!apiKey) {
		throw new Error(
			"No API key configured for gpt_2_image. Set the gpt2image.apiKey setting, GPT2_IMAGE_API_KEY, or OPENAI_API_KEY.",
		);
	}
	const baseUrl =
		(settings.get("gpt2image.baseUrl") ?? process.env.GPT2_IMAGE_BASE_URL)?.trim() || GPT2_IMAGE_DEFAULT_BASE_URL;
	const model = (settings.get("gpt2image.model") ?? process.env.GPT2_IMAGE_MODEL)?.trim() || GPT2_IMAGE_DEFAULT_MODEL;
	return { apiKey, baseUrl, model };
}

export const gpt2ImageTool: CustomTool<typeof gpt2ImageSchema, Gpt2ImageToolDetails> = {
	name: "gpt_2_image",
	label: "GPT2Image",
	strict: true,
	approval: "write",
	get description() {
		return selectPrompt(gpt2ImageDescription, gpt2ImageDescriptionZh);
	},
	parameters: gpt2ImageSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const { apiKey, baseUrl, model } = resolveGpt2ImageCredentials();
			const sizeCheck = validateGpt2ImageSize(params.size ?? "auto");
			if (!sizeCheck.ok) {
				return {
					content: [{ type: "text", text: sizeCheck.error }],
					details: {
						model,
						prompt: params.prompt,
						requested: {
							size: params.size ?? "auto",
							quality: params.quality ?? "auto",
							n: params.n ?? 1,
							format: params.output_format ?? "png",
						},
						applied: {},
						imageCount: 0,
						imagePaths: [],
						images: [],
						outputDir: resolveGpt2ImageOutputDir(params.output_dir),
						costUsd: null,
					},
					isError: true,
				};
			}

			const outputFormat = params.output_format ?? "png";
			const background = params.background ?? "auto";
			if (background === "transparent" && !TRANSPARENCY_CAPABLE_FORMATS[outputFormat]) {
				return {
					content: [
						{
							type: "text",
							text: `background: "transparent" cannot be combined with output_format: "${outputFormat}" — ${outputFormat} has no alpha channel. Use png or webp, or set background to "auto" / "opaque".`,
						},
					],
					details: {
						model,
						prompt: params.prompt,
						requested: {
							size: sizeCheck.canonical,
							quality: params.quality ?? "auto",
							n: params.n ?? 1,
							format: outputFormat,
						},
						applied: {},
						imageCount: 0,
						imagePaths: [],
						images: [],
						outputDir: resolveGpt2ImageOutputDir(params.output_dir),
						costUsd: null,
					},
					isError: true,
				};
			}

			const outputDir = resolveGpt2ImageOutputDir(params.output_dir);
			await pruneOutputDir(outputDir);

			const n = params.n ?? 1;
			const quality = params.quality ?? "auto";
			const requestSignal = ptree.combineSignals(signal, GPT2_IMAGE_TIMEOUT_MS);
			const endpoint = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
			const body: Record<string, unknown> = {
				model,
				prompt: params.prompt,
				size: sizeCheck.canonical,
				quality,
				n,
				background,
				output_format: outputFormat,
				moderation: params.moderation ?? "auto",
			};
			if (params.output_compression != null) body.output_compression = params.output_compression;
			if (params.user) body.user = params.user;

			const priceHint = approximateGpt2ImageCost({ quality, size: sizeCheck.canonical, n });
			logger.info("gpt_2_image call", {
				model,
				endpoint,
				promptPreview: params.prompt.slice(0, 80),
				size: sizeCheck.canonical,
				quality,
				n,
				outputFormat,
				background,
				priceHint: formatGpt2ImageUsd(priceHint),
			});

			let rawText: string;
			try {
				const resp = await (ctx.fetch ?? fetch)(endpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
					signal: requestSignal,
				});
				rawText = await resp.text();
				if (!resp.ok) {
					let message = rawText;
					try {
						const parsed = JSON.parse(rawText) as { error?: { message?: string } };
						message = parsed.error?.message ?? message;
					} catch {
						// Keep raw body.
					}
					return {
						content: [{ type: "text", text: `gpt_2_image request failed (${resp.status}): ${message}` }],
						details: {
							model,
							prompt: params.prompt,
							requested: { size: sizeCheck.canonical, quality, n, format: outputFormat },
							applied: {},
							imageCount: 0,
							imagePaths: [],
							images: [],
							outputDir,
							costUsd: null,
						},
						isError: true,
					};
				}
			} catch (error) {
				if (requestSignal?.aborted) throw error;
				throw error;
			}

			const data = JSON.parse(rawText) as Gpt2ImageResponse;
			const items = data.data ?? [];
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "OpenAI response contained no image data." }],
					details: {
						model,
						prompt: params.prompt,
						requested: { size: sizeCheck.canonical, quality, n, format: outputFormat },
						applied: {
							size: data.size,
							quality: data.quality,
							background: data.background,
							output_format: data.output_format,
						},
						imageCount: 0,
						imagePaths: [],
						images: [],
						outputDir,
						costUsd: null,
					},
					isError: true,
				};
			}

			const images: Array<{ data: string; mimeType: string }> = [];
			const imagePaths: string[] = [];
			const mimeType = `image/${outputFormat}`;
			const multi = items.length > 1;
			for (let idx = 0; idx < items.length; idx++) {
				const item = items[idx]!;
				if (!item.b64_json) {
					throw new Error(
						`OpenAI response item ${idx} had no b64_json. gpt-image-2 should always return base64 — this is unexpected.`,
					);
				}
				const base64 = item.b64_json;
				const buf = Buffer.from(base64, "base64");
				const filename = makeFilename(
					"image",
					outputFormat,
					multi ? `${params.filename_prefix ?? "n"}-${idx + 1}` : (params.filename_prefix ?? null),
				);
				const filePath = path.join(outputDir, filename);
				await Bun.write(filePath, buf);
				images.push({ data: base64, mimeType });
				imagePaths.push(filePath);
			}

			const usage = data.usage;
			const costUsd = estimateGpt2ImageCost(usage);

			// Second prune after all images land: a batch of n can push the
			// directory past the caps even when the pre-write prune was a no-op.
			// Fresh files are protected by PRUNE_MIN_AGE_MS, so only older files
			// are ever evicted here — concurrent generations stay untouched.
			await pruneOutputDir(outputDir);

			const notes: string[] = [];
			if (sizeCheck.note) notes.push(sizeCheck.note);

			const lines = [`Model: ${model}`, `Generated ${images.length} image(s):`, ...imagePaths.map(p => `  ${p}`)];
			if (priceHint != null) lines.push(`Estimated cost before generation: ${formatGpt2ImageUsd(priceHint)}`);
			if (costUsd != null) lines.push(`Billed estimate from usage: ${formatGpt2ImageUsd(costUsd)}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					model,
					prompt: params.prompt,
					requested: { size: sizeCheck.canonical, quality, n, format: outputFormat },
					applied: {
						size: data.size ?? sizeCheck.canonical,
						quality: data.quality ?? quality,
						background: data.background ?? null,
						output_format: data.output_format ?? outputFormat,
					},
					imageCount: images.length,
					imagePaths,
					images,
					outputDir,
					usage,
					costUsd,
					...(notes.length > 0 ? { notes } : {}),
				},
			};
		});
	},
};

export function getGpt2ImageTools(): Array<CustomTool<typeof gpt2ImageSchema, Gpt2ImageToolDetails>> {
	return [gpt2ImageTool];
}
