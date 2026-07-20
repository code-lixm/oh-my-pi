import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type CoordinationDetails, createIrcMessageCard, hubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getSettingsUiLocale, setSettingsUiLocale } from "../../src/i18n/settings-locale";

// Strip SGR ANSI escapes so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
/** Asserts the framed header line contains the IRC glyph immediately before the localized title. */
const assertHeaderGlyphSpacing = (rendered: readonly string[], glyph: string, expectedTitle: string) => {
	const firstLine = stripAnsi(rendered[0] ?? "").trim();
	expect(firstLine.startsWith("╭")).toBe(true);
	const compact = `${stripAnsi(glyph)} ${expectedTitle}`;
	const padded = `${stripAnsi(glyph)}  ${expectedTitle}`;
	expect(firstLine.includes(compact) || firstLine.includes(padded)).toBe(true);
};

const lineWith = (rendered: readonly string[], needle: string) => {
	const line = rendered.find(entry => entry.includes(needle));
	expect(line).toBeDefined();
	return line!;
};

const headerStart = (line: string) => {
	const col = line.indexOf("IRC ");
	expect(col).toBeGreaterThanOrEqual(0);
	return col;
};

const quoteColumns = (line: string, body: string, quoteBorder: string) => {
	const quote = line.indexOf(quoteBorder);
	const text = line.indexOf(body);
	expect(quote).toBeGreaterThanOrEqual(0);
	expect(text).toBe(quote + 2);
	return { quote, text };
};

let previousLocale = getSettingsUiLocale();

beforeEach(() => {
	previousLocale = getSettingsUiLocale();
	setSettingsUiLocale("en");
});

afterEach(() => {
	setSettingsUiLocale(previousLocale);
});

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");
const rawLines = (component: { render: (w: number) => readonly string[] }, width = 200) => component.render(width);

const expectRoundedFrame = (rendered: readonly string[], uiTheme: Theme, width: number) => {
	const plain = rendered.map(stripAnsi);
	expect(plain[0]?.trimStart().startsWith(uiTheme.boxRound.topLeft)).toBe(true);
	expect(plain[0]?.trimEnd().endsWith(uiTheme.boxRound.topRight)).toBe(true);
	expect(plain.at(-1)?.trimStart().startsWith(uiTheme.boxRound.bottomLeft)).toBe(true);
	expect(plain.at(-1)?.trimEnd().endsWith(uiTheme.boxRound.bottomRight)).toBe(true);
	expect(plain.map(line => visibleWidth(line))).toEqual(Array(plain.length).fill(width));
};

const msg = (overrides: Partial<IrcMessage>): IrcMessage => ({
	id: "7181122334455667789",
	from: "AuthLoader",
	to: "Main",
	body: "session-store rename is merged.",
	ts: Date.now() - 30_000,
	...overrides,
});

describe("hubToolRenderer send", () => {
	it("folds a single delivery outcome into the header and keeps sent and reply bodies aligned across collapse states", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		const sentBody = ["auth.ts line 1", "auth.ts line 2", "auth.ts line 3", "auth.ts line 4"].join("\n");
		const replyBody = ["reply line 1", "reply line 2", "reply line 3"].join("\n");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				op: "send",
				from: "Main",
				to: "AuthLoader",
				receipts: [{ to: "AuthLoader", outcome: "revived" }],
				waited: msg({ body: replyBody }),
			} satisfies CoordinationDetails,
		};

		const collapsed = lines(
			hubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme, {
				op: "send",
				to: "AuthLoader",
				message: sentBody,
				await: true,
			}),
		);
		assertHeaderGlyphSpacing(collapsed, glyph, "IRC");
		const outboundHeader = lineWith(collapsed, `IRC ${uiTheme.nav.selected} AuthLoader`);
		expect(outboundHeader).toContain("revived");
		const replyHeader = lineWith(collapsed, `${uiTheme.nav.back} AuthLoader`);
		const replyHeaderText = stripAnsi(replyHeader).trimStart();
		expect(replyHeaderText.startsWith(uiTheme.boxRound.vertical)).toBe(true);
		expect(replyHeaderText.slice(uiTheme.boxRound.vertical.length).trimStart()).toContain(
			`${uiTheme.nav.back} AuthLoader`,
		);

		const outboundBody = lineWith(collapsed, "auth.ts line 1");
		const replyLine = lineWith(collapsed, "reply line 1");
		const outboundCols = quoteColumns(outboundBody, "auth.ts line 1", uiTheme.md.quoteBorder);
		const replyCols = quoteColumns(replyLine, "reply line 1", uiTheme.md.quoteBorder);
		expect(outboundCols.quote).toBe(replyCols.quote);
		expect(outboundCols.text).toBe(replyCols.text);

		expect(collapsed.some(line => line.includes("auth.ts line 2"))).toBe(true);
		expect(collapsed.some(line => line.includes("auth.ts line 3"))).toBe(false);
		expect(collapsed.some(line => line.includes("+2 more lines"))).toBe(true);
		expect(collapsed.some(line => line.includes("reply line 2"))).toBe(true);
		expect(collapsed.some(line => line.includes("reply line 3"))).toBe(false);
		expect(collapsed.some(line => line.includes("+1 more line"))).toBe(true);

		const expanded = lines(
			hubToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme, {
				op: "send",
				to: "AuthLoader",
				message: sentBody,
				await: true,
			}),
		);
		expect(expanded.some(line => line.includes("auth.ts line 4"))).toBe(true);
		expect(expanded.some(line => line.includes("reply line 3"))).toBe(true);
		expect(expanded.some(line => line.includes("more lines"))).toBe(false);
	});

	it("lists per-recipient outcomes with error text when a broadcast partially fails", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "all",
						receipts: [
							{ to: "AuthLoader", outcome: "woken" },
							{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' },
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "all", message: "heads up" },
			),
		);
		expect(rendered[0]).toContain("broadcast");
		expect(rendered[0]).toContain("1 delivered");
		expect(rendered[0]).toContain("1 failed");
		expect(rendered.some(line => line.includes("AuthLoader") && line.includes("woken"))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes('unknown agent "RateLimiter"'))).toBe(
			true,
		);
	});

	it("flags an awaited send whose reply timed out", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "AuthLoader",
						receipts: [{ to: "AuthLoader", outcome: "injected" }],
						waited: null,
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "AuthLoader", message: "ping", await: true },
			),
		);
		expect(rendered[0]).toContain("no reply");
		expect(rendered.some(line => line.includes("No reply yet"))).toBe(true);
	});

	it("renders a pending send in a rounded frame with the draft body inside and no pending background", async () => {
		const uiTheme = await theme();
		const rendered = rawLines(
			hubToolRenderer.renderCall(
				{ op: "send", to: "AuthLoader", message: "pending payload" },
				{ expanded: false, isPartial: true },
				uiTheme,
			),
			80,
		);
		expectRoundedFrame(rendered, uiTheme, 80);
		expect(rendered.some(line => line.includes(uiTheme.getBgAnsi("toolPendingBg")))).toBe(false);
		const plain = rendered.map(stripAnsi);
		const bodyLine = plain.find(line => line.includes("pending payload"));
		expect(bodyLine).toBeDefined();
		expect(bodyLine).toContain(uiTheme.boxRound.vertical);
	});

	it("surfaces pre-delivery validation failures as an error detail", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: '`to` is required for op="send".' }],
					details: { op: "send", from: "Main" } satisfies CoordinationDetails,
					isError: true,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send" },
			),
		);
		expect(rendered.some(line => line.includes('`to` is required for op="send".'))).toBe(true);
	});

	it("localizes zh-CN header and glyph spacing for send", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		setSettingsUiLocale("zh-CN");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "send",
						from: "Main",
						to: "AuthLoader",
						receipts: [{ to: "AuthLoader", outcome: "revived" }],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "send", to: "AuthLoader", message: "hello", await: true },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "代理通信");
		const header = rendered[0] ?? "";
		expect(header).toContain("代理通信");
		expect(header).toContain("AuthLoader");
		expect(header).toContain("已恢复");
		expect(header).not.toContain("revived");
	});
});

describe("hubToolRenderer wait", () => {
	it("renders the consumed message under a sender header", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { op: "wait", from: "Main", waited: msg({}) } satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "IRC");
		expect(rendered[0]).toContain("AuthLoader");
		expect(rendered.some(line => line.includes("session-store rename is merged."))).toBe(true);
	});

	it("keeps a successful wait body inside a rounded frame without a success background", async () => {
		const uiTheme = await theme();
		const rendered = rawLines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "wait",
						from: "Main",
						waited: msg({ body: "wait line 1\nwait line 2" }),
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
			80,
		);
		expectRoundedFrame(rendered, uiTheme, 80);
		expect(rendered.some(line => line.includes(uiTheme.getBgAnsi("toolSuccessBg")))).toBe(false);
		const plain = rendered.map(stripAnsi);
		expect(plain.some(line => line.includes("wait line 1"))).toBe(true);
		expect(plain.some(line => line.includes("wait line 2"))).toBe(true);
		const bodyLine = plain.find(line => line.includes("wait line 1"));
		expect(bodyLine).toBeDefined();
		expect(bodyLine).toContain(uiTheme.boxRound.vertical);
	});

	it("marks a timed-out wait without inventing a consumed message body", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "No message from AuthLoader within 2m." }],
					details: { op: "wait", from: "Main", waited: null } satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
		);
		expect(rendered[0]).toContain("timed out");
		expect(rendered.some(line => line.includes("No message from AuthLoader within 2m."))).toBe(true);
		expect(rendered.some(line => line.includes("session-store rename is merged."))).toBe(false);
	});

	it("localizes zh-CN header and glyph spacing for wait", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		setSettingsUiLocale("zh-CN");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { op: "wait", from: "Main", waited: msg({}) } satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "wait", from: "AuthLoader" },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "代理通信");
		const header = rendered[0] ?? "";
		expect(header).toContain("代理通信");
		expect(header).toContain("AuthLoader");
		expect(rendered.some(line => line.includes("session-store rename is merged."))).toBe(true);
	});
});

describe("hubToolRenderer inbox", () => {
	it("lists each message with sender and body preview", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "inbox",
						from: "Main",
						inbox: [
							msg({ from: "AuthLoader", body: "bus landed." }),
							msg({ from: "RateLimiter", body: "receipts carry outcome.", replyTo: "7181122334455667791" }),
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "inbox", peek: true },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "IRC");
		expect(rendered[0]).toContain("2 messages");
		expect(rendered[0]).toContain("peek");
		expect(rendered.some(line => line.includes("bus landed."))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter"))).toBe(true);
		expect(rendered.some(line => line.includes("receipts carry outcome."))).toBe(true);
	});

	it("localizes zh-CN inbox chrome while keeping sender ids and bodies verbatim", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		setSettingsUiLocale("zh-CN");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "inbox",
						from: "Main",
						inbox: [
							msg({ from: "AuthLoader", body: "bus landed." }),
							msg({ from: "RateLimiter", body: "receipts carry outcome.", replyTo: "7181122334455667791" }),
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "inbox", peek: true },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "代理通信");
		const header = rendered[0] ?? "";
		expect(header).toContain("代理通信 · 收件箱");
		expect(header).not.toContain("inbox");
		expect(header).toContain("2 条消息");
		expect(header).not.toContain("messages");
		expect(header).toContain("仅查看");
		expect(header).not.toContain("peek");
		expect(rendered.some(line => line.includes("AuthLoader"))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter"))).toBe(true);
		expect(rendered.some(line => line.includes("bus landed."))).toBe(true);
		expect(rendered.some(line => line.includes("receipts carry outcome."))).toBe(true);
	});
});

describe("hubToolRenderer list", () => {
	it("summarizes status counts and flags unread peers", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "list",
						from: "Main",
						peers: [
							{
								id: "RateLimiter",
								displayName: "task",
								kind: "sub",
								status: "parked",
								parentId: "Main",
								unread: 2,
								lastActivity: Date.now() - 12 * 60_000,
							},
							{
								id: "AuthLoader",
								displayName: "task",
								kind: "sub",
								status: "running",
								parentId: "Main",
								unread: 0,
								lastActivity: Date.now() - 2 * 60_000,
							},
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "IRC");
		expect(rendered[0]).toContain("1 running");
		expect(rendered[0]).toContain("1 parked");
		expect(rendered[0]).toContain("2 unread");
		// Running peers sort above parked ones regardless of input order.
		const authIndex = rendered.findIndex(line => line.includes("AuthLoader"));
		const rateIndex = rendered.findIndex(line => line.includes("RateLimiter"));
		expect(authIndex).toBeGreaterThan(0);
		expect(authIndex).toBeLessThan(rateIndex);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes("2 unread"))).toBe(true);
	});

	it("renders a peer's role displayName and current activity in the row", async () => {
		const uiTheme = await theme();
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "list",
						from: "Main",
						peers: [
							{
								id: "AuthScout",
								displayName: "Auth-flow security reviewer",
								kind: "sub",
								status: "running",
								parentId: "Main",
								unread: 0,
								lastActivity: Date.now() - 5_000,
								activity: "auditing the token refresh path",
							},
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		const row = rendered.find(line => line.includes("AuthScout"));
		expect(row).toBeDefined();
		expect(row).toContain("Auth-flow security reviewer");
		expect(row).toContain("auditing the token refresh path");
	});

	it("localizes zh-CN peer chrome while keeping ids, displayName, and activity verbatim", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		setSettingsUiLocale("zh-CN");
		const rendered = lines(
			hubToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						op: "list",
						from: "Main",
						peers: [
							{
								id: "RateLimiter",
								displayName: "task",
								kind: "sub",
								status: "parked",
								parentId: "Main",
								unread: 2,
								lastActivity: Date.now() - 12 * 60_000,
							},
							{
								id: "AuthScout",
								displayName: "Auth-flow security reviewer",
								kind: "sub",
								status: "running",
								parentId: "Main",
								unread: 0,
								lastActivity: Date.now() - 5_000,
								activity: "auditing the token refresh path",
							},
						],
					} satisfies CoordinationDetails,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				{ op: "list" },
			),
		);
		assertHeaderGlyphSpacing(rendered, glyph, "代理通信");
		const header = rendered[0] ?? "";
		expect(header).toContain("代理通信 · 对等代理");
		expect(header).toContain("运行中");
		expect(header).toContain("已停放");
		expect(header).toMatch(/2.*未读/);

		const parkedRow = rendered.find(line => line.includes("RateLimiter"));
		expect(parkedRow).toBeDefined();
		expect(parkedRow).toContain("属于 Main");
		expect(parkedRow).not.toContain("of Main");
		expect(parkedRow).toMatch(/2.*未读/);

		const runningRow = rendered.find(line => line.includes("AuthScout"));
		expect(runningRow).toBeDefined();
		expect(runningRow).toContain("Auth-flow security reviewer");
		expect(runningRow).toContain("auditing the token refresh path");
	});
});

describe("createIrcMessageCard", () => {
	it("keeps incoming, auto-reply, and relay cards on the same header and body columns", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		const incoming = lines(
			createIrcMessageCard(
				{ kind: "incoming", from: "AuthLoader", body: "incoming body", timestamp: Date.now() - 15_000 },
				() => false,
				uiTheme,
			),
		);
		const autoreply = lines(
			createIrcMessageCard(
				{
					kind: "autoreply",
					to: "Main",
					body: "autoreply body",
					replyTo: "7181122334455667789",
					timestamp: Date.now() - 10_000,
				},
				() => false,
				uiTheme,
			),
		);
		const relay = lines(
			createIrcMessageCard(
				{
					kind: "relay",
					from: "AuthLoader",
					to: "Main",
					body: "relay body",
					replyTo: "7181122334455667790",
					timestamp: Date.now() - 5_000,
				},
				() => false,
				uiTheme,
			),
		);

		assertHeaderGlyphSpacing(incoming, glyph, "IRC");
		assertHeaderGlyphSpacing(autoreply, glyph, "IRC");
		assertHeaderGlyphSpacing(relay, glyph, "IRC");

		const incomingHeader = lineWith(incoming, `IRC ${uiTheme.nav.back} AuthLoader`);
		const autoreplyHeader = lineWith(autoreply, `IRC ${uiTheme.nav.selected} Main`);
		const relayHeader = lineWith(relay, `IRC AuthLoader ${uiTheme.nav.selected} Main`);
		const incomingHeaderCol = headerStart(incomingHeader);
		expect(headerStart(autoreplyHeader)).toBe(incomingHeaderCol);
		expect(headerStart(relayHeader)).toBe(incomingHeaderCol);

		const incomingCols = quoteColumns(lineWith(incoming, "incoming body"), "incoming body", uiTheme.md.quoteBorder);
		const autoreplyCols = quoteColumns(
			lineWith(autoreply, "autoreply body"),
			"autoreply body",
			uiTheme.md.quoteBorder,
		);
		const relayCols = quoteColumns(lineWith(relay, "relay body"), "relay body", uiTheme.md.quoteBorder);
		expect(autoreplyCols.quote).toBe(incomingCols.quote);
		expect(relayCols.quote).toBe(incomingCols.quote);
		expect(autoreplyCols.text).toBe(incomingCols.text);
		expect(relayCols.text).toBe(incomingCols.text);
	});

	it("renders live incoming cards in a rounded frame with the body inside and no success background", async () => {
		const uiTheme = await theme();
		const rendered = rawLines(
			createIrcMessageCard(
				{ kind: "incoming", from: "AuthLoader", body: "live incoming body", timestamp: Date.now() - 15_000 },
				() => false,
				uiTheme,
			),
			80,
		);
		expectRoundedFrame(rendered, uiTheme, 80);
		expect(rendered.some(line => line.includes(uiTheme.getBgAnsi("toolSuccessBg")))).toBe(false);
		const plain = rendered.map(stripAnsi);
		const bodyLine = plain.find(line => line.includes("live incoming body"));
		expect(bodyLine).toBeDefined();
		expect(bodyLine).toContain(uiTheme.boxRound.vertical);
	});

	it("localizes zh-CN message card headers with glyph spacing", async () => {
		const uiTheme = await theme();
		const glyph = uiTheme.styledSymbol("tool.irc", "accent");
		setSettingsUiLocale("zh-CN");
		const incoming = lines(
			createIrcMessageCard(
				{ kind: "incoming", from: "AuthLoader", body: "incoming body", timestamp: Date.now() - 15_000 },
				() => false,
				uiTheme,
			),
		);
		const autoreply = lines(
			createIrcMessageCard(
				{
					kind: "autoreply",
					to: "Main",
					body: "autoreply body",
					replyTo: "7181122334455667789",
					timestamp: Date.now() - 10_000,
				},
				() => false,
				uiTheme,
			),
		);
		const relay = lines(
			createIrcMessageCard(
				{
					kind: "relay",
					from: "AuthLoader",
					to: "Main",
					body: "relay body",
					replyTo: "7181122334455667790",
					timestamp: Date.now() - 5_000,
				},
				() => false,
				uiTheme,
			),
		);

		assertHeaderGlyphSpacing(incoming, glyph, "代理通信");
		assertHeaderGlyphSpacing(autoreply, glyph, "代理通信");
		assertHeaderGlyphSpacing(relay, glyph, "代理通信");

		// peer ids and body text are verbatim
		expect(stripAnsi(incoming[0] ?? "")).toContain("AuthLoader");
		expect(stripAnsi(incoming[1] ?? "")).toContain("incoming body");
		expect(stripAnsi(autoreply[0] ?? "")).toContain("Main");
		expect(stripAnsi(autoreply[1] ?? "")).toContain("autoreply body");
		expect(stripAnsi(relay[0] ?? "")).toContain("AuthLoader");
		expect(stripAnsi(relay[0] ?? "")).toContain("Main");
		expect(stripAnsi(relay[1] ?? "")).toContain("relay body");
	});
});

describe("hubToolRenderer body truncation", () => {
	it("collapses long bodies with an elision counter and expands on demand", async () => {
		const uiTheme = await theme();
		const body = Array.from({ length: 6 }, (_, i) => `reply line ${i + 1}`).join("\n");
		const details: CoordinationDetails = { op: "wait", from: "Main", waited: msg({ body }) };
		const result = { content: [{ type: "text", text: "" }], details };

		const collapsed = lines(
			hubToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { op: "wait" }),
		);
		expect(collapsed.some(line => line.includes("reply line 2"))).toBe(true);
		expect(collapsed.some(line => line.includes("reply line 3"))).toBe(false);
		expect(collapsed.some(line => line.includes("+4 more lines"))).toBe(true);

		const expanded = lines(
			hubToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme, { op: "wait" }),
		);
		expect(expanded.some(line => line.includes("reply line 6"))).toBe(true);
		expect(expanded.some(line => line.includes("more lines"))).toBe(false);
	});
});
