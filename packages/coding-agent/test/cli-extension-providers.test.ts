/**
 * Regression test for `loadCliExtensionProviders`.
 *
 * One-shot CLIs (`omp bench`, dry-balance) build a bare `ModelRegistry` that
 * only knows built-in catalog providers. Before the helper existed they never
 * loaded extensions, so a provider contributed by an extension
 * (`pi.registerProvider(...)`, e.g. a custom OpenAI-compatible gateway under
 * `~/.omp/agent/extensions/`) was invisible to model resolution and
 * `omp bench <provider>/<model>` failed with "Model not found".
 *
 * Contract under test: after `loadCliExtensionProviders` drains the extension's
 * provider registrations into the registry, a `provider/id` selector for that
 * extension provider resolves. Discovery is disabled and the extension path is
 * passed explicitly so the test never touches the developer's real `~/.omp`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage, type Provider } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCliExtensionProviders } from "@oh-my-pi/pi-coding-agent/sdk";
import { TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;
let extPath: string;

beforeAll(async () => {
	tmp = await TempDir.create("@cli-ext-providers-");
	extPath = tmp.join("ext.ts");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("bench-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "bench-model",
			name: "Bench Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
	pi.registerUsageProvider("bench-gw", {
		async fetchUsage(params) {
			return {
				provider: "bench-gw",
				fetchedAt: 1700000000000,
				limits: [{
					id: "bench-gw:monthly-spend",
					label: "Monthly Spend",
					scope: { provider: "bench-gw", windowId: "monthly" },
					window: { id: "monthly", label: "Monthly", durationMs: 30 * 24 * 3_600_000, resetsAt: 1702592000000 },
					amount: { unit: "currency", currency: "USD", used: 12.5, limit: 50, remaining: 37.5, usedFraction: 0.25 },
					status: "ok",
				}],
				metadata: { receivedApiKey: params.credential.apiKey, receivedBaseUrl: params.baseUrl },
				raw: { unstable: true },
			};
		},
	});
}
`,
	);
});

afterEach(() => {
	resetSettingsForTest();
});

afterAll(async () => {
	resetSettingsForTest();
	await tmp.remove();
});

test("loadCliExtensionProviders makes extension providers resolvable by selector", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		resetSettingsForTest();
		const settings = await Settings.init({
			inMemory: true,
			cwd: tmp.path(),
			overrides: { extensions: [extPath], disabledExtensions: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const preferences = getModelMatchPreferences(settings);

		const before = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(before.model).toBeUndefined();

		await loadCliExtensionProviders(modelRegistry, settings, tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extPath],
		});

		const after = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(after.error).toBeUndefined();
		expect(after.model?.provider).toBe("bench-gw");
		expect(after.model?.id).toBe("bench-model");
	} finally {
		authStorage.close();
	}
});

test("loadCliExtensionProviders wires extension usage adapters into real usage fetches", async () => {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		resetSettingsForTest();
		const settings = await Settings.init({
			inMemory: true,
			cwd: tmp.path(),
			overrides: { extensions: [extPath], disabledExtensions: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage);

		await loadCliExtensionProviders(modelRegistry, settings, tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extPath],
		});
		authStorage.setConfigApiKey("bench-gw", "sk-config-test-key");

		const reports = await authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === "bench-gw" ? "https://usage.example.test/v1" : undefined),
		});
		const report = reports?.find(candidate => candidate.provider === "bench-gw");
		const limit = report?.limits.find(candidate => candidate.id === "bench-gw:monthly-spend");

		expect(report?.provider).toBe("bench-gw");
		expect(report?.fetchedAt).toBe(1700000000000);
		expect(report?.metadata?.receivedApiKey).toBe("sk-config-test-key");
		expect(report?.metadata?.receivedBaseUrl).toBe("https://usage.example.test/v1");
		expect(Object.hasOwn(report ?? {}, "raw")).toBe(false);
		expect(limit?.label).toBe("Monthly Spend");
		expect(limit?.scope).toEqual({ provider: "bench-gw", windowId: "monthly" });
		expect(limit?.amount).toEqual({
			unit: "currency",
			currency: "USD",
			used: 12.5,
			limit: 50,
			remaining: 37.5,
			usedFraction: 0.25,
		});
		expect(limit?.status).toBe("ok");
	} finally {
		authStorage.close();
	}
});

test("loadCliExtensionProviders rolls back providers queued by a failing extension factory", async () => {
	const failedExtPath = tmp.join("failed-ext.ts");
	await fs.writeFile(
		failedExtPath,
		`export default function (pi) {
	pi.registerProvider("broken-gw", {
		baseUrl: "https://broken.example.test/v1",
		apiKey: "broken-literal-key",
		api: "openai-completions",
		models: [{
			id: "broken-model",
			name: "Broken Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		}],
	});
	pi.registerUsageProvider("broken-gw", {
		async fetchUsage() {
			return {
				provider: "broken-gw",
				fetchedAt: 1700000000000,
				limits: [{
					id: "broken-gw:monthly-spend",
					label: "Broken Monthly Spend",
					scope: { provider: "broken-gw", windowId: "monthly" },
					amount: { unit: "currency", currency: "USD", used: 99, limit: 100 },
					status: "warning",
				}],
			};
		},
	});
	throw new Error("boom after registrations");
}
`,
	);

	const authStorage = await AuthStorage.create(":memory:");
	try {
		resetSettingsForTest();
		const settings = await Settings.init({
			inMemory: true,
			cwd: tmp.path(),
			overrides: { extensions: [failedExtPath], disabledExtensions: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const preferences = getModelMatchPreferences(settings);

		await loadCliExtensionProviders(modelRegistry, settings, tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [failedExtPath],
		});

		const resolved = resolveCliModel({ cliModel: "broken-gw/broken-model", modelRegistry, preferences });
		const reports = await authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === "broken-gw" ? "https://usage.example.test/v1" : undefined),
		});

		expect(resolved.model).toBeUndefined();
		expect(authStorage.usageProviderFor("broken-gw" as Provider)).toBeUndefined();
		expect((reports ?? []).some(report => report.provider === "broken-gw")).toBe(false);
	} finally {
		authStorage.close();
	}
});
