#!/usr/bin/env bun
import { type ClaudeTraceCommandArgs, runClaudeTraceCommand } from "../packages/coding-agent/src/cli/claude-trace-cli";

// Minimal in-script i18n. Locale resolution: explicit OMP_LOCALE / PI_LOCALE >
// LC_ALL > LANG; anything starting with "zh" maps to zh-CN, otherwise English.
// Keep flag names, file paths, and dynamic error messages untouched.
type Locale = "en" | "zh-CN";
const MESSAGES: Record<string, Record<string, string>> = {
	en: {
		help_title: "Usage: bun scripts/claude-trace.ts [options]",
		help_summary:
			'Runs Claude Code in a headless PTY behind a local HTTPS proxy, sends "hi", and\nprints the first /v1/messages request/response headers and bodies.',
		help_options: "Options:",
		opt_command: "  --command <cmd>          Command to run in the virtual TUI (default: claude)",
		opt_message: "  --message <text>         Message to send (default: hi)",
		opt_cwd: "  --cwd <path>             Working directory for the Claude process",
		opt_host: "  --host <host>            Proxy bind host (default: 127.0.0.1)",
		opt_port: "  --port <port>            Proxy bind port (default: 8080; use 0 for random)",
		opt_timeout: "  --timeout <ms>           Overall timeout in milliseconds (default: 120000)",
		opt_input_delay: "  --input-delay <ms>       Delay before sending input (default: 1000)",
		opt_json: "  --json                   Print JSON instead of Markdown-ish text",
		opt_upstream_insecure: "  --upstream-insecure      Disable TLS verification for the upstream server",
		opt_help: "  -h, --help               Show this help",
		err_requires_value: "{name} requires a value",
		err_non_negative_integer: "{name} must be a non-negative integer",
		err_unknown_option: "Unknown option: {item}",
	},
	"zh-CN": {
		help_title: "用法：bun scripts/claude-trace.ts [选项]",
		help_summary:
			'在本地 HTTPS 代理后以无头 PTY 方式运行 Claude Code，发送 "hi"，\n并打印首个 /v1/messages 请求与响应的头部与正文。',
		help_options: "选项：",
		opt_command: "  --command <cmd>          在虚拟 TUI 中执行的命令（默认：claude）",
		opt_message: "  --message <text>         要发送的消息（默认：hi）",
		opt_cwd: "  --cwd <path>             Claude 进程的工作目录",
		opt_host: "  --host <host>            代理绑定主机（默认：127.0.0.1）",
		opt_port: "  --port <port>            代理绑定端口（默认：8080；传 0 表示随机）",
		opt_timeout: "  --timeout <ms>           总超时（毫秒，默认：120000）",
		opt_input_delay: "  --input-delay <ms>       发送输入前的延迟（默认：1000）",
		opt_json: "  --json                   改用 JSON 而非 Markdown 风格输出",
		opt_upstream_insecure: "  --upstream-insecure      关闭上游服务器的 TLS 校验",
		opt_help: "  -h, --help               显示此帮助",
		err_requires_value: "{name} 需要一个值",
		err_non_negative_integer: "{name} 必须是非负整数",
		err_unknown_option: "未知选项：{item}",
	},
};

function detectLocale(): Locale {
	const source =
		[Bun.env.OMP_LOCALE, Bun.env.PI_LOCALE, Bun.env.LC_ALL, Bun.env.LANG].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		) ?? "";
	return source.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function t(key: string, params?: Record<string, string>): string {
	const locale = detectLocale();
	const table = MESSAGES[locale] ?? MESSAGES.en;
	const template = table[key] ?? MESSAGES.en[key] ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
}

function buildHelp(): string {
	const keys = [
		"help_title",
		"help_summary",
		"help_options",
		"opt_command",
		"opt_message",
		"opt_cwd",
		"opt_host",
		"opt_port",
		"opt_timeout",
		"opt_input_delay",
		"opt_json",
		"opt_upstream_insecure",
		"opt_help",
	] as const;
	return `${keys.map(k => t(k)).join("\n")}\n`;
}

function readOptionValue(argv: readonly string[], index: number, name: string): { value: string; nextIndex: number } {
	const inlinePrefix = `${name}=`;
	const current = argv[index] ?? "";
	if (current.startsWith(inlinePrefix)) return { value: current.slice(inlinePrefix.length), nextIndex: index };
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(t("err_requires_value", { name }));
	return { value, nextIndex: index + 1 };
}

function parseIntegerOption(value: string, name: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(t("err_non_negative_integer", { name }));
	return parsed;
}

export function parseClaudeTraceScriptArgs(argv: readonly string[]): ClaudeTraceCommandArgs | "help" {
	const args: ClaudeTraceCommandArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const item = argv[i] ?? "";
		if (item === "-h" || item === "--help") return "help";
		if (item === "--json") {
			args.json = true;
			continue;
		}
		if (item === "--upstream-insecure") {
			args.upstreamTlsRejectUnauthorized = false;
			continue;
		}
		if (item === "--command" || item.startsWith("--command=")) {
			const parsed = readOptionValue(argv, i, "--command");
			args.command = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--message" || item.startsWith("--message=")) {
			const parsed = readOptionValue(argv, i, "--message");
			args.message = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--cwd" || item.startsWith("--cwd=")) {
			const parsed = readOptionValue(argv, i, "--cwd");
			args.cwd = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--host" || item.startsWith("--host=")) {
			const parsed = readOptionValue(argv, i, "--host");
			args.host = parsed.value;
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--port" || item.startsWith("--port=")) {
			const parsed = readOptionValue(argv, i, "--port");
			args.port = parseIntegerOption(parsed.value, "--port");
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--timeout" || item.startsWith("--timeout=")) {
			const parsed = readOptionValue(argv, i, "--timeout");
			args.timeoutMs = parseIntegerOption(parsed.value, "--timeout");
			i = parsed.nextIndex;
			continue;
		}
		if (item === "--input-delay" || item.startsWith("--input-delay=")) {
			const parsed = readOptionValue(argv, i, "--input-delay");
			args.inputDelayMs = parseIntegerOption(parsed.value, "--input-delay");
			i = parsed.nextIndex;
			continue;
		}
		throw new Error(t("err_unknown_option", { item }));
	}
	return args;
}

export async function runClaudeTraceScript(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	const parsed = parseClaudeTraceScriptArgs(argv);
	if (parsed === "help") {
		process.stdout.write(buildHelp());
		return;
	}
	await runClaudeTraceCommand(parsed);
}

if (import.meta.main) {
	try {
		await runClaudeTraceScript();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
