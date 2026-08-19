import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Configuration } from "electron-builder";
import { resolveChannel } from "./scripts/utils";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

const metainfoFpm = (appId: string) =>
	`${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`;

const channel = resolveChannel();

const APP_IDS = {
	dev: "sh.omp.desktop.dev",
	beta: "sh.omp.desktop.beta",
	prod: "sh.omp.desktop",
} as const;

const getBase = (appId: string): Configuration => ({
	artifactName: `omp-desktop-\${os}-\${arch}.\${ext}`,
	directories: {
		output: "dist",
		buildResources: "resources",
	},
	// Linux launchers are `.desktop` files, so the configured desktop name
	// must match the application id used by the packaged executable.
	// https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
	// https://www.electron.build/docs/linux/
	extraMetadata: {
		desktopName: `${appId}.desktop`,
	},
	files: ["out/**/*", "resources/**/*", "!resources/omp-web-server*", "!resources/web/**/*"],
	extraResources: [
		{
			from: `resources/${process.platform === "win32" ? "omp-web-server.exe" : "omp-web-server"}`,
			to: process.platform === "win32" ? "omp-web-server.exe" : "omp-web-server",
		},
		{
			from: "resources/web/",
			to: "web/",
		},
	],
	mac: {
		category: "public.app-category.developer-tools",
		icon: `resources/icons/icon.icns`,
		hardenedRuntime: true,
		gatekeeperAssess: false,
		entitlements: "resources/entitlements.plist",
		entitlementsInherit: "resources/entitlements.plist",
		notarize: true,
		target: ["dmg", "zip"],
	},
	dmg: {
		sign: true,
	},
	protocols: {
		name: "OMP",
		schemes: ["omp"],
	},
	win: {
		icon: `resources/icons/icon.ico`,
		target: ["nsis"],
		verifyUpdateCodeSignature: false,
	},
	nsis: {
		oneClick: true,
		perMachine: false,
		installerIcon: `resources/icons/icon.ico`,
		installerHeaderIcon: `resources/icons/icon.ico`,
	},
	linux: {
		icon: `resources/icons`,
		category: "Development",
		executableName: appId,
		desktop: {
			entry: {
				// Match the installed .desktop file and hicolor icon basename so
				// Linux shells can associate the running Electron window with its launcher.
				StartupWMClass: appId,
			},
		},
		target: ["AppImage", "deb", "rpm"],
	},
});

function getConfig() {
	const appId = APP_IDS[channel];
	const base = getBase(appId);

	switch (channel) {
		case "dev": {
			return {
				...base,
				appId,
				productName: "OMP Dev",
				deb: { fpm: [metainfoFpm(appId)] },
				rpm: { packageName: "omp-dev", fpm: [metainfoFpm(appId)] },
			};
		}
		case "beta": {
			return {
				...base,
				appId,
				productName: "OMP Beta",
				protocols: { name: "OMP Beta", schemes: ["omp"] },
				deb: { fpm: [metainfoFpm(appId)] },
				rpm: { packageName: "omp-beta", fpm: [metainfoFpm(appId)] },
			};
		}
		case "prod": {
			return {
				...base,
				appId,
				productName: "OMP",
				protocols: { name: "OMP", schemes: ["omp"] },
				deb: { fpm: [metainfoFpm(appId)] },
				rpm: { packageName: "omp", fpm: [metainfoFpm(appId)] },
			};
		}
	}
}

export default getConfig();
