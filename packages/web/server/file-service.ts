import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createFffFinderManager, type FffFinderManager } from "@oh-my-pi/pi-coding-agent/tools/fff-manager";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export class ProjectFileService {
	readonly root: string;
	readonly #managers = new Map<string, FffFinderManager>();

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	dispose(): void {
		for (const manager of this.#managers.values()) manager.dispose();
		this.#managers.clear();
	}

	resolve(root: string, value?: string): string {
		const base = path.resolve(root);
		const target = value ? (path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value)) : base;
		const relative = path.relative(base, target);
		if (relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error(`Path outside project root: ${value}`);
		return target;
	}

	async list(root: string, value?: string) {
		const base = path.resolve(root);
		const directory = this.resolve(base, value);
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries
			.map(entry => ({
				name: entry.name,
				path: path.relative(base, path.join(directory, entry.name)),
				absolute: path.join(directory, entry.name),
				type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
				ignored: false,
			}))
			.sort(
				(left, right) =>
					Number(right.type === "directory") - Number(left.type === "directory") ||
					left.name.localeCompare(right.name),
			);
	}

	async read(root: string, value: string) {
		const file = this.resolve(root, value);
		const stat = await fs.stat(file);
		if (!stat.isFile()) throw new Error(`Not a file: ${value}`);
		if (stat.size > 10 * 1024 * 1024) throw new Error(`File exceeds 10 MiB: ${value}`);
		const bytes = await fs.readFile(file);
		const binary = bytes.includes(0);
		return binary
			? { type: "binary" as const, content: bytes.toString("base64"), encoding: "base64" as const }
			: { type: "text" as const, content: bytes.toString("utf8") };
	}

	async find(root: string, query: string, limit = 100, type?: "file" | "directory"): Promise<string[]> {
		const { finder } = await this.#manager(root).acquireWorkspace(path.resolve(root));
		const pageSize =
			type === "directory" ? Math.max(100, Math.min(limit * 10, 1000)) : Math.max(1, Math.min(limit, 1000));
		const result = finder.fileSearch(query, { pageSize });
		if (!result.ok) throw new Error(result.error);
		if (type !== "directory") return result.value.items.map(item => item.relativePath);
		const directories = new Set<string>();
		for (const item of result.value.items) {
			let directory = path.dirname(item.relativePath);
			while (directory !== "." && !directories.has(directory)) {
				directories.add(directory);
				directory = path.dirname(directory);
			}
		}
		return Array.from(directories).slice(0, limit);
	}

	async grep(
		root: string,
		query: string,
		options: { regex?: boolean; limit?: number; before?: number; after?: number } = {},
	) {
		const { finder } = await this.#manager(root).acquireWorkspace(path.resolve(root));
		const result = finder.grep(query, {
			mode: options.regex ? "regex" : "plain",
			smartCase: true,
			pageSize: Math.max(1, Math.min(options.limit ?? 100, 1000)),
			beforeContext: Math.max(0, Math.min(options.before ?? 0, 20)),
			afterContext: Math.max(0, Math.min(options.after ?? 0, 20)),
			timeBudgetMs: 10_000,
		});
		if (!result.ok) throw new Error(result.error);
		return result.value.items.map(item => ({
			path: item.relativePath,
			line: item.lineNumber,
			column: item.col,
			text: item.lineContent,
			contextBefore: item.contextBefore,
			contextAfter: item.contextAfter,
		}));
	}

	#manager(root: string): FffFinderManager {
		const key = path.resolve(root);
		const existing = this.#managers.get(key);
		if (existing) return existing;
		const manager = createFffFinderManager(getAgentDir(), key);
		this.#managers.set(key, manager);
		return manager;
	}
}
