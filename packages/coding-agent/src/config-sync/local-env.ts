import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const UNQUOTED_VALUE_PATTERN = /^[A-Za-z0-9_./+=:@%-]*$/;

export async function upsertLocalEnvironment(agentDir: string, entries: ReadonlyMap<string, string>): Promise<void> {
	if (entries.size === 0) return;
	for (const [name, value] of entries) validateEnvironmentEntry(name, value);

	const filePath = path.join(agentDir, ".env");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await withFileLock(filePath, async () => {
		await assertRegularFileOrMissing(filePath);
		let original = "";
		try {
			original = await Bun.file(filePath).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const names = new Set(entries.keys());
		const retained = original.split(/\r?\n/).filter(line => {
			const name = parseAssignedName(line);
			return name === undefined || !names.has(name);
		});
		while (retained.length > 0 && retained.at(-1) === "") retained.pop();
		if (retained.length > 0) retained.push("");
		for (const [name, value] of entries) retained.push(`${name}=${serializeEnvironmentValue(value)}`);
		const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tempPath, `${retained.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await assertRegularFileOrMissing(filePath);
			await fs.rename(tempPath, filePath);
			await fs.chmod(filePath, 0o600).catch(() => undefined);
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
	});
	for (const [name, value] of entries) process.env[name] = value;
}

function validateEnvironmentEntry(name: string, value: string): void {
	if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
	if (value.length === 0) throw new Error(`Environment variable ${name} must not be empty`);
	if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
		throw new Error(`Environment variable ${name} contains unsupported control characters`);
	}
}

function parseAssignedName(line: string): string | undefined {
	return /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
}

function serializeEnvironmentValue(value: string): string {
	if (UNQUOTED_VALUE_PATTERN.test(value)) return value;
	if (!value.includes("'")) return `'${value}'`;
	if (!value.includes('"')) return `"${value}"`;
	if (!value.includes("`")) return `\`${value}\``;
	throw new Error("Environment value cannot be represented safely in .env");
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to update symlinked environment file: ${filePath}`);
		if (!stat.isFile()) throw new Error(`Environment path is not a regular file: ${filePath}`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
