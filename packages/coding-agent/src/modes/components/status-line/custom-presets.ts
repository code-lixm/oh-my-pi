import type { StatusLineSegmentId, StatusLineSeparatorStyle } from "../../../config/settings-schema";
import { ALL_SEGMENT_IDS } from "./segments";
import type { PresetDef, StatusLineSegmentOptions } from "./types";

export interface CustomStatusLinePreset extends PresetDef {
	label: string;
	description?: string;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSegments(value: unknown): StatusLineSegmentId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const segments = value.filter(
		(segment): segment is StatusLineSegmentId =>
			typeof segment === "string" && ALL_SEGMENT_IDS.includes(segment as StatusLineSegmentId),
	);
	return segments.length === value.length ? segments : undefined;
}

function readBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readSegmentOptions(value: unknown): StatusLineSegmentOptions | undefined {
	if (!isRecord(value)) return undefined;
	const result: StatusLineSegmentOptions = {};
	const model = isRecord(value.model) ? value.model : undefined;
	if (model) result.model = { showThinkingLevel: readBool(model.showThinkingLevel) };
	const path = isRecord(value.path) ? value.path : undefined;
	if (path) {
		result.path = {
			abbreviate: readBool(path.abbreviate),
			basenameOnly: readBool(path.basenameOnly),
			maxLength: readNumber(path.maxLength),
			stripWorkPrefix: readBool(path.stripWorkPrefix),
		};
	}
	const usage = isRecord(value.usage) ? value.usage : undefined;
	if (usage) {
		const style = usage.style === "battery" || usage.style === "text" ? usage.style : undefined;
		const batteryStyle =
			usage.batteryStyle === "blocks" || usage.batteryStyle === "segmented" ? usage.batteryStyle : undefined;
		result.usage = {
			batteryWidth: readNumber(usage.batteryWidth),
			batteryStyle,
			latestOnly: readBool(usage.latestOnly),
			maxItems: readNumber(usage.maxItems),
			maxWidth: readNumber(usage.maxWidth),
			providers: Array.isArray(usage.providers)
				? usage.providers.filter((provider): provider is string => typeof provider === "string")
				: undefined,
			showLabel: readBool(usage.showLabel),
			showPercentage: readBool(usage.showPercentage),
			showResetTime: readBool(usage.showResetTime),
			showTrack: readBool(usage.showTrack),
			style,
		};
	}
	const git = isRecord(value.git) ? value.git : undefined;
	if (git) {
		result.git = {
			showBranch: readBool(git.showBranch),
			showStaged: readBool(git.showStaged),
			showUnstaged: readBool(git.showUnstaged),
			showUntracked: readBool(git.showUntracked),
		};
	}
	const time = isRecord(value.time) ? value.time : undefined;
	if (time) {
		result.time = {
			format: time.format === "12h" || time.format === "24h" ? time.format : undefined,
			showSeconds: readBool(time.showSeconds),
		};
	}
	return result;
}

export function readCustomStatusLinePresets(value: unknown): Record<string, CustomStatusLinePreset> {
	if (!isRecord(value)) return {};
	const result: Record<string, CustomStatusLinePreset> = {};
	for (const [id, raw] of Object.entries(value)) {
		if (!isRecord(raw)) continue;
		const leftSegments = readSegments(raw.leftSegments);
		const rightSegments = readSegments(raw.rightSegments);
		const separator = raw.separator;
		if (!leftSegments || !rightSegments) continue;
		if (
			separator !== "powerline" &&
			separator !== "powerline-thin" &&
			separator !== "slash" &&
			separator !== "pipe" &&
			separator !== "block" &&
			separator !== "none" &&
			separator !== "ascii"
		) {
			continue;
		}
		const label = readString(raw.label) ?? id;
		result[id] = {
			label,
			description: readString(raw.description),
			leftSegments,
			rightSegments,
			separator: separator as StatusLineSeparatorStyle,
			segmentOptions: readSegmentOptions(raw.segmentOptions),
			transparent: readBool(raw.transparent),
			compactThinkingLevel: readBool(raw.compactThinkingLevel),
		};
	}
	return result;
}
