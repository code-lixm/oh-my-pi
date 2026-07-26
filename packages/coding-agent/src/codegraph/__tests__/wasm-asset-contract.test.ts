import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface SmokePayload {
	hasGreet: boolean;
	hasContains: boolean;
	hasNodesTable: boolean;
	hasFilesTable: boolean;
	nodeKinds: string[];
	edgeKinds: string[];
}

setDefaultTimeout(30_000);

describe("codegraph WASM distribution contract", () => {
	let tmp: string;
	let entryPath: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-wasm-dist-"));
		entryPath = path.join(tmp, "codegraph-wasm-smoke.ts");
		const extractionModulePath = path.resolve(import.meta.dir, "../extraction.ts");
		const dbModulePath = path.resolve(import.meta.dir, "../db/index.ts");
		await fs.writeFile(
			entryPath,
			[
				`import * as fs from "node:fs/promises";`,
				`import * as os from "node:os";`,
				`import * as path from "node:path";`,
				`import { extractFile } from ${JSON.stringify(extractionModulePath)};`,
				`import { DatabaseConnection } from ${JSON.stringify(dbModulePath)};`,
				`const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-wasm-source-"));`,
				`const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cg-wasm-db-"));`,
				`const relPath = "sample.ts";`,
				`await fs.writeFile(path.join(sourceRoot, relPath), [`,
				`  "export function greet(name: string): string {",`,
				`  "  return name.toUpperCase();",`,
				`  "}",`,
				`].join("\\n"), "utf8");`,
				`const extracted = await extractFile(sourceRoot, relPath);`,
				`const fileNode = extracted.nodes.find(node => node.kind === "file" && node.filePath === relPath);`,
				`const greetNode = extracted.nodes.find(node => node.name === "greet");`,
				`const hasContains = extracted.edges.some(edge => edge.kind === "contains" && edge.source === fileNode?.id && edge.target === greetNode?.id);`,
				`const dbPath = path.join(dbRoot, "codegraph.db");`,
				`const conn = DatabaseConnection.open(dbPath);`,
				`const hasNodesTable = Boolean(conn.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get());`,
				`const hasFilesTable = Boolean(conn.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'").get());`,
				`conn.close();`,
				`console.log(JSON.stringify({`,
				`  hasGreet: Boolean(greetNode),`,
				`  hasContains,`,
				`  hasNodesTable,`,
				`  hasFilesTable,`,
				`  nodeKinds: extracted.nodes.map(node => node.kind),`,
				`  edgeKinds: extracted.edges.map(edge => edge.kind),`,
				`}));`,
				`await fs.rm(sourceRoot, { recursive: true, force: true });`,
				`await fs.rm(dbRoot, { recursive: true, force: true });`,
			].join("\n"),
			"utf8",
		);
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	function assertSmoke(payload: SmokePayload): void {
		expect(payload.hasGreet).toBe(true);
		expect(payload.hasContains).toBe(true);
		expect(payload.hasNodesTable).toBe(true);
		expect(payload.hasFilesTable).toBe(true);
		expect(payload.nodeKinds).toContain("function");
		expect(payload.edgeKinds).toContain("contains");
	}

	async function runProgram(command: string[], cwd: string): Promise<SmokePayload> {
		const proc = Bun.spawn(command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CODEGRAPH_KERNEL: "0" },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout) as SmokePayload;
	}

	test("source entry executes real WASM fallback extraction and schema initialization", async () => {
		const payload = await runProgram([process.execPath, entryPath], tmp);
		assertSmoke(payload);
	});

	test("Bun.build outdir bundle executes real WASM fallback extraction and schema initialization", async () => {
		const outdir = path.join(tmp, "dist");
		const buildResult = await Bun.build({
			entrypoints: [entryPath],
			outdir,
			format: "esm",
			target: "bun",
		});
		const buildLogs = buildResult.logs.map(log => log.message).join("\n");
		expect(buildResult.success, buildLogs).toBe(true);
		const output = buildResult.outputs.find(file => file.path.endsWith(".js"));
		expect(output).toBeDefined();
		const payload = await runProgram([process.execPath, output!.path], tmp);
		assertSmoke(payload);
	});

	test("compiled binary executes real WASM fallback extraction and schema initialization", async () => {
		const binaryPath = path.join(tmp, process.platform === "win32" ? "codegraph-smoke.exe" : "codegraph-smoke");
		const compileProc = Bun.spawn([process.execPath, "build", entryPath, "--compile", "--outfile", binaryPath], {
			cwd: tmp,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [compileStdout, compileStderr, compileExit] = await Promise.all([
			new Response(compileProc.stdout).text(),
			new Response(compileProc.stderr).text(),
			compileProc.exited,
		]);
		expect(compileExit, `${compileStdout}\n${compileStderr}`).toBe(0);
		const payload = await runProgram([binaryPath], tmp);
		assertSmoke(payload);
	});
});
