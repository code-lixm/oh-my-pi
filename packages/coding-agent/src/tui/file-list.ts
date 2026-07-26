/**
 * Render file listings with optional icons and metadata.
 */
import type { Theme } from "../modes/theme/theme";
import { getLanguageFromPath } from "../modes/theme/theme";
import { renderTreeList } from "./tree-list";

export interface FileEntry {
	path: string;
	/** Absolute filesystem path. When provided together with {@link FileListOptions.hyperlinkFn}, the
	 * rendered path text is wrapped in an OSC 8 hyperlink. */
	absPath?: string;
	/** Optional one-based target line for filesystem hyperlinks. */
	line?: number;
	isDirectory?: boolean;
	meta?: string;
	/** Optional non-filesystem link wrapper, for entries such as internal URLs. */
	link?: (displayText: string) => string;
}

export interface FileListOptions {
	files: FileEntry[];
	expanded?: boolean;
	maxCollapsed?: number;
	maxCollapsedLines?: number;
	truncateFrom?: "start" | "end" | "middle";
	showIcons?: boolean;
	/** When provided, called with the entry's absolute path, ANSI-styled display string, and optional
	 * target line to wrap filesystem paths in an OSC 8 hyperlink. Only invoked when {@link FileEntry.absPath} is set. */
	hyperlinkFn?: (absPath: string, displayText: string, opts?: { line?: number }) => string;
}

export function renderFileList(options: FileListOptions, theme: Theme): string[] {
	const {
		files,
		expanded = false,
		maxCollapsed = 8,
		maxCollapsedLines,
		truncateFrom,
		showIcons = true,
		hyperlinkFn,
	} = options;

	return renderTreeList(
		{
			items: files,
			expanded,
			maxCollapsed,
			maxCollapsedLines,
			truncateFrom,
			itemType: "file",
			renderItem: entry => {
				const isDirectory = entry.isDirectory ?? entry.path.endsWith("/");
				const displayPath = isDirectory && entry.path.endsWith("/") ? entry.path : entry.path;
				const lang = isDirectory ? undefined : getLanguageFromPath(displayPath);
				const icon = !showIcons
					? ""
					: isDirectory
						? theme.fg("accent", theme.icon.folder)
						: theme.fg("muted", theme.getLangIcon(lang));
				const labelColor = isDirectory ? "accent" : "toolOutput";
				const meta = entry.meta ? ` ${theme.fg("dim", entry.meta)}` : "";
				const iconPrefix = icon ? `${icon} ` : "";
				const pathStr = theme.fg(labelColor, displayPath);
				const linkedPath = entry.link
					? entry.link(pathStr)
					: entry.absPath && hyperlinkFn
						? hyperlinkFn(entry.absPath, pathStr, { line: entry.line })
						: pathStr;
				return `${iconPrefix}${linkedPath}${meta}`;
			},
		},
		theme,
	);
}
