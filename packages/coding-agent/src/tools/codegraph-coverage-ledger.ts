import { canonicalSnapshotKey } from "../edit/file-snapshot-store";

/** Completeness of source evidence made available during semantic exploration. */
export type CodeGraphCoverageCompleteness = "complete" | "partial" | "omitted";

export interface CodeGraphCoverageRange {
	startLine: number;
	endLine: number;
	completeness: CodeGraphCoverageCompleteness;
}

export interface CodeGraphCoverageSymbol {
	name: string;
	completeness: CodeGraphCoverageCompleteness;
}

export interface CodeGraphCoverageFile {
	path: string;
	completeness: CodeGraphCoverageCompleteness;
	symbols: CodeGraphCoverageSymbol[];
	ranges: CodeGraphCoverageRange[];
	lastSeenTurn: number;
}

/** Minimal session-scoped evidence ledger consumed as soft guidance only. */
export interface CodeGraphCoverageLedgerSnapshot {
	turn: number;
	files: CodeGraphCoverageFile[];
}

export interface CodeGraphCoverageRecord {
	absolutePath: string;
	displayPath: string;
	completeness: CodeGraphCoverageCompleteness;
	symbol?: string;
	startLine?: number;
	endLine?: number;
}

interface MutableCoverageFile {
	path: string;
	completeness: CodeGraphCoverageCompleteness;
	symbols: Map<string, CodeGraphCoverageCompleteness>;
	ranges: Map<string, CodeGraphCoverageRange>;
	lastSeenTurn: number;
}

export interface CodeGraphCoverageLedgerOwner {
	codeGraphCoverageLedger?: CodeGraphCoverageLedger;
}

function mergeCompleteness(
	previous: CodeGraphCoverageCompleteness,
	next: CodeGraphCoverageCompleteness,
): CodeGraphCoverageCompleteness {
	if (previous === "partial" || next === "partial") return "partial";
	if (previous === "omitted" && next === "omitted") return "omitted";
	if (previous === "complete" && next === "complete") return "complete";
	return "partial";
}

/**
 * Tracks the current session's model-visible semantic source coverage. Each
 * `beginTurn` gives records a monotonic turn marker; the ledger remains a soft
 * hint and never controls whether ordinary filesystem tools may run.
 */
export class CodeGraphCoverageLedger {
	#turn = 0;
	#files = new Map<string, MutableCoverageFile>();

	beginTurn(): number {
		this.#turn++;
		return this.#turn;
	}

	record(records: readonly CodeGraphCoverageRecord[]): void {
		for (const record of records) {
			const key = canonicalSnapshotKey(record.absolutePath);
			let file = this.#files.get(key);
			if (!file) {
				file = {
					path: record.displayPath,
					completeness: record.completeness,
					symbols: new Map(),
					ranges: new Map(),
					lastSeenTurn: this.#turn,
				};
				this.#files.set(key, file);
			} else {
				file.path = record.displayPath;
				file.completeness = mergeCompleteness(file.completeness, record.completeness);
				file.lastSeenTurn = this.#turn;
			}
			if (record.symbol) {
				const previous = file.symbols.get(record.symbol);
				file.symbols.set(
					record.symbol,
					previous ? mergeCompleteness(previous, record.completeness) : record.completeness,
				);
			}
			if (record.startLine !== undefined && record.endLine !== undefined) {
				const startLine = Math.min(record.startLine, record.endLine);
				const endLine = Math.max(record.startLine, record.endLine);
				const rangeKey = `${startLine}:${endLine}`;
				const previous = file.ranges.get(rangeKey);
				file.ranges.set(rangeKey, {
					startLine,
					endLine,
					completeness: previous
						? mergeCompleteness(previous.completeness, record.completeness)
						: record.completeness,
				});
			}
		}
	}

	invalidate(absolutePath: string): void {
		this.#files.delete(canonicalSnapshotKey(absolutePath));
	}

	snapshot(): CodeGraphCoverageLedgerSnapshot {
		return {
			turn: this.#turn,
			files: [...this.#files.values()].map(file => ({
				path: file.path,
				completeness: file.completeness,
				symbols: [...file.symbols.entries()].map(([name, completeness]) => ({ name, completeness })),
				ranges: [...file.ranges.values()],
				lastSeenTurn: file.lastSeenTurn,
			})),
		};
	}
}

/** Retrieve the lazily-owned ledger without coupling it to a concrete session class. */
export function getCodeGraphCoverageLedger(owner: CodeGraphCoverageLedgerOwner): CodeGraphCoverageLedger {
	if (!owner.codeGraphCoverageLedger) owner.codeGraphCoverageLedger = new CodeGraphCoverageLedger();
	return owner.codeGraphCoverageLedger;
}

/** Drop stale source evidence after a persisted source-file mutation. */
export function invalidateCodeGraphCoverage(
	owner: CodeGraphCoverageLedgerOwner,
	absolutePaths: readonly (string | undefined)[],
): void {
	if (!owner.codeGraphCoverageLedger) return;
	for (const absolutePath of absolutePaths) {
		if (absolutePath) owner.codeGraphCoverageLedger.invalidate(absolutePath);
	}
}
