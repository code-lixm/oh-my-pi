import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pythonBackend from "../../../src/eval/py/index";
import type { ToolSession } from "../../../src/tools";

const hostPython = Bun.env.PYTHON ?? Bun.which("python3") ?? Bun.which("python");

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("Python skill interpreter integration", () => {
	it.skipIf(process.platform === "win32" || hostPython === undefined)(
		"awaits skill options and runs the kernel through the selected venv interpreter before the configured fallback",
		async () => {
			if (!hostPython) throw new Error("Expected a Python interpreter for the integration fixture");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "py-skill-interpreter-"));
			try {
				const venvPath = path.join(root, "skill-venv");
				const binPath = path.join(venvPath, "bin");
				const selectedPython = path.join(binPath, "python");
				await fs.mkdir(binPath, { recursive: true });
				await fs.writeFile(path.join(venvPath, "pyvenv.cfg"), "home = fixture\n");
				await fs.writeFile(
					selectedPython,
					[
						"#!/bin/sh",
						"export OMP_PYTHON_SKILL_TEST_INTERPRETER=selected-skill-venv",
						`exec ${shellQuote(hostPython)} "$@"`,
						"",
					].join("\n"),
				);
				await fs.chmod(selectedPython, 0o755);

				const session = {
					cwd: root,
					hasUI: false,
					getSessionFile: () => null,
					getArtifactsDir: () => null,
					settings: {
						get(key: string) {
							if (key === "python.kernelMode") return "per-call";
							if (key === "python.interpreter") return hostPython;
							return undefined;
						},
					},
					pythonSkills: Promise.resolve({ pythonPath: selectedPython, metadata: [] }),
				} as unknown as ToolSession;

				const result = await pythonBackend.execute(
					'import os\nprint("skill interpreter marker:", os.environ.get("OMP_PYTHON_SKILL_TEST_INTERPRETER"))',
					{
						cwd: root,
						sessionId: "python-skill-interpreter-priority",
						sessionFile: "",
						kernelOwnerId: "python-skill-interpreter-priority",
						reset: false,
						onChunk: () => {},
						session,
					},
				);

				expect(result.cancelled).toBe(false);
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("skill interpreter marker: selected-skill-venv");
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
