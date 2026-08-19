import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Configuration } from "electron-builder";

const channels = [
	{
		channel: "dev",
		appId: "sh.omp.desktop.dev",
		productName: "OMP Dev",
		deepLinkName: "OMP",
		linuxPackageName: "omp-dev",
	},
	{
		channel: "beta",
		appId: "sh.omp.desktop.beta",
		productName: "OMP Beta",
		deepLinkName: "OMP Beta",
		linuxPackageName: "omp-beta",
	},
	{
		channel: "prod",
		appId: "sh.omp.desktop",
		productName: "OMP",
		deepLinkName: "OMP",
		linuxPackageName: "omp",
	},
] as const;

type Channel = (typeof channels)[number]["channel"];

async function configFor(channel: Channel) {
	const previous = process.env.OMP_CHANNEL;
	process.env.OMP_CHANNEL = channel;

	try {
		// The config chooses its channel at module evaluation time, so each channel needs its own import.
		const module = await import(`./electron-builder.config.ts?channel=${channel}`);
		return module.default as Configuration;
	} finally {
		if (previous === undefined) delete process.env.OMP_CHANNEL;
		else process.env.OMP_CHANNEL = previous;
	}
}

function hasLegacyPublishTarget(publish: unknown) {
	const targets = Array.isArray(publish) ? publish : [publish];

	return targets.some(target => {
		if (target === null || typeof target !== "object") return false;

		const { owner, repo } = target as Record<string, unknown>;
		return (
			typeof owner === "string" &&
			typeof repo === "string" &&
			owner.toLowerCase() === "anomalyco" &&
			repo.toLowerCase() === "opencode"
		);
	});
}

for (const channel of channels) {
	test(`uses the OMP packaging identity for ${channel.channel}`, async () => {
		const config = await configFor(channel.channel);
		const metainfo = `${channel.appId}.metainfo.xml`;
		const metainfoMapping = `${join("resources", metainfo)}=/usr/share/metainfo/${metainfo}`;

		expect(config.appId).toBe(channel.appId);
		expect(config.productName).toBe(channel.productName);
		expect(config.protocols).toEqual({
			name: channel.deepLinkName,
			schemes: ["omp"],
		});
		expect(config.artifactName).toMatch(/^omp-desktop-/);

		expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`);
		expect(config.linux?.executableName).toBe(channel.appId);
		expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId);
		expect(config.linux?.icon).toEqual(expect.stringMatching(/(?:^|[/\\])icons$/));
		expect(config.deb?.fpm?.some(entry => entry.endsWith(metainfoMapping))).toBe(true);
		expect(config.rpm?.fpm?.some(entry => entry.endsWith(metainfoMapping))).toBe(true);
		expect(config.rpm?.packageName).toBe(channel.linuxPackageName);

		expect(config.extraResources).toContainEqual({
			from: "resources/omp-web-server",
			to: "omp-web-server",
		});
		expect(config.extraResources).toContainEqual({
			from: "resources/web/",
			to: "web/",
		});
	});
}

test("does not publish any channel to anomalyco/OpenCode", async () => {
	for (const { channel } of channels) {
		const config = await configFor(channel);
		expect(hasLegacyPublishTarget(config.publish)).toBe(false);
	}
});

test("does not inject the legacy OpenCode launcher into prod packages", async () => {
	const config = await configFor("prod");
	const packageFiles = [...(config.deb?.fpm ?? []), ...(config.rpm?.fpm ?? [])];

	expect(packageFiles.some(entry => entry.includes("opencode-desktop.desktop"))).toBe(false);
	expect(packageFiles.some(entry => entry.includes("ai.opencode.desktop"))).toBe(false);
});
