import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const linkScript = path.resolve(import.meta.dir, "link-omp.sh");
const launcherScript = path.resolve(import.meta.dir, "omp-launcher.sh");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-"));
	tempDirs.push(dir);
	return dir;
}

function makeTempRepoLayout(parentDir: string) {
	const repoRoot = path.join(parentDir, "repo");
	const caDir = path.join(repoRoot, "packages", "coding-agent");
	const distDir = path.join(caDir, "dist");
	fs.mkdirSync(distDir, { recursive: true });
	return { repoRoot, distDir, caDir };
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeRecordingDistOmp(distDir: string, recordDir: string) {
	const fakeOmp = path.join(distDir, "omp");
	const envFile = path.join(recordDir, "pi-package-dir.txt");
	const argsFile = path.join(recordDir, "argv.txt");
	const markerFile = path.join(recordDir, "ran.txt");

	fs.mkdirSync(recordDir, { recursive: true });
	fs.writeFileSync(
		fakeOmp,
		[
			"#!/bin/sh",
			`printf '%s' "\${PI_PACKAGE_DIR-}" > ${shellQuote(envFile)}`,
			`printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
			`printf 'dist/omp invoked\\n' > ${shellQuote(markerFile)}`,
			"printf 'dist-omp-ran\\n'",
			"",
		].join("\n"),
	);
	fs.chmodSync(fakeOmp, 0o755);

	return { fakeOmp, envFile, argsFile, markerFile };
}

function writeBunShim(dir: string, body: string) {
	const shimDir = path.join(dir, "shim");
	fs.mkdirSync(shimDir, { recursive: true });
	const shim = path.join(shimDir, "bun");
	fs.writeFileSync(shim, `#!/bin/sh\n${body}`);
	fs.chmodSync(shim, 0o755);
	return shimDir;
}

function writeProjectScripts(repoRoot: string) {
	const scriptsDir = path.join(repoRoot, "scripts");
	const linkDest = path.join(scriptsDir, "link-omp.sh");
	const launcherDest = path.join(scriptsDir, "omp-launcher.sh");

	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.copyFileSync(linkScript, linkDest);
	fs.copyFileSync(launcherScript, launcherDest);
	fs.chmodSync(linkDest, 0o755);
	fs.chmodSync(launcherDest, 0o755);

	return { linkDest, launcherDest };
}

function runLinkScript(scriptPath: string, env: NodeJS.ProcessEnv, repoRoot: string) {
	return spawnSync("sh", [scriptPath], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
	});
}

function runInstalledOmp(installedPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
	return spawnSync(installedPath, args, {
		cwd,
		env,
		encoding: "utf8",
	});
}

function expectInstalledOmpContract(
	installedPath: string,
	expectedLauncherPath: string,
	repoRoot: string,
	env: NodeJS.ProcessEnv,
	args: string[],
	records: { argsFile: string; envFile: string; markerFile: string },
	workingDir: string,
) {
	expect(fs.existsSync(installedPath)).toBe(true);
	expect(fs.lstatSync(installedPath).isSymbolicLink()).toBe(true);
	expect(fs.realpathSync(installedPath)).toBe(fs.realpathSync(expectedLauncherPath));

	const result = runInstalledOmp(installedPath, args, env, workingDir);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toBe("dist-omp-ran\n");
	expect(fs.readFileSync(records.markerFile, "utf8")).toBe("dist/omp invoked\n");
	expect(fs.readFileSync(records.envFile, "utf8")).toBe(
		fs.realpathSync(path.join(repoRoot, "packages", "coding-agent")),
	);
	expect(fs.readFileSync(records.argsFile, "utf8")).toBe(`${args.join("\n")}\n`);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("scripts/link-omp.sh", () => {
	it("symlinks Bun's global omp to scripts/omp-launcher.sh, which runs dist/omp with absolute PI_PACKAGE_DIR and argv intact", () => {
		const dir = makeTempDir();
		const { repoRoot, distDir } = makeTempRepoLayout(dir);
		const records = writeRecordingDistOmp(distDir, path.join(dir, "records-primary"));
		const { linkDest, launcherDest } = writeProjectScripts(repoRoot);
		const globalBin = path.join(dir, "global-bin");
		const outsideCwd = path.join(dir, "outside-cwd");
		fs.mkdirSync(outsideCwd, { recursive: true });

		const shimDir = writeBunShim(
			dir,
			[
				'if [ "$1" = "pm" ] && [ "$2" = "-g" ] && [ "$3" = "bin" ]; then',
				`  echo '${globalBin}'`,
				"  exit 0",
				"fi",
				"exit 99",
				"",
			].join("\n"),
		);
		const env = {
			...process.env,
			LANG: "C.UTF-8",
			HOME: path.join(dir, "home"),
			PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			PI_PACKAGE_DIR: "",
		};

		const result = runLinkScript(linkDest, env, repoRoot);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expectInstalledOmpContract(
			path.join(globalBin, "omp"),
			launcherDest,
			repoRoot,
			env,
			["alpha", "two words", "--flag=value"],
			records,
			outsideCwd,
		);
	});

	it("falls back to BUN_INSTALL/bin and installs the same omp-launcher symlink contract there", () => {
		const dir = makeTempDir();
		const { repoRoot, distDir } = makeTempRepoLayout(dir);
		const records = writeRecordingDistOmp(distDir, path.join(dir, "records-fallback"));
		const { linkDest, launcherDest } = writeProjectScripts(repoRoot);
		const bunInstall = path.join(dir, "bun-install");
		const outsideCwd = path.join(dir, "outside-cwd-fallback");
		fs.mkdirSync(outsideCwd, { recursive: true });

		const shimDir = writeBunShim(
			dir,
			[
				'if [ "$1" = "pm" ] && [ "$2" = "-g" ] && [ "$3" = "bin" ]; then',
				"  echo 'error: No package.json was found for directory' >&2",
				"  exit 1",
				"fi",
				"exit 99",
				"",
			].join("\n"),
		);
		const env = {
			...process.env,
			LANG: "C.UTF-8",
			HOME: path.join(dir, "home"),
			BUN_INSTALL: bunInstall,
			PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			PI_PACKAGE_DIR: "",
		};

		const result = runLinkScript(linkDest, env, repoRoot);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expectInstalledOmpContract(
			path.join(bunInstall, "bin", "omp"),
			launcherDest,
			repoRoot,
			env,
			["--json", "fallback path"],
			records,
			outsideCwd,
		);
	});

	it("exits non-zero and creates no launcher when dist/omp does not exist", () => {
		const dir = makeTempDir();
		const { repoRoot } = makeTempRepoLayout(dir);
		const { linkDest } = writeProjectScripts(repoRoot);
		const globalBin = path.join(dir, "global-bin");
		const shimDir = writeBunShim(
			dir,
			[
				'if [ "$1" = "pm" ] && [ "$2" = "-g" ] && [ "$3" = "bin" ]; then',
				`  echo '${globalBin}'`,
				"  exit 0",
				"fi",
				"exit 99",
				"",
			].join("\n"),
		);

		const result = runLinkScript(
			linkDest,
			{
				...process.env,
				LANG: "C.UTF-8",
				HOME: path.join(dir, "home"),
				PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			repoRoot,
		);

		expect(result.status).not.toBe(0);
		expect(fs.existsSync(path.join(globalBin, "omp"))).toBe(false);
	});
});
