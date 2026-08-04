import { loadDotenvEnvironment } from "./dotenv";

export * from "./dotenv";
export * from "./worker-host";

loadDotenvEnvironment();

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@oh-my-pi/pi-utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Read an environment variable by its EXACT, case-sensitive name.
 *
 * `process.env` / `Bun.env` lookups are case-insensitive on Windows (Node backs
 * them with `uv_os_getenv`, Bun with a `CaseInsensitiveASCIIStringArrayHashMap`),
 * so a lowercase literal like `public` silently resolves to a differently-cased
 * system variable — Windows ships `PUBLIC=C:\Users\Public`. Enumerated keys are
 * the only signal that preserves the real casing, so this trusts the lookup only
 * when a key with identical casing is actually present. On POSIX (case-sensitive
 * env) it is equivalent to a direct lookup.
 *
 * Use this instead of `process.env[name] ?? literal` wherever `name` may be a
 * user-supplied literal (e.g. a stored API key) rather than a genuine env-var
 * reference — otherwise the literal gets hijacked by a same-named system var.
 *
 * @param name - Environment variable name to look up.
 * @param env - Environment source; defaults to `process.env`.
 */
export function $envExact(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	// Enumeration preserves real key casing on Windows, unlike the getter; the
	// value is trusted only when an exact-case entry actually exists.
	for (const key in env) {
		if (key === name) return value;
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}

let terminalHeadless = isBunTestRuntime();

/**
 * True when real-terminal side effects must be suppressed: stdout escape/frame
 * writes, stdin raw-mode + resume, CSI/OSC capability probes, SIGWINCH, window
 * title changes, and emergency restore. Defaults to {@link isBunTestRuntime} so
 * `bun test` launched inside a real TTY never paints the TUI, leaks probe
 * queries, or hijacks the developer's stdin; production runtimes stay
 * interactive.
 *
 * Terminal-contract tests that must exercise the real I/O path opt out with
 * `setTerminalHeadless(false)` and restore it afterwards.
 */
export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

/**
 * Override the {@link isTerminalHeadless} default and return the previous value
 * so callers can restore exact prior state (`const prev = setTerminalHeadless(false); … setTerminalHeadless(prev);`).
 */
export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

let interactiveHost = false;

/**
 * True when this process runs an interactive coding-agent host — the only
 * context where the operator can browse the Agent Hub and focus a live
 * subagent's session (`SessionFocusController`), so a subagent's session title
 * can become operator-visible. Off by default (print/RPC/ACP/eval/SDK/`bun
 * test` never render a focusable session tree); the interactive entrypoint
 * flips it on with {@link setInteractiveHost}.
 */
export function isInteractiveHost(): boolean {
	return interactiveHost;
}

/**
 * Set the interactive-host flag and return the previous value so callers can
 * restore exact prior state. See {@link isInteractiveHost}.
 */
export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

/**
 * SQLite `busy_timeout` for the session-critical databases (agent.db,
 * history.db, stats.db).
 *
 * Interactive hosts tolerate a longer synchronous wait on lock contention
 * (SQLITE_BUSY during WAL recovery/checkpoint — see oh-my-pi#2421): the
 * operator sees a brief freeze and the statement eventually completes.
 * Headless hosts (print/RPC/ACP/eval/SDK) run a protocol on the same thread —
 * a multi-second synchronous busy-wait freezes their event loop and stalls
 * every in-flight frame with no liveness signal, so they use a short timeout
 * and rely on the existing asynchronous open/retry paths to recover from
 * contention instead of blocking.
 */
export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
/** Parse a boolean-ish env value ("1", "yes", "on", …); `def` when unset/empty. */
export function parseFlag(value: string | undefined, def = false): boolean {
	if (!value) return def;
	return TRUTHY[value] === true;
}

export function $flag(name: string, def: boolean = false): boolean {
	return parseFlag($env[name], def);
}
