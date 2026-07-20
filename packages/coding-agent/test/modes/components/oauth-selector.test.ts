import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../../src/i18n/settings-locale";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	has: (_providerId: string) => false,
	hasAuth: (_providerId: string) => false,
	getCredentialOrigin: (_providerId: string) => undefined,
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("does not offer env-only providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				has: (_providerId: string) => false,
				hasAuth: (providerId: string) => providerId === "opencode-go" || providerId === "opencode-zen",
				getCredentialOrigin: (_providerId: string) => undefined,
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("No stored provider credentials to log out");

		component.handleInput("\n");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				has: (providerId: string) => providerId === "opencode-go",
				hasAuth: (providerId: string) => providerId === "opencode-go",
				getCredentialOrigin: (_providerId: string) => undefined,
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");

		component.handleInput("\n");
		expect(selected).toEqual(["opencode-go"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
			);
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
			);
			for (const char of alias.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const selected: string[] = [];
			const component = new OAuthSelectorComponent(
				"logout",
				{
					has: (providerId: string) => providerId === "opencode-go",
					hasAuth: (providerId: string) => providerId === "opencode-go",
					getCredentialOrigin: (_providerId: string) => undefined,
				} as unknown as AuthStorage,
				providerId => selected.push(providerId),
				() => {},
			);
			for (const char of "opencode-go") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("OpenCode Go");
		});
	});
});

describe("OAuthSelectorComponent locale", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders zh-CN status labels after locale is switched at runtime", () => {
		const prev = getSettingsUiLocale();
		const target = getOAuthProviders().find(provider => provider.id === "anthropic");
		expect(target).toBeDefined();
		if (!target) return;
		try {
			const auth = {
				has: (providerId: string) => providerId === target.id,
				hasAuth: (providerId: string) => providerId === target.id,
				getCredentialOrigin: (_providerId: string) => undefined,
			} as unknown as AuthStorage;

			setSettingsUiLocale("en");
			const component = new OAuthSelectorComponent(
				"logout",
				auth,
				() => {},
				() => {},
			);
			for (const char of target.id) component.handleInput(char);
			const enOutput = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(enOutput).toContain(target.name);
			expect(enOutput).toContain("logged in");
			expect(enOutput).not.toContain("已登录");

			setSettingsUiLocale("zh-CN");
			const zhOutput = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(zhOutput).toContain(target.name);
			expect(zhOutput).not.toContain("logged in");
			expect(zhOutput).toContain("已登录");
		} finally {
			setSettingsUiLocale(prev);
		}
	});

	it("renders zh-CN source-label origin leg after locale is switched at runtime", () => {
		const prev = getSettingsUiLocale();
		const target = getOAuthProviders().find(provider => provider.id === "anthropic");
		expect(target).toBeDefined();
		if (!target) return;
		try {
			const auth = {
				has: (providerId: string) => providerId === target.id,
				hasAuth: (providerId: string) => providerId === target.id,
				getCredentialOrigin: (providerId: string) =>
					providerId === target.id ? ({ kind: "oauth" } as const) : undefined,
			} as unknown as AuthStorage;

			setSettingsUiLocale("en");
			const component = new OAuthSelectorComponent(
				"logout",
				auth,
				() => {},
				() => {},
			);
			for (const char of target.id) component.handleInput(char);
			const enOutput = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(enOutput).toContain(target.name);
			expect(enOutput).toContain("logged in");
			expect(enOutput).toContain("(login)");
			expect(enOutput).not.toContain("(登录)");

			setSettingsUiLocale("zh-CN");
			const zhOutput = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(zhOutput).toContain(target.name);
			expect(zhOutput).not.toContain("logged in");
			expect(zhOutput).toContain("已登录");
			expect(zhOutput).toContain("(登录)");
			expect(zhOutput).not.toContain("(login)");
		} finally {
			setSettingsUiLocale(prev);
		}
	});
});
