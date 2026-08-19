#!/usr/bin/env bun
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { OmpWebServer, type WebServerOptions } from "./app-server";

function argument(name: string): string | undefined {
	const equals = Bun.argv.find(value => value.startsWith(`${name}=`));
	if (equals) return equals.slice(name.length + 1);
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export async function startWebServer(overrides: Partial<WebServerOptions> = {}): Promise<OmpWebServer> {
	const rootDirectory = path.resolve(overrides.rootDirectory ?? argument("--cwd") ?? process.cwd());
	const commandPath = argument("--omp-command") ?? Bun.env.OMP_WEB_OMP_COMMAND;
	const executable =
		commandPath && (path.isAbsolute(commandPath) || /[\\/]/.test(commandPath))
			? path.resolve(commandPath)
			: commandPath;
	const options: WebServerOptions = {
		hostname: overrides.hostname ?? argument("--hostname") ?? "127.0.0.1",
		port: overrides.port ?? Number(argument("--port") ?? 4096),
		rootDirectory,
		staticDirectory: path.resolve(
			overrides.staticDirectory ?? argument("--static") ?? path.join(import.meta.dir, "..", "dist"),
		),
		databaseFile: path.resolve(
			overrides.databaseFile ?? argument("--db") ?? path.join(getAgentDir(), "web", "state.sqlite"),
		),
		username: overrides.username ?? argument("--username") ?? Bun.env.OMP_WEB_USERNAME,
		password: overrides.password ?? argument("--password") ?? Bun.env.OMP_WEB_PASSWORD,
		cliPath: overrides.cliPath ?? argument("--omp-cli") ?? Bun.env.OMP_WEB_CLI_PATH,
		command: overrides.command ?? (executable ? [executable] : undefined),
		sessionDir: overrides.sessionDir ?? argument("--session-dir") ?? Bun.env.OMP_WEB_SESSION_DIR,
	};
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
		throw new Error(`Invalid port: ${options.port}`);
	const app = await OmpWebServer.create(options);
	try {
		const server = app.start();
		console.log(`OMP Web listening at ${server.url}`);
		return app;
	} catch (error) {
		await app.stop();
		throw error;
	}
}

if (import.meta.main) {
	const app = await startWebServer();
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void app.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
