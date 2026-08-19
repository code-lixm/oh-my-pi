import { FileTree as PierreFileTree } from "@pierre/trees-base";
import type { FileTreeOptions as PierreFileTreeOptions } from "@pierre/trees-base";

export type { FileTreeDirectoryHandle } from "@pierre/trees-base";

export interface FileTreeExpansionChange {
	path: string;
	expanded: boolean;
}

export type FileTreeOptions = PierreFileTreeOptions & {
	onExpansionChange?: (change: FileTreeExpansionChange) => void;
};

export class FileTree extends PierreFileTree {
	readonly #onExpansionChange: FileTreeOptions["onExpansionChange"];
	readonly #expanded = new Map<string, boolean>();
	#unsubscribe?: () => void;

	constructor(options: FileTreeOptions) {
		const { onExpansionChange, ...treeOptions } = options;
		super(treeOptions);
		this.#onExpansionChange = onExpansionChange;
		if (onExpansionChange) this.#unsubscribe = this.subscribe(() => this.#emitExpansionChanges());
	}

	override cleanUp(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		super.cleanUp();
	}

	#emitExpansionChanges(): void {
		const rows = this.getVisibleRows(0, this.getVisibleCount());
		for (const row of rows) {
			if (row.kind !== "directory") continue;
			const previous = this.#expanded.get(row.path);
			this.#expanded.set(row.path, row.isExpanded);
			if (previous === row.isExpanded || (previous === undefined && !row.isExpanded)) continue;
			this.#onExpansionChange?.({ path: row.path, expanded: row.isExpanded });
		}
	}
}
