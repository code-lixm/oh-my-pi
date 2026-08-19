export interface GitPatchLine {
	startsWith(search: string): boolean;
}
export function diff(cwd: string): Promise<string>;
export function show(cwd: string, revision: string): Promise<string>;
export const branch: { current(cwd: string): Promise<string | null> };
