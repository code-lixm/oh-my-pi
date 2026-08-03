import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels, renderCodexPromptInstructions } from "@oh-my-pi/pi-catalog/discovery/codex";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { openaiCodexModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CODEX_PROFILE_BASE_URL = "https://chatgpt.com/backend-api";

type CodexProfileFixture = {
	slug: string;
	display_name: string;
	context_window: number;
	default_reasoning_level: string;
	supported_reasoning_levels: string[];
	input_modalities: string[];
	visibility: string;
	base_instructions: string;
	model_messages: Record<string, unknown>;
	comp_hash: string;
};

function codexProfileFixture(
	slug: string,
	baseInstructions: string,
	instructionsTemplate: string,
	instructionsVariables: {
		personality_default: string | null;
		personality_friendly: string | null;
		personality_pragmatic: string | null;
	},
	compHash: string,
): CodexProfileFixture {
	return {
		slug,
		display_name: slug,
		context_window: 400_000,
		default_reasoning_level: "medium",
		supported_reasoning_levels: ["low", "medium", "high"],
		input_modalities: ["text"],
		visibility: "list",
		base_instructions: baseInstructions,
		model_messages: {
			instructions_template: instructionsTemplate,
			instructions_variables: instructionsVariables,
			approvals: null,
		},
		comp_hash: compHash,
	};
}

function codexProfileFetch(models: readonly CodexProfileFixture[]): typeof fetch {
	const fetchFn: typeof fetch = Object.assign(
		async () =>
			new Response(JSON.stringify({ models }), {
				headers: { etag: "codex-profile-fixture-v1" },
			}),
		{ preconnect() {} },
	);
	return fetchFn;
}

async function discoverCodexProfileModel(fixture: CodexProfileFixture, baseUrl: string) {
	const result = await fetchCodexModels({
		accessToken: "test-token",
		baseUrl,
		clientVersion: "0.144.1",
		paths: ["/codex/models"],
		fetchFn: codexProfileFetch([fixture]),
	});
	const model = result?.models.find(candidate => candidate.id === fixture.slug);
	expect(model).toBeDefined();
	return model!;
}

describe("Codex model discovery", () => {
	it("marks discovered models for provider-native V2 compaction", async () => {
		let capturedHeaders: Headers | undefined;
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = new Headers(init?.headers);
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
					{ headers: { etag: "models-v1" } },
				);
			},
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		expect(capturedHeaders?.get("version")).toBe("0.99.0");
		expect(result?.etag).toBe("models-v1");
		expect(result?.models).toHaveLength(1);
		expect(result?.models[0]).toMatchObject({
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses",
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		});
	});

	it("carries use_responses_lite and prefer_websockets onto the model spec", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-terra",
								display_name: "GPT-5.6-Terra",
								context_window: 372_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
								prefer_websockets: true,
								use_responses_lite: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const terra = result?.models.find(model => model.id === "gpt-5.6-terra");
		expect(terra).toMatchObject({ preferWebsockets: true, useResponsesLite: true });
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.useResponsesLite).toBeUndefined();
	});

	it("falls back to the 372K window for GPT-5.6 SKUs when upstream omits context_window (#5705)", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								display_name: "GPT-5.6-Sol",
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const sol = result?.models.find(model => model.id === "gpt-5.6-sol");
		expect(sol?.contextWindow).toBe(372_000);
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.contextWindow).toBe(272_000);
	});

	it("honors context_window when upstream actively reports it for GPT-5.6 SKUs", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								display_name: "GPT-5.6-Sol",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.144.1",
			fetchFn,
		});

		const sol = result?.models.find(model => model.id === "gpt-5.6-sol");
		expect(sol?.contextWindow).toBe(272_000);
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.contextWindow).toBe(272_000);
	});

	it("keeps account-listed API-unsupported models while pruning hidden and absent models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-authoritative-"));
		const staticOnlyModel: ModelSpec<"openai-codex-responses"> = {
			id: "unsupported-static",
			name: "Unsupported static model",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const sparkModel: ModelSpec<"openai-codex-responses"> = {
			...staticOnlyModel,
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			contextWindow: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex-spark",
								display_name: "GPT-5.3-Codex-Spark",
								visibility: "list",
								supported_in_api: false,
								context_window: 128_000,
								default_reasoning_level: "high",
								input_modalities: ["text"],
							},
							{
								slug: "hidden-model",
								display_name: "Hidden model",
								visibility: "hidden",
								supported_in_api: true,
							},
							{
								slug: "hide-model",
								display_name: "Hide model",
								visibility: "hide",
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		try {
			const result = await resolveProviderModels(
				{
					...openaiCodexModelManagerOptions({
						resolveAccounts: async () => [{ accessToken: "test-token" }],
						fetch: fetchFn,
					}),
					staticModels: [staticOnlyModel, sparkModel],
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-5.3-codex-spark"]);
			expect(result.models[0]).toMatchObject({
				contextWindow: 128_000,
				maxTokens: 128_000,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("unions models across every configured Codex OAuth account (#6265)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-"));
		// Codex `/models` is account-scoped: account 1 lacks gpt-5.6-sol, account 2
		// exposes it. Keyed off the chatgpt-account-id header the discovery flow
		// sends per account.
		const catalogs: Record<string, readonly string[]> = {
			"account-1": ["gpt-5.6-terra", "gpt-5.6-luna"],
			"account-2": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
		};
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
				const slugs = catalogs[accountId] ?? [];
				return new Response(
					JSON.stringify({
						models: slugs.map(slug => ({
							slug,
							display_name: slug,
							default_reasoning_level: "medium",
							supported_reasoning_levels: ["low", "medium", "high"],
							input_modalities: ["text", "image"],
							supported_in_api: true,
						})),
					}),
				);
			},
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-1", accountId: "account-1" },
					{ accessToken: "token-2", accountId: "account-2" },
				],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps bundled Codex models when any account catalog fetch fails (#6265)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-fail-"));
		const bundled: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372_000,
			maxTokens: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const accountId = new Headers(init?.headers).get("chatgpt-account-id");
				if (accountId === "account-1") {
					return Response.json({
						models: [
							{
								slug: "partial-account-model",
								display_name: "Partial Account Model",
								supported_in_api: true,
								input_modalities: ["text"],
							},
						],
					});
				}
				return new Response("nope", { status: 500 });
			},
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-1", accountId: "account-1" },
					{ accessToken: "token-2", accountId: "account-2" },
				],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, staticModels: [bundled], cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-5.6-terra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores pre-V2 Codex discovery cache rows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v7-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const cachedModel: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const refreshedModel: ModelSpec<"openai-codex-responses"> = {
			...cachedModel,
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		};
		try {
			writeModelCache(
				"openai-codex",
				Date.now(),
				[buildModel(cachedModel)],
				true,
				"merge-v3:authoritative:merge-v3:empty",
				dbPath,
			);
			const db = new Database(dbPath);
			try {
				db.run("UPDATE model_cache SET version = 7 WHERE provider_id = ?", ["openai-codex"]);
			} finally {
				db.close();
			}

			let fetched = false;
			const result = await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [refreshedModel];
				},
			});

			expect(fetched).toBe(true);
			expect(result.models.find(model => model.id === "gpt-5.5")?.remoteCompaction).toEqual(
				refreshedModel.remoteCompaction,
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not silently promote legacy v2 Codex cache rows to the current schema", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v2-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			// Seed a v2 row directly, mirroring the shape written by very old
			// installs before schema versioning stabilized. The migration must NOT
			// resurrect it as the current version — that would keep the pre-V2
			// compaction metadata alive across cache-schema bumps.
			const seed = new Database(dbPath, { create: true });
			try {
				seed.run(`
					CREATE TABLE model_cache (
						provider_id TEXT PRIMARY KEY,
						version INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						authoritative INTEGER NOT NULL DEFAULT 0,
						static_fingerprint TEXT NOT NULL DEFAULT '',
						models TEXT NOT NULL
					)
				`);
				seed.run(
					"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, 2, ?, 1, '', '[]')",
					["openai-codex", Date.now()],
				);
			} finally {
				seed.close();
			}

			let fetched = false;
			await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [];
				},
			});
			expect(fetched).toBe(true);

			const inspect = new Database(dbPath, { readonly: true });
			try {
				const row = inspect
					.query<{ version: number }, [string]>("SELECT version FROM model_cache WHERE provider_id = ?")
					.get("openai-codex");
				expect(row?.version).not.toBe(2);
			} finally {
				inspect.close();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves and renders the distinct 5.2, 5.4, 5.5, and Terra profile shapes", async () => {
		const fixtures = [
			{
				fixture: codexProfileFixture(
					"gpt-5.2-codex",
					"5.2 base instructions",
					"5.2 template without a personality placeholder",
					{ personality_default: "", personality_friendly: null, personality_pragmatic: null },
					"comp-5.2",
				),
				expected: {
					default: "5.2 base instructions",
					friendly: "5.2 base instructions",
					pragmatic: "5.2 base instructions",
				},
			},
			{
				fixture: codexProfileFixture(
					"gpt-5.4",
					"5.4 base instructions",
					"5.4 template: {{ personality }}.",
					{
						personality_default: "default-5.4",
						personality_friendly: "friendly-5.4",
						personality_pragmatic: "pragmatic-5.4",
					},
					"comp-5.4",
				),
				expected: {
					default: "5.4 template: default-5.4.",
					friendly: "5.4 template: friendly-5.4.",
					pragmatic: "5.4 template: pragmatic-5.4.",
				},
			},
			{
				fixture: codexProfileFixture(
					"gpt-5.5",
					"5.5 base instructions",
					"5.5 template: {{ personality }}\ncontinue",
					{
						personality_default: "",
						personality_friendly: "friendly-5.5",
						personality_pragmatic: "pragmatic-5.5",
					},
					"comp-5.5",
				),
				expected: {
					default: "5.5 template: \ncontinue",
					friendly: "5.5 template: friendly-5.5\ncontinue",
					pragmatic: "5.5 template: pragmatic-5.5\ncontinue",
				},
			},
			{
				fixture: codexProfileFixture(
					"gpt-5.6-terra",
					"Terra base instructions",
					"Terra template without a personality placeholder",
					{ personality_default: "", personality_friendly: "", personality_pragmatic: "" },
					"comp-5.6-terra",
				),
				expected: {
					default: "Terra base instructions",
					friendly: "Terra base instructions",
					pragmatic: "Terra base instructions",
				},
			},
		] as const;
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: CODEX_PROFILE_BASE_URL,
			clientVersion: "0.144.1",
			paths: ["/codex/models"],
			fetchFn: codexProfileFetch(fixtures.map(({ fixture }) => fixture)),
		});

		expect(result?.models).toHaveLength(fixtures.length);
		for (const { fixture, expected } of fixtures) {
			const model = result?.models.find(candidate => candidate.id === fixture.slug);
			expect(model).toBeDefined();
			const profile = model?.codexPromptProfile;
			expect(profile).toMatchObject({
				modelId: fixture.slug,
				baseInstructions: fixture.base_instructions,
				compHash: fixture.comp_hash,
			});
			expect(renderCodexPromptInstructions(profile!, "default")).toBe(expected.default);
			expect(renderCodexPromptInstructions(profile!, "friendly")).toBe(expected.friendly);
			expect(renderCodexPromptInstructions(profile!, "pragmatic")).toBe(expected.pragmatic);
		}
	});

	it("uses a canonical vendor digest that covers exact profile identity and payload", async () => {
		const canonical = codexProfileFixture(
			"gpt-5.5",
			"digest base",
			"digest {{ personality }}",
			{
				personality_default: "default",
				personality_friendly: "friendly",
				personality_pragmatic: "pragmatic",
			},
			"comp-digest",
		);
		const reordered: CodexProfileFixture = {
			slug: canonical.slug,
			display_name: canonical.display_name,
			context_window: canonical.context_window,
			default_reasoning_level: canonical.default_reasoning_level,
			supported_reasoning_levels: canonical.supported_reasoning_levels,
			input_modalities: canonical.input_modalities,
			visibility: canonical.visibility,
			base_instructions: canonical.base_instructions,
			model_messages: {
				approvals: null,
				instructions_variables: {
					personality_pragmatic: "pragmatic",
					personality_friendly: "friendly",
					personality_default: "default",
				},
				instructions_template: "digest {{ personality }}",
			},
			comp_hash: canonical.comp_hash,
		};
		const changedBase = codexProfileFixture(
			canonical.slug,
			"changed digest base",
			"digest {{ personality }}",
			{
				personality_default: "default",
				personality_friendly: "friendly",
				personality_pragmatic: "pragmatic",
			},
			canonical.comp_hash,
		);
		const changedVariable: CodexProfileFixture = {
			...canonical,
			model_messages: {
				...canonical.model_messages,
				instructions_variables: {
					personality_default: "default",
					personality_friendly: "changed-friendly",
					personality_pragmatic: "pragmatic",
				},
			},
		};
		const differentModel = { ...canonical, slug: "gpt-5.6-terra", display_name: "gpt-5.6-terra" };
		const [canonicalModel, reorderedModel, changedBaseModel, changedVariableModel, differentModelResult] =
			await Promise.all(
				[canonical, reordered, changedBase, changedVariable, differentModel].map(fixture =>
					discoverCodexProfileModel(fixture, CODEX_PROFILE_BASE_URL),
				),
			);

		const canonicalDigest = canonicalModel.codexPromptProfile?.vendorDigest;
		expect(canonicalDigest).toBeDefined();
		expect(reorderedModel.codexPromptProfile?.vendorDigest).toBe(canonicalDigest);
		expect(changedBaseModel.codexPromptProfile?.vendorDigest).not.toBe(canonicalDigest);
		expect(changedVariableModel.codexPromptProfile?.vendorDigest).not.toBe(canonicalDigest);
		expect(differentModelResult.codexPromptProfile?.vendorDigest).not.toBe(canonicalDigest);
	});

	it("falls back to base instructions when a template is not exactly one personality placeholder", async () => {
		const fixtures = [
			codexProfileFixture(
				"gpt-5.4",
				"duplicate placeholder base",
				"{{ personality }} then {{ personality }}",
				{ personality_default: "default", personality_friendly: "friendly", personality_pragmatic: "pragmatic" },
				"comp-duplicate-placeholder",
			),
			codexProfileFixture(
				"gpt-5.5",
				"unknown placeholder base",
				"{{ unsupported }}",
				{ personality_default: "default", personality_friendly: "friendly", personality_pragmatic: "pragmatic" },
				"comp-unknown-placeholder",
			),
		];

		for (const fixture of fixtures) {
			const model = await discoverCodexProfileModel(fixture, CODEX_PROFILE_BASE_URL);
			const profile = model.codexPromptProfile;
			expect(profile).toBeDefined();
			expect(renderCodexPromptInstructions(profile!, "pragmatic")).toBe(fixture.base_instructions);
		}
	});

	it("withholds the entire native profile when a trusted response has malformed profile fields", async () => {
		const malformed: CodexProfileFixture = {
			...codexProfileFixture(
				"gpt-5.5",
				"malformed base",
				"{{ personality }}",
				{ personality_default: "default", personality_friendly: "friendly", personality_pragmatic: "pragmatic" },
				"comp-malformed",
			),
			model_messages: {
				instructions_template: "{{ personality }}",
				instructions_variables: {
					personality_default: "default",
					personality_friendly: 7,
					personality_pragmatic: "pragmatic",
				},
				approvals: null,
			},
		};

		const model = await discoverCodexProfileModel(malformed, CODEX_PROFILE_BASE_URL);
		expect(model.id).toBe(malformed.slug);
		expect(model.codexPromptProfile).toBeUndefined();
	});

	it("keeps model discovery but refuses a dynamic profile from an untrusted origin", async () => {
		const fixture = codexProfileFixture(
			"gpt-5.6-terra",
			"untrusted base",
			"untrusted {{ personality }}",
			{ personality_default: "default", personality_friendly: "friendly", personality_pragmatic: "pragmatic" },
			"comp-untrusted",
		);

		const model = await discoverCodexProfileModel(fixture, "https://codex.example/backend-api");
		expect(model.id).toBe(fixture.slug);
		expect(model.codexPromptProfile).toBeUndefined();
	});
});
