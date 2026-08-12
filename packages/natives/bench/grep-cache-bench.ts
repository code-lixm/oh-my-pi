/**
 * Grep walker cache effect benchmark: measures cold (cache miss) vs hot
 * (cache hit) repeated grep on the same path, with p50/p90/p99 latency.
 *
 * Usage:
 *   bun packages/natives/bench/grep-cache-bench.ts
 *   GREP_CACHE_BENCH_ITERATIONS=100 bun packages/natives/bench/grep-cache-bench.ts
 */
import * as path from "node:path";
import { GrepOutputMode, grep, invalidateFsScanCache } from "../native/index.js";

const ITERATIONS = Number(Bun.env.GREP_CACHE_BENCH_ITERATIONS ?? "40");
const WARMUP = 5;
const repoRoot = path.resolve(import.meta.dir, "../../..");

interface CacheCase {
	name: string;
	searchPath: string;
	pattern: string;
	glob?: string;
	mode?: GrepOutputMode;
	gitignore?: boolean;
}

const cases: CacheCase[] = [
	{
		name: "coding-agent/src filesWithMatches (gitignore)",
		searchPath: path.resolve(repoRoot, "packages/coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		mode: GrepOutputMode.FilesWithMatches,
		gitignore: true,
	},
	{
		name: "tui/src content (no gitignore)",
		searchPath: path.resolve(repoRoot, "packages/tui/src"),
		pattern: "export",
		glob: "*.ts",
		mode: GrepOutputMode.Content,
		gitignore: false,
	},
	{
		name: "coding-agent/src count (gitignore)",
		searchPath: path.resolve(repoRoot, "packages/coding-agent/src"),
		pattern: "function",
		glob: "*.ts",
		mode: GrepOutputMode.Count,
		gitignore: true,
	},
];

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx]!;
}

function stats(samples: number[]): { p50: number; p90: number; p99: number; mean: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	return {
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		p99: percentile(sorted, 99),
		mean: sum / sorted.length,
	};
}

console.log(`Grep cache benchmark: ${ITERATIONS} iterations, ${WARMUP} warmup\n`);

for (const c of cases) {
	const args = {
		pattern: c.pattern,
		path: c.searchPath,
		glob: c.glob,
		mode: c.mode,
		gitignore: c.gitignore ?? false,
	};

	// Warmup (also fills any global state)
	for (let i = 0; i < WARMUP; i++) {
		await grep(args);
	}

	// Cold path: invalidate cache before each call
	const coldSamples: number[] = [];
	for (let i = 0; i < ITERATIONS; i++) {
		invalidateFsScanCache();
		const start = Bun.nanoseconds();
		await grep(args);
		coldSamples.push((Bun.nanoseconds() - start) / 1e6);
	}

	// Hot path: cache is warm from the previous call (TTL 1s)
	const hotSamples: number[] = [];
	await grep(args); // prime cache
	for (let i = 0; i < ITERATIONS; i++) {
		const start = Bun.nanoseconds();
		await grep(args);
		hotSamples.push((Bun.nanoseconds() - start) / 1e6);
	}

	const cold = stats(coldSamples);
	const hot = stats(hotSamples);
	const speedup = cold.p50 / hot.p50;

	const result = await grep(args);
	const matchCount = c.mode === GrepOutputMode.FilesWithMatches ? result.filesWithMatches : result.totalMatches;

	console.log(`${c.name}:`);
	console.log(`  Results: ${matchCount} ${c.mode === GrepOutputMode.FilesWithMatches ? "files" : "matches"}`);
	console.log(
		`  Cold (cache miss):  p50=${cold.p50.toFixed(2)}ms  p90=${cold.p90.toFixed(2)}ms  p99=${cold.p99.toFixed(2)}ms  mean=${cold.mean.toFixed(2)}ms`,
	);
	console.log(
		`  Hot  (cache hit):   p50=${hot.p50.toFixed(2)}ms  p90=${hot.p90.toFixed(2)}ms  p99=${hot.p99.toFixed(2)}ms  mean=${hot.mean.toFixed(2)}ms`,
	);
	console.log(`  => Cache speedup: ${speedup.toFixed(1)}x (p50)\n`);
}
