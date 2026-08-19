import appPlugin from "@oh-my-pi/pi-web/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "electron-vite";

import { resolveChannel } from "./scripts/utils";

const channel = resolveChannel();

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`;

const sentry =
	process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
		? sentryVitePlugin({
				authToken: process.env.SENTRY_AUTH_TOKEN,
				org: process.env.SENTRY_ORG,
				project: process.env.SENTRY_PROJECT,
				telemetry: false,
				release: {
					name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
				},
				sourcemaps: {
					assets: "./out/renderer/**",
					filesToDeleteAfterUpload: "./out/renderer/**/*.map",
				},
			})
		: false;

export default defineConfig({
	main: {
		define: {
			"import.meta.env.OMP_CHANNEL": JSON.stringify(channel),
		},
		build: {
			rollupOptions: {
				input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
				// Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
				// corrupt bundled TypeScript, while a Rollup banner places the shim safely.
				output: {
					banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
				},
			},
			externalizeDeps: { include: [nodePtyPkg] },
		},
		plugins: [
			{
				name: "omp:node-pty-narrower",
				enforce: "pre",
				resolveId(s) {
					if (s === "@lydell/node-pty") return nodePtyPkg;
				},
			},
		],
	},
	preload: {
		build: {
			rollupOptions: {
				input: { index: "src/preload/index.ts" },
				output: {
					format: "cjs",
					entryFileNames: "[name].js",
				},
			},
		},
	},
	renderer: {
		plugins: [appPlugin, sentry],
		publicDir: "../../../web/public",
		root: "src/renderer",
		resolve: {
			dedupe: [
				"solid-js",
				"@solidjs/router",
				"@opencode-ai/ui",
				"@dnd-kit/abstract",
				"@dnd-kit/dom",
				"@dnd-kit/solid",
			],
		},
		optimizeDeps: {
			exclude: [
				"@oh-my-pi/pi-web",
				"@opencode-ai/client",
				"@opencode-ai/core",
				"@opencode-ai/core/util/binary",
				"@opencode-ai/sdk",
				"@opencode-ai/session-ui",
				"@opencode-ai/ui",
			],
			include: ["lru_map"],
		},
		build: {
			sourcemap: true,
			rollupOptions: {
				input: {
					main: "src/renderer/index.html",
				},
			},
		},
	},
});
