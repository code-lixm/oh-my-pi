import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileFinder, type FileFinderApi } from "@ff-labs/fff-bun";

/** Exercise the bundled FFF native library, index scan, path search, and content search. */
export async function smokeTestFff(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fff-smoke-"));
	let finder: FileFinderApi | undefined;
	try {
		await Bun.write(path.join(root, "smoke-needle.txt"), "omp fff smoke needle\n");
		const created = FileFinder.create({ basePath: root, aiMode: true, disableWatch: true });
		if (!created.ok) throw new Error(`FFF smoke create failed: ${created.error}`);
		finder = created.value;
		const ready = await finder.waitForScan(15_000);
		if (!ready.ok || !ready.value) throw new Error(`FFF smoke scan failed: ${ready.ok ? "timeout" : ready.error}`);
		const found = finder.fileSearch("smoke needle", { pageSize: 5 });
		if (!found.ok || !found.value.items.some(item => item.relativePath === "smoke-needle.txt")) {
			throw new Error(`FFF smoke find failed${found.ok ? "" : `: ${found.error}`}`);
		}
		const matched = finder.grep("fff smoke needle", { mode: "plain", pageSize: 5 });
		if (!matched.ok || !matched.value.items.some(item => item.relativePath === "smoke-needle.txt")) {
			throw new Error(`FFF smoke grep failed${matched.ok ? "" : `: ${matched.error}`}`);
		}
	} finally {
		finder?.destroy();
		await fs.rm(root, { recursive: true, force: true });
	}
}
