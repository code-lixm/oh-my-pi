import * as fs from "node:fs/promises";
import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const themePreload = await fs.readFile(path.join(import.meta.dirname, "public", "oc-theme-preload.js"), "utf8");

export default defineConfig({
	plugins: [
		{
			name: "omp-web:theme-preload",
			transformIndexHtml(html) {
				return html.replace(
					'<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
					`<script id="oc-theme-preload-script">${themePreload}</script>`,
				);
			},
		},
		tailwindcss(),
		solid(),
	],
	resolve: {
		alias: [
			{ find: /^@\//, replacement: `${path.join(import.meta.dirname, "src")}/` },
			{ find: /^@pierre\/trees$/, replacement: path.join(import.meta.dirname, "src", "vendor", "pierre-trees.ts") },
			{
				find: /^@pierre\/trees-base$/,
				replacement: path.join(
					import.meta.dirname,
					"..",
					"..",
					"node_modules",
					"@pierre",
					"trees",
					"dist",
					"index.js",
				),
			},
		],
		dedupe: ["solid-js"],
	},
	define: {
		"import.meta.env.VITE_OMP_CHANNEL": JSON.stringify("dev"),
	},
	worker: { format: "es" },
	server: {
		host: "127.0.0.1",
		port: 3000,
		proxy: {
			"/api": "http://127.0.0.1:4096",
			"/global": "http://127.0.0.1:4096",
			"/session": "http://127.0.0.1:4096",
			"/project": "http://127.0.0.1:4096",
			"/config": "http://127.0.0.1:4096",
			"/provider": "http://127.0.0.1:4096",
			"/agent": "http://127.0.0.1:4096",
			"/command": "http://127.0.0.1:4096",
			"/question": "http://127.0.0.1:4096",
			"/permission": "http://127.0.0.1:4096",
			"/file": "http://127.0.0.1:4096",
			"/find": "http://127.0.0.1:4096",
			"/path": "http://127.0.0.1:4096",
			"/vcs": "http://127.0.0.1:4096",
			"/mcp": "http://127.0.0.1:4096",
			"/lsp": "http://127.0.0.1:4096",
			"/pty": { target: "ws://127.0.0.1:4096", ws: true },
		},
	},
	build: {
		target: "esnext",
		sourcemap: true,
	},
});
