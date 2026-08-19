export interface FffFileItem {
	relativePath: string;
}
export interface FffGrepItem {
	relativePath: string;
	lineNumber: number;
	col: number;
	lineContent: string;
	contextBefore: string[];
	contextAfter: string[];
}
export interface FffFinder {
	fileSearch(
		query: string,
		options: { pageSize: number },
	): { ok: true; value: { items: FffFileItem[] } } | { ok: false; error: string };
	grep(
		query: string,
		options: {
			mode: "regex" | "plain";
			smartCase: boolean;
			pageSize: number;
			beforeContext: number;
			afterContext: number;
			timeBudgetMs: number;
		},
	): { ok: true; value: { items: FffGrepItem[] } } | { ok: false; error: string };
}
export interface FffFinderManager {
	acquireWorkspace(cwd: string): Promise<{ finder: FffFinder }>;
	dispose(): void;
}
export function createFffFinderManager(agentDir: string, cwd: string): FffFinderManager;
