#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { resolveChannel } from "./utils";

const channel = resolveChannel();
const resources = path.resolve(import.meta.dir, "..", "resources");
const web = path.resolve(import.meta.dir, "..", "..", "web");
const sidecarName = process.platform === "win32" ? "omp-web-server.exe" : "omp-web-server";
const sidecar = path.join(resources, sidecarName);

await $`bun --cwd ${web} build`;
await $`bun ./scripts/copy-icons.ts ${channel}`;
await $`bun ./scripts/copy-metainfo.ts ${channel}`;
await $`bun build ${path.join(web, "server", "cli.ts")} --compile --outfile ${sidecar}`;
await fs.rm(path.join(resources, "web"), { recursive: true, force: true });
await fs.cp(path.join(web, "dist"), path.join(resources, "web"), { recursive: true });
