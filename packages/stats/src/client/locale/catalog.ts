/**
 * Stats dashboard i18n catalog. Flat dotted keys organized by surface area
 * (chrome, nav, layout, route, component). Plain strings are templates that
 * may contain `{name}` placeholders. Pluralization is handled inline at the
 * call site via `tp(singularKey, pluralKey, n)` rather than via
 * `{one, other}` entries — keeps the table flat.
 *
 * `t(key, params?)` reads the current locale from the module-level store, so
 * it can be called from event handlers, useMemo callbacks, and effect
 * cleaners without violating the rules of hooks. Components that need to
 * re-render on a locale switch call `useLocale()` to subscribe.
 */

import { DEFAULT_LOCALE, getLocale, type Locale } from "../useLocale";

export type CatalogLeaf = string;
export type Catalog = Record<string, CatalogLeaf>;

// English is the source of truth and the runtime fallback when a key is
// missing in the active locale. Strings are copied verbatim from the previous
// hard-coded call sites; once zh-CN fills in, English stays as the developer
// reference.
const en: Catalog = {
	// shared chrome
	"chrome.app.title": "Observability",

	// navigation
	"nav.overview": "Overview",
	"nav.requests": "Requests",
	"nav.errors": "Errors",
	"nav.models": "Models",
	"nav.tools": "Tools",
	"nav.costs": "Costs",
	"nav.behavior": "Behavior",
	"nav.projects": "Projects",
	"nav.gain": "Gain",

	// layout
	"layout.drawer.aria": "Navigation menu",
	"layout.drawer.close": "Close navigation menu",
	"layout.logo.subtext": "Observability",

	// top bar
	"topBar.menu.open": "Open navigation menu",
	"topBar.title.fallback": "Observability",
	"topBar.lastUpdated.notUpdated": "Not updated",
	"topBar.lastUpdated.prefix": "Updated {time}",

	// range control
	"rangeControl.aria": "Select time range",
	"rangeControl.all": "All",

	// theme toggle
	"themeToggle.system": "System theme",
	"themeToggle.light": "Light theme",
	"themeToggle.dark": "Dark theme",
	"themeToggle.cycleHint.aria": " (click to switch)",
	"themeToggle.cycleHint.title": " — click to switch",

	// locale toggle — key suffix = TARGET locale; text describes clicking the
	// button. Values are written in the locale the *next* click will surface
	// (so the user reads it in the language they'll see after switching).
	"localeToggle.cycleHint.to-en": "Switch language to English",
	"localeToggle.cycleHint.to-zh-CN": "Switch language to 中文",
	"localeToggle.label.en": "EN",
	"localeToggle.label.zh-CN": "中",

	// sync button
	"syncButton.idle": "Sync DB",
	"syncButton.syncing": "Syncing...",
	"syncButton.success.singular": "Synced: {n} new request found.",
	"syncButton.success.plural": "Synced: {n} new requests found.",
	"syncButton.error": "Sync failed: {message}",

	// shared empty/error states
	"state.empty.default": "No data available",
	"state.error.title": "Failed to load data",
	"state.error.retry": "Retry",
	"state.table.empty.default": "No data available",
	"state.asyncBoundary.empty.default": "No data available",

	// json block
	"jsonBlock.copy": "Copy",
	"jsonBlock.copied": "Copied",
	"jsonBlock.copyAria": "Copy JSON to clipboard",
	"jsonBlock.copiedAria": "Copied to clipboard",
	"jsonBlock.show": "▶ Show",
	"jsonBlock.hide": "▼ Hide",
	"jsonBlock.title.default": "JSON",

	// request drawer
	"requestDrawer.title": "Request Details",
	"requestDrawer.id": "ID: {id}",
	"requestDrawer.closeAria": "Close request details",
	"requestDrawer.dialogAria": "Request details",
	"requestDrawer.status.error": "Error",
	"requestDrawer.status.success": "Success",
	"requestDrawer.errorMessage": "Error Message",
	"requestDrawer.errorTitle": "Failed to load request details",
	"requestDrawer.json.output": "Output Payload",
	"requestDrawer.json.raw": "Raw Request Metadata",
	"requestDrawer.tokenSub.inOut": "{in} in · {out} out",

	// range metadata window labels
	"rangeMeta.1h.window": "the last hour",
	"rangeMeta.24h.window": "the last 24 hours",
	"rangeMeta.7d.window": "the last 7 days",
	"rangeMeta.30d.window": "the last 30 days",
	"rangeMeta.90d.window": "the last 90 days",
	"rangeMeta.all.window": "all time",
	"rangeMeta.1h.trend": "1h Trend",
	"rangeMeta.24h.trend": "24h Trend",
	"rangeMeta.7d.trend": "7d Trend",
	"rangeMeta.30d.trend": "30d Trend",
	"rangeMeta.90d.trend": "90d Trend",
	"rangeMeta.all.trend": "Trend",

	// agent token share
	"agentShare.main": "Main agent",
	"agentShare.subagent": "Subagents",
	"agentShare.advisor": "Advisor",
	"agentShare.empty": "No token usage in this range",
	"agentShare.unit.req": "req",
	"agentShare.unit.tok": "tok",

	// shared table column / status labels (chrome only; quantitative metric names stay raw)
	"table.column.model": "Model",
	"table.column.time": "Time",
	"table.column.tokens": "Tokens",
	"table.column.cost": "Cost",
	"table.column.duration": "Duration",
	"table.column.status": "Status",
	"table.status.success": "Success",
	"table.status.failed": "Failed",
	"table.column.requests": "Requests",

	// overview route
	"overview.tokenUsage.title": "Token Usage by Agent",
	"overview.tokenUsage.subtitle": "Share of tokens across the main agent, task subagents, and the advisor",
	"overview.throughput.title": "System Throughput",
	"overview.throughput.subtitle": "Request volume and errors over time",
	"overview.throughput.empty": "No time-series data available",
	"overview.legend.requests": "Requests",
	"overview.legend.errors": "Errors",
	"overview.feed.title": "Operational Feed",
	"overview.feed.subtitle": "Real-time request log",
	"overview.feed.empty": "No recent requests found",
	"overview.preview.title": "Recent Requests Preview",
	"overview.preview.subtitle": "Latest transactions processed by the proxy",
	"overview.preview.viewAll": "View All Requests",

	// requests route
	"requests.title": "All Recent Requests",
	"requests.subtitle": "Up to 50 most recent requests processed by OMP",
	"requests.empty": "No recent requests found",
	"requests.mobile.cost": "Cost",
	"requests.mobile.tokens": "Tokens",
	"requests.mobile.duration": "Duration",

	// errors route
	"errors.title": "Recent Errors",
	"errors.subtitle": "Up to 50 most recent failed requests in the stats database",
	"errors.empty": "No recent failures in the local stats database",
	"errors.unknownError": "Unknown error",
	"errors.column.errorMessage": "Error Message",
	"errors.mobile.cost": "Cost",
	"errors.mobile.tokens": "Tokens",
	"errors.mobile.status.failed": "Failed",

	// models route
	"models.share.title": "Model Preference",
	"models.share.subtitle": "Share of requests over {window}",
	"models.share.empty": "No data available",
	"models.table.title": "Model Statistics",
	"models.table.column.model": "Model",
	"models.table.column.requests": "Requests",
	"models.table.column.cost": "Cost",
	"models.table.column.tokens": "Tokens",
	"models.table.column.tps": "Tokens/s",
	"models.table.column.ttft": "TTFT",
	"models.expanded.quality": "Quality",
	"models.expanded.errorRate": "Error rate",
	"models.expanded.cacheRate": "Cache rate",
	"models.expanded.latency": "Latency",
	"models.expanded.avgDuration": "Avg duration",
	"models.expanded.avgTtft": "Avg TTFT",
	"models.series.other": "Other",

	// tools route
	"tools.summary.title": "Tool Usage",
	"tools.summary.subtitle":
		"Tokens/cost are the invoking turns' real provider usage, split across each turn's tool calls",
	"tools.summary.calls": "Tool Calls",
	"tools.summary.tools": "Tools Used",
	"tools.summary.errorRate": "Error Rate",
	"tools.summary.attributedCost": "Attributed Cost",
	"tools.summary.attributedTokens": "Attributed Tokens",
	"tools.summary.attributedOutput": "Attributed Output",
	"tools.summary.resultText": "Result Text",
	"tools.summary.callArgs": "Call Arguments",
	"tools.empty": "No tool calls recorded for this range.",
	"tools.chart.title": "Calls Over Time",
	"tools.chart.subtitle": "Tool calls over {window}, stacked by tool",
	"tools.chart.empty": "No data available",
	"tools.table.title": "By Tool",
	"tools.table.subtitle": "Usage per tool, most called first",
	"tools.table.column.tool": "Tool",
	"tools.table.column.calls": "Calls",
	"tools.table.column.errorRate": "Error Rate",
	"tools.table.column.attributedTokens": "Attr. Tokens",
	"tools.table.column.attributedCost": "Attr. Cost",
	"tools.table.column.resultText": "Result Text",
	"tools.table.column.lastUsed": "Last Used",
	"tools.table.attrTokensTitle": "Invoking turns' total tokens, split across each turn's calls",
	"tools.table.resultTextTitle": "Characters of tool-result text fed back into context",
	"tools.byModel.title": "By Model",
	"tools.byModel.subtitle": "Which models call which tools",
	"tools.byModel.toolLabel": "Tool",
	"tools.byModel.allTools": "All tools",

	// costs route
	"costs.card.totalCost": "Total Cost",
	"costs.card.avgPerDay": "Average / Day",
	"costs.card.topModel": "Top Model",
	"costs.card.totalSpentSuffix": "Total spent: {value}",
	"costs.trend.title": "Daily Cost",
	"costs.trend.subtitle": "API spending over time",
	"costs.trend.allModels": "All Models",
	"costs.trend.byModel": "By Model",
	"costs.trend.empty": "No cost data available",
	"costs.trend.label": "Cost",
	"costs.trend.totalFooter": "Total: {value}",
	"costs.trend.dataset.cost": "Cost",

	// behavior route
	"behavior.summary.userMessages": "User Messages",
	"behavior.summary.yelling": "Yelling (CAPS)",
	"behavior.summary.profanity": "Profanity Hits",
	"behavior.summary.anguish": "Anguish Signals",
	"behavior.summary.friction": "Friction Signals",
	"behavior.summary.highestFrictionModel": "Highest Friction Model",
	"behavior.summary.subInRange": "in range",
	"behavior.summary.subHits": "{n} hits",
	"behavior.metric.caps": "CAPS",
	"behavior.metric.capsTitle": "Yelling (CAPS)",
	"behavior.metric.profanity": "Profanity",
	"behavior.metric.anguish": "Anguish",
	"behavior.metric.anguishTitle": "Anguish (!!!, nooo, ugh, dude, ':(')",
	"behavior.metric.negation": "Negation",
	"behavior.metric.negationTitle": "Negation (no/nope/wrong, makes no sense)",
	"behavior.metric.repetition": "Repetition",
	"behavior.metric.repetitionTitle": "Repetition (i meant, still doesnt)",
	"behavior.metric.blame": "Blame",
	"behavior.metric.blameTitle": "Blame (you didnt, why did you, stop X-ing)",
	"behavior.metric.frustration": "Frustration",
	"behavior.metric.frustrationTitle": "Frustration (neg + rep + blame)",
	"behavior.metric.all": "All",
	"behavior.metric.allTitle": "All signals combined",
	"behavior.byModel.toggle.allModels": "All Models",
	"behavior.byModel.toggle.byModel": "By Model",
	"behavior.chart.title": "User Friction Signals",
	"behavior.chart.subtitle": "{metric} as % of user messages per day",
	"behavior.chart.label": "Hits",
	"behavior.chart.empty": "No friction signal data available",
	"behavior.byModel.title": "Behavior Signals by Model",
	"behavior.byModel.subtitle": "Rates are per user message",
	"behavior.byModel.column.model": "Model",
	"behavior.byModel.column.messages": "Messages",
	"behavior.byModel.column.capsPct": "CAPS %",
	"behavior.byModel.column.profanityPct": "Profanity %",
	"behavior.byModel.column.anguishPct": "Anguish %",
	"behavior.byModel.column.frustrationPct": "Frustration %",
	"behavior.byModel.column.hitsPct": "Hits %",
	"behavior.byModel.column.trend": "Trend",
	"behavior.byModel.rowAnguish": "Anguish (!!!, nooo, dude, ..)",
	"behavior.byModel.rowRepetition": "Repetition (i meant, still doesnt)",
	"behavior.byModel.rowBlame": "Blame (you didnt, stop X-ing)",
	"behavior.byModel.rowNegation": "Negation (no/nope/wrong)",
	"behavior.byModel.rowAvgChars": "Avg chars / msg",
	"behavior.byModel.label.total": "Total",
	"behavior.byModel.label.perMsgRate": "% of msgs",
	"behavior.byModel.label.perMsgAvg": "Per msg",
	"behavior.byModel.label.caps": "CAPS",
	"behavior.byModel.label.profanity": "Profanity",
	"behavior.byModel.label.anguish": "Anguish",
	"behavior.byModel.label.frustration": "Frustration",
	"behavior.byModel.label.seriesCaps": "CAPS",
	"behavior.byModel.label.seriesProfanity": "Profanity",
	"behavior.byModel.label.seriesAnguish": "Anguish",
	"behavior.byModel.label.seriesFrustration": "Frustration",
	"behavior.byModel.empty": "No user behavior recorded for this range yet.",

	// projects route
	"projects.title": "Projects & Folders",
	"projects.subtitle": "Aggregate proxy metrics grouped by folder path",
	"projects.empty": "No project folders recorded for this range.",
	"projects.column.folder": "Project/Folder",
	"projects.column.requests": "Requests",
	"projects.column.cost": "Cost",
	"projects.column.tokens": "Tokens",
	"projects.column.cacheRate": "Cache Rate",
	"projects.column.errorRate": "Error Rate",
	"projects.column.avgDuration": "Avg Duration",
	"projects.mobile.cache": "Cache",
	"projects.mobile.duration": "Duration",
	"projects.mobile.err": "Err",
	"projects.folder.root": "(root)",

	// gain route
	"gain.project.label": "Project",
	"gain.project.allOption": "All projects",
	"gain.overall.title": "Overall Gain",
	"gain.overall.subtitle": "Aggregate snapcompact savings",
	"gain.overall.savedTokens": "Saved Tokens",
	"gain.overall.savedBytes": "Saved Bytes",
	"gain.overall.reduction": "Reduction",
	"gain.overall.totalHits": "Total Hits",
	"gain.bySource.title": "By Source",
	"gain.bySource.subtitle": "Savings breakdown per subsystem",
	"gain.bySource.snapcompact": "Snapcompact",
	"gain.bySource.hits": "Hits",
	"gain.chart.title": "Savings Over Time",
	"gain.chart.subtitle": "Daily token savings",
	"gain.chart.label": "Tokens Saved",
	"gain.chart.empty": "No time series data yet",
	"gain.chart.dataset.snapcompact": "Snapcompact",
};

// Chinese translations. Missing keys transparently fall back to English at
// runtime; en stays as the developer reference above.
const zhCN: Catalog = {
	// shared chrome
	"chrome.app.title": "可观测性",

	// navigation
	"nav.overview": "概览",
	"nav.requests": "请求",
	"nav.errors": "错误",
	"nav.models": "模型",
	"nav.tools": "工具",
	"nav.costs": "成本",
	"nav.behavior": "行为",
	"nav.projects": "项目",
	"nav.gain": "节省",

	// layout
	"layout.drawer.aria": "导航菜单",
	"layout.drawer.close": "关闭导航菜单",
	"layout.logo.subtext": "可观测性",

	// top bar
	"topBar.menu.open": "打开导航菜单",
	"topBar.title.fallback": "可观测性",
	"topBar.lastUpdated.notUpdated": "尚未更新",
	"topBar.lastUpdated.prefix": "更新于 {time}",

	// range control
	"rangeControl.aria": "选择时间范围",
	"rangeControl.all": "全部",

	// theme toggle
	"themeToggle.system": "跟随系统",
	"themeToggle.light": "浅色",
	"themeToggle.dark": "深色",
	"themeToggle.cycleHint.aria": "（点击切换）",
	"themeToggle.cycleHint.title": "（点击切换）",

	// locale toggle — text describes clicking the button in the locale the UI
	// will switch *to* (the user reads in the language they're about to enter).
	"localeToggle.cycleHint.to-en": "切换语言为 English",
	"localeToggle.cycleHint.to-zh-CN": "切换语言为 中文",
	"localeToggle.label.en": "EN",
	"localeToggle.label.zh-CN": "中",

	// sync button
	"syncButton.idle": "同步数据库",
	"syncButton.syncing": "同步中...",
	"syncButton.success.singular": "同步完成：新增 {n} 条请求。",
	"syncButton.success.plural": "同步完成：新增 {n} 条请求。",
	"syncButton.error": "同步失败：{message}",

	// shared empty/error states
	"state.empty.default": "暂无数据",
	"state.error.title": "加载数据失败",
	"state.error.retry": "重试",
	"state.table.empty.default": "暂无数据",
	"state.asyncBoundary.empty.default": "暂无数据",

	// json block
	"jsonBlock.copy": "复制",
	"jsonBlock.copied": "已复制",
	"jsonBlock.copyAria": "复制 JSON 到剪贴板",
	"jsonBlock.copiedAria": "已复制到剪贴板",
	"jsonBlock.show": "▶ 展开",
	"jsonBlock.hide": "▼ 收起",
	"jsonBlock.title.default": "JSON",

	// request drawer
	"requestDrawer.title": "请求详情",
	"requestDrawer.id": "编号：{id}",
	"requestDrawer.closeAria": "关闭请求详情",
	"requestDrawer.dialogAria": "请求详情",
	"requestDrawer.status.error": "错误",
	"requestDrawer.status.success": "成功",
	"requestDrawer.errorMessage": "错误信息",
	"requestDrawer.errorTitle": "加载请求详情失败",
	"requestDrawer.json.output": "输出内容",
	"requestDrawer.json.raw": "原始请求元数据",
	"requestDrawer.tokenSub.inOut": "输入 {in} · 输出 {out}",

	// range metadata window labels
	"rangeMeta.1h.window": "过去 1 小时",
	"rangeMeta.24h.window": "过去 24 小时",
	"rangeMeta.7d.window": "过去 7 天",
	"rangeMeta.30d.window": "过去 30 天",
	"rangeMeta.90d.window": "过去 90 天",
	"rangeMeta.all.window": "全部时段",
	"rangeMeta.1h.trend": "1h 趋势",
	"rangeMeta.24h.trend": "24h 趋势",
	"rangeMeta.7d.trend": "7d 趋势",
	"rangeMeta.30d.trend": "30d 趋势",
	"rangeMeta.90d.trend": "90h 趋势",
	"rangeMeta.all.trend": "趋势",

	// agent token share
	"agentShare.main": "主 Agent",
	"agentShare.subagent": "子 Agent",
	"agentShare.advisor": "Advisor",
	"agentShare.empty": "当前范围内无 Token 使用",
	"agentShare.unit.req": "次",
	"agentShare.unit.tok": "tokens",

	// shared table column / status labels
	"table.column.model": "模型",
	"table.column.time": "时间",
	"table.column.tokens": "Tokens",
	"table.column.cost": "成本",
	"table.column.duration": "耗时",
	"table.column.status": "状态",
	"table.status.success": "成功",
	"table.status.failed": "失败",
	"table.column.requests": "请求数",

	// overview route
	"overview.tokenUsage.title": "按 Agent 划分的 Token 用量",
	"overview.tokenUsage.subtitle": "主 Agent、任务子 Agent 与 Advisor 的 Token 占比",
	"overview.throughput.title": "系统吞吐量",
	"overview.throughput.subtitle": "请求量与错误数随时段变化",
	"overview.throughput.empty": "暂无时序数据",
	"overview.legend.requests": "请求数",
	"overview.legend.errors": "错误数",
	"overview.feed.title": "运行日志",
	"overview.feed.subtitle": "实时请求日志",
	"overview.feed.empty": "暂无近期请求",
	"overview.preview.title": "近期请求预览",
	"overview.preview.subtitle": "代理最新处理的请求",
	"overview.preview.viewAll": "查看全部请求",

	// requests route
	"requests.title": "全部近期请求",
	"requests.subtitle": "OMP 最近处理的最多 50 条请求",
	"requests.empty": "暂无近期请求",
	"requests.mobile.cost": "成本",
	"requests.mobile.tokens": "Tokens",
	"requests.mobile.duration": "耗时",

	// errors route
	"errors.title": "近期错误",
	"errors.subtitle": "统计数据库内最近 50 条失败请求",
	"errors.empty": "本地统计数据库暂无失败记录",
	"errors.unknownError": "未知错误",
	"errors.column.errorMessage": "错误信息",
	"errors.mobile.cost": "成本",
	"errors.mobile.tokens": "Tokens",
	"errors.mobile.status.failed": "失败",

	// models route
	"models.share.title": "模型偏好",
	"models.share.subtitle": "{window} 内的请求占比",
	"models.share.empty": "暂无数据",
	"models.table.title": "模型统计",
	"models.table.column.model": "模型",
	"models.table.column.requests": "请求数",
	"models.table.column.cost": "成本",
	"models.table.column.tokens": "Tokens",
	"models.table.column.tps": "Tokens/s",
	"models.table.column.ttft": "TTFT",
	"models.expanded.quality": "质量",
	"models.expanded.errorRate": "错误率",
	"models.expanded.cacheRate": "缓存命中率",
	"models.expanded.latency": "延迟",
	"models.expanded.avgDuration": "平均耗时",
	"models.expanded.avgTtft": "平均 TTFT",
	"models.series.other": "其他",

	// tools route
	"tools.summary.title": "工具使用情况",
	"tools.summary.subtitle": "Tokens 与成本按调用轮次的真实用量拆分到各次工具调用",
	"tools.summary.calls": "工具调用次数",
	"tools.summary.tools": "工具种类数",
	"tools.summary.errorRate": "错误率",
	"tools.summary.attributedCost": "归属成本",
	"tools.summary.attributedTokens": "归属 Tokens",
	"tools.summary.attributedOutput": "归属输出 Tokens",
	"tools.summary.resultText": "结果文本",
	"tools.summary.callArgs": "调用参数",
	"tools.empty": "当前范围内暂无工具调用记录。",
	"tools.chart.title": "调用随时段分布",
	"tools.chart.subtitle": "{window} 内的工具调用，按工具堆叠",
	"tools.chart.empty": "暂无数据",
	"tools.table.title": "按工具",
	"tools.table.subtitle": "各工具的使用情况，按调用次数排序",
	"tools.table.column.tool": "工具",
	"tools.table.column.calls": "调用数",
	"tools.table.column.errorRate": "错误率",
	"tools.table.column.attributedTokens": "归属 Tokens",
	"tools.table.column.attributedCost": "归属成本",
	"tools.table.column.resultText": "结果文本",
	"tools.table.column.lastUsed": "最近使用",
	"tools.table.attrTokensTitle": "调用轮次的总 Tokens，按各次调用拆分",
	"tools.table.resultTextTitle": "回写到上下文的工具结果字符数",
	"tools.byModel.title": "按模型",
	"tools.byModel.subtitle": "查看模型调用的工具分布",
	"tools.byModel.toolLabel": "工具",
	"tools.byModel.allTools": "全部工具",

	// costs route
	"costs.card.totalCost": "总成本",
	"costs.card.avgPerDay": "日均成本",
	"costs.card.topModel": "花费最高的模型",
	"costs.card.totalSpentSuffix": "累计花费：{value}",
	"costs.trend.title": "每日成本",
	"costs.trend.subtitle": "API 支出随时段变化",
	"costs.trend.allModels": "全部模型",
	"costs.trend.byModel": "按模型",
	"costs.trend.empty": "暂无成本数据",
	"costs.trend.label": "成本",
	"costs.trend.totalFooter": "合计：{value}",
	"costs.trend.dataset.cost": "成本",

	// behavior route
	"behavior.summary.userMessages": "用户消息数",
	"behavior.summary.yelling": "大写喊叫",
	"behavior.summary.profanity": "脏话命中数",
	"behavior.summary.anguish": "痛苦类信号",
	"behavior.summary.friction": "摩擦信号数",
	"behavior.summary.highestFrictionModel": "摩擦最高的模型",
	"behavior.summary.subInRange": "当前范围内",
	"behavior.summary.subHits": "{n} 次命中",
	"behavior.metric.caps": "大写",
	"behavior.metric.capsTitle": "大写喊叫",
	"behavior.metric.profanity": "脏话",
	"behavior.metric.anguish": "痛苦",
	"behavior.metric.anguishTitle": "痛苦（!!!、nooo、ugh、dude、':('）",
	"behavior.metric.negation": "否定",
	"behavior.metric.negationTitle": "否定（no/nope/wrong、makes no sense）",
	"behavior.metric.repetition": "重复",
	"behavior.metric.repetitionTitle": "重复（i meant、still doesn't）",
	"behavior.metric.blame": "指责",
	"behavior.metric.blameTitle": "指责（you didn't、why did you、stop X-ing）",
	"behavior.metric.frustration": "挫败感",
	"behavior.metric.frustrationTitle": "挫败感（否定+重复+指责）",
	"behavior.metric.all": "全部",
	"behavior.metric.allTitle": "全部信号汇总",
	"behavior.byModel.toggle.allModels": "全部模型",
	"behavior.byModel.toggle.byModel": "按模型",
	"behavior.chart.title": "用户摩擦信号",
	"behavior.chart.subtitle": "{metric} 占每日用户消息的百分比",
	"behavior.chart.label": "命中数",
	"behavior.chart.empty": "暂无摩擦信号数据",
	"behavior.byModel.title": "按模型的行为信号",
	"behavior.byModel.subtitle": "比率为每条用户消息的口径",
	"behavior.byModel.column.model": "模型",
	"behavior.byModel.column.messages": "消息数",
	"behavior.byModel.column.capsPct": "大写占比",
	"behavior.byModel.column.profanityPct": "脏话占比",
	"behavior.byModel.column.anguishPct": "痛苦占比",
	"behavior.byModel.column.frustrationPct": "挫败占比",
	"behavior.byModel.column.hitsPct": "命中占比",
	"behavior.byModel.column.trend": "趋势",
	"behavior.byModel.rowAnguish": "痛苦（!!!、nooo、dude、..）",
	"behavior.byModel.rowRepetition": "重复（i meant、still doesn't）",
	"behavior.byModel.rowBlame": "指责（you didn't、stop X-ing）",
	"behavior.byModel.rowNegation": "否定（no/nope/wrong）",
	"behavior.byModel.rowAvgChars": "平均字符/消息",
	"behavior.byModel.label.total": "合计",
	"behavior.byModel.label.perMsgRate": "消息命中率",
	"behavior.byModel.label.perMsgAvg": "每条消息",
	"behavior.byModel.label.caps": "大写",
	"behavior.byModel.label.profanity": "脏话",
	"behavior.byModel.label.anguish": "痛苦",
	"behavior.byModel.label.frustration": "挫败",
	"behavior.byModel.label.seriesCaps": "大写",
	"behavior.byModel.label.seriesProfanity": "脏话",
	"behavior.byModel.label.seriesAnguish": "痛苦",
	"behavior.byModel.label.seriesFrustration": "挫败",
	"behavior.byModel.empty": "当前范围内尚无用户行为记录。",

	// projects route
	"projects.title": "项目与文件夹",
	"projects.subtitle": "按文件夹路径聚合的代理指标",
	"projects.empty": "当前范围内暂无项目文件夹记录。",
	"projects.column.folder": "项目 / 文件夹",
	"projects.column.requests": "请求数",
	"projects.column.cost": "成本",
	"projects.column.tokens": "Tokens",
	"projects.column.cacheRate": "缓存命中率",
	"projects.column.errorRate": "错误率",
	"projects.column.avgDuration": "平均耗时",
	"projects.mobile.cache": "缓存",
	"projects.mobile.duration": "耗时",
	"projects.mobile.err": "错误",
	"projects.folder.root": "（根目录）",

	// gain route
	"gain.project.label": "项目",
	"gain.project.allOption": "全部项目",
	"gain.overall.title": "整体节省",
	"gain.overall.subtitle": "Snapcompact 节省汇总",
	"gain.overall.savedTokens": "节省 Tokens",
	"gain.overall.savedBytes": "节省字节",
	"gain.overall.reduction": "压缩比",
	"gain.overall.totalHits": "总命中数",
	"gain.bySource.title": "按来源",
	"gain.bySource.subtitle": "各子系统的节省明细",
	"gain.bySource.snapcompact": "Snapcompact",
	"gain.bySource.hits": "命中数",
	"gain.chart.title": "随时段节省趋势",
	"gain.chart.subtitle": "每日 Token 节省",
	"gain.chart.label": "节省 Tokens",
	"gain.chart.empty": "暂无时序数据",
	"gain.chart.dataset.snapcompact": "Snapcompact",
};

const CATALOGS: Record<Locale, Catalog> = {
	en,
	"zh-CN": zhCN,
};

function lookup(key: string): CatalogLeaf | undefined {
	const active = CATALOGS[getLocale()] ?? CATALOGS[DEFAULT_LOCALE];
	return active[key] ?? CATALOGS[DEFAULT_LOCALE][key];
}

function interpolate(template: string, params?: Record<string, string | number>): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];
		return value === undefined || value === null ? match : String(value);
	});
}

/**
 * Localize a message by dotted key. Reads the current locale synchronously so
 * it can be invoked from event handlers, useMemo callbacks, and module-level
 * initialization. Components subscribe to locale changes via `useLocale()`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const leaf = lookup(key);
	return leaf === undefined ? key : interpolate(leaf, params);
}

/** Plural-aware lookup. `singularKey` is used when `n === 1`, otherwise `pluralKey`. */
export function tp(
	singularKey: string,
	pluralKey: string,
	n: number,
	params?: Record<string, string | number>,
): string {
	const leaf = lookup(n === 1 ? singularKey : pluralKey);
	if (leaf === undefined) return n === 1 ? singularKey : pluralKey;
	return interpolate(leaf, { n, ...(params ?? {}) });
}

export { CATALOGS, en, zhCN };
