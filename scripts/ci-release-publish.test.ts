import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	inspectPackedTarball,
	isVersionAlreadyPublished,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
} from "./ci-release-publish.ts";

async function withTemporaryDirectory<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("release publish", () => {
	it("uses the packed manifest identity for an exact-version registry preflight", async () => {
		await withTemporaryDirectory("omp-release-publish-test-", async root => {
			const packageDir = path.join(root, "package");
			await fs.mkdir(packageDir);
			await Bun.write(
				path.join(packageDir, "package.json"),
				JSON.stringify({ name: "@oh-my-pi/pi-test", version: "1.2.3" }),
			);
			const tarball = path.join(root, "test.tgz");
			const rawTar = await new Bun.Archive({
				"package/package.json": JSON.stringify({ name: "@oh-my-pi/pi-test", version: "1.2.3" }),
			}).bytes();
			await Bun.write(tarball, Bun.gzipSync(rawTar));

			await expect(inspectPackedTarball(tarball)).resolves.toEqual({
				name: "@oh-my-pi/pi-test",
				version: "1.2.3",
				path: tarball,
			});
		});
	});

	it("recognizes npm's existing-version machine codes and registry-precheck prose", () => {
		expect(isVersionAlreadyPublished("npm error code E409\nnpm error Cannot publish over existing version")).toBe(
			true,
		);
		expect(isVersionAlreadyPublished("npm ERR! code E409")).toBe(true);
		expect(isVersionAlreadyPublished("npm error code EPUBLISHCONFLICT")).toBe(true);
		expect(isVersionAlreadyPublished("You cannot publish over the previously published versions: 1.2.3.")).toBe(true);
		expect(isVersionAlreadyPublished("cannot publish over the previously published version")).toBe(false);
	});

	it("ships every file required by the lazy desktop export in the native core", async () => {
		await withTemporaryDirectory("omp-native-core-publish-test-", async root => {
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-natives",
					version: "1.2.3",
					exports: {
						"./desktop": { types: "./native/desktop.d.ts", import: "./native/desktop.js" },
					},
				}),
			);

			const manifest = await prepareNativeCorePackage(root, false);
			expect(manifest.files).toEqual(expect.arrayContaining(["native/desktop.js", "native/desktop.d.ts"]));
		});
	});
});

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
		});
	});
});
