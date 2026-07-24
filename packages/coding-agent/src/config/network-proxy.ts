import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";

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
const inheritedProxyEnv: Record<ProxyEnvKey, string | undefined> = {
	PI_PROXY: Bun.env.PI_PROXY,
	HTTP_PROXY: Bun.env.HTTP_PROXY,
	HTTPS_PROXY: Bun.env.HTTPS_PROXY,
	ALL_PROXY: Bun.env.ALL_PROXY,
	http_proxy: Bun.env.http_proxy,
	https_proxy: Bun.env.https_proxy,
	all_proxy: Bun.env.all_proxy,
};

export type NetworkProxyResult = "configured" | "cleared" | "invalid";

/**
 * Applies the global proxy setting to Bun and pi-ai transports.
 *
 * A configured proxy takes precedence over inherited proxy environment variables.
 * Clearing the setting restores the process environment captured before settings
 * initialization, while NO_PROXY/no_proxy remains entirely user-controlled.
 */
export function applyNetworkProxy(value: unknown): NetworkProxyResult {
	const proxy = typeof value === "string" ? value.trim() : "";
	if (!proxy) {
		restoreInheritedProxyEnv();
		return "cleared";
	}

	try {
		const url = new URL(proxy);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
			throw new TypeError("unsupported proxy URL");
		}
	} catch {
		restoreInheritedProxyEnv();
		return "invalid";
	}

	for (const key of PROXY_ENV_KEYS) {
		Bun.env[key] = proxy;
	}
	__resetProxyCache();
	return "configured";
}

function restoreInheritedProxyEnv(): void {
	for (const key of PROXY_ENV_KEYS) {
		const value = inheritedProxyEnv[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	__resetProxyCache();
}
