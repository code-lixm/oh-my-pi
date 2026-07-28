import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { applyNetworkProxy } from "../../src/config/network-proxy";
import { Settings } from "../../src/config/settings";

const PROXY_ENV_KEYS = [
	"PI_PROXY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];
type ProxyEnvironment = Record<ProxyEnvKey, string | undefined>;

function captureProxyEnvironment(): ProxyEnvironment {
	return Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, Bun.env[key]])) as ProxyEnvironment;
}

function restoreProxyEnvironment(environment: ProxyEnvironment): void {
	for (const key of PROXY_ENV_KEYS) {
		const value = environment[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

describe("applyNetworkProxy", () => {
	let environmentBeforeTest: ProxyEnvironment;

	beforeEach(() => {
		environmentBeforeTest = captureProxyEnvironment();
	});

	afterEach(() => {
		restoreProxyEnvironment(environmentBeforeTest);
	});

	test("configures every pi-ai and Bun proxy environment variable for an HTTP proxy", () => {
		const proxy = "http://127.0.0.1:7890";

		expect(applyNetworkProxy(proxy)).toBe("configured");
		expect(captureProxyEnvironment()).toEqual(
			Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, proxy])) as ProxyEnvironment,
		);
	});

	test("applies network.proxy from config.yml during Settings initialization", async () => {
		const proxy = "http://127.0.0.1:7890";
		using agentDir = TempDir.createSync("@omp-network-proxy-");
		const configFiles = Bun.env.PI_CONFIG_FILES;
		delete Bun.env.PI_CONFIG_FILES;

		try {
			await Bun.write(agentDir.join("config.yml"), `network:\n  proxy: ${proxy}\n`);
			await Settings.loadReadOnly({ agentDir: agentDir.path(), cwd: agentDir.path() });

			expect(captureProxyEnvironment()).toEqual(
				Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, proxy])) as ProxyEnvironment,
			);
		} finally {
			if (configFiles === undefined) {
				delete Bun.env.PI_CONFIG_FILES;
			} else {
				Bun.env.PI_CONFIG_FILES = configFiles;
			}
		}
	});

	test("clearing restores the inherited proxy environment", () => {
		applyNetworkProxy("http://127.0.0.1:7890");

		expect(applyNetworkProxy("")).toBe("cleared");
		expect(captureProxyEnvironment()).toEqual(environmentBeforeTest);
	});

	test("rejects malformed and unsupported proxy URLs while restoring the inherited environment", () => {
		for (const proxy of ["not a URL", "socks5://127.0.0.1:1080"]) {
			applyNetworkProxy("http://127.0.0.1:7890");

			expect(applyNetworkProxy(proxy)).toBe("invalid");
			expect(captureProxyEnvironment()).toEqual(environmentBeforeTest);
		}
	});
});
