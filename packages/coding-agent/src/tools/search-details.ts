import type { OutputMeta } from "./output-meta";

export interface FindToolDetails {
	meta?: OutputMeta;
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	cwd?: string;
	totalMatched?: number;
	pageIndex?: number;
	hasMore?: boolean;
	weak?: boolean;
}

export interface GrepToolDetails {
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	searchedPaths?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	fileLocations?: Array<{ path: string; lineNumbers: number[] }>;
	truncated?: boolean;
	error?: string;
	searchPath?: string;
	cwd?: string;
	perFileLimitReached?: number;
	cursor?: string;
	fuzzyFallback?: boolean;
	patterns?: string[];
}
