import * as path from "node:path";

export function normalizeFffPathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
	let trimmed = pathConstraint.trim();
	if (!trimmed) return trimmed;
	if (path.isAbsolute(trimmed)) {
		const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
		if (!relative) return null;
		if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
			throw new Error(`Path constraint must be relative to the indexed root: ${pathConstraint}`);
		}
		trimmed = relative;
	}
	if (trimmed === "." || trimmed === "./") return null;
	if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);
	if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return null;
	const recursiveDirectory = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
	if (recursiveDirectory) {
		const directory = recursiveDirectory[1];
		if (directory && !/[*?[{]/.test(directory)) return `${directory}/`;
	}
	if (trimmed.startsWith("/") || trimmed.endsWith("/") || /[*?[{]/.test(trimmed)) return trimmed;
	const lastSegment = trimmed.split("/").pop() ?? "";
	if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
	return `${trimmed}/`;
}

export function normalizeFffExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
	if (!exclude) return [];
	const list = Array.isArray(exclude) ? exclude : [exclude];
	const output: string[] = [];
	for (const raw of list) {
		for (const token of raw
			.split(/[,\s]+/)
			.map(value => value.trim())
			.filter(Boolean)) {
			const normalized = normalizeFffPathConstraint(token.startsWith("!") ? token.slice(1) : token, cwd);
			if (normalized) output.push(`!${normalized}`);
		}
	}
	return output;
}

export function buildFffQuery(
	pathConstraint: string | undefined,
	pattern: string,
	exclude?: string | string[],
	cwd = process.cwd(),
): string {
	const parts: string[] = [];
	if (pathConstraint) {
		const normalized = normalizeFffPathConstraint(pathConstraint, cwd);
		if (normalized) parts.push(normalized);
	}
	parts.push(...normalizeFffExcludes(exclude, cwd));
	parts.push(pattern);
	return parts.join(" ");
}
