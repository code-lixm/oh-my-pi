import * as fs from "node:fs/promises";
import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import solidPlugin from "vite-plugin-solid";

const theme = await fs.readFile(path.join(import.meta.dirname, "public", "oc-theme-preload.js"), "utf8");
const channel = (() => {
	const raw = process.env.OMP_CHANNEL;
	if (raw === "dev" || raw === "beta" || raw === "prod") return raw;
	if (raw === "latest") return "prod";
	return "dev";
})();

/** @type {import("vite").PluginOption} */
export default [
	{
		name: "omp-web:desktop-config",
		config() {
			return {
				resolve: {
					alias: [
						{ find: /^@\//, replacement: `${path.join(import.meta.dirname, "src")}/` },
						{ find: /^@pierre\/trees$/, replacement: path.join(import.meta.dirname, "src", "vendor", "pierre-trees.ts") },
						{ find: /^@pierre\/trees-base$/, replacement: path.join(import.meta.dirname, "..", "..", "node_modules", "@pierre", "trees", "dist", "index.js") },
					],
					dedupe: ["solid-js"],
				},
				define: {
					"import.meta.env.VITE_OMP_CHANNEL": JSON.stringify(channel),
				},
				worker: { format: "es" },
			};
		},
	},
	{
		name: "omp-web:desktop-theme-preload",
		transformIndexHtml(html) {
			return html.replace(
				'<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
				`<script id="oc-theme-preload-script">${theme}</script>`,
			);
		},
	},
	tailwindcss(),
	solidPlugin(),
];
