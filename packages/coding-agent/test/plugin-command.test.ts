import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Plugin from "@oh-my-pi/pi-coding-agent/commands/plugin";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { type CliLocale, CliUsageError, getCliLocale, setCliLocale } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

let previousCliLocale: CliLocale;

beforeEach(() => {
	previousCliLocale = getCliLocale();
	setCliLocale("en");
});

afterEach(() => {
	setCliLocale(previousCliLocale);
});

describe("Plugin command scope parsing", () => {
	it("rejects invalid scope values", async () => {
		const command = new Plugin(["install", "--scope", "porject"], TEST_CONFIG);
		let caught: unknown;

		try {
			await command.parse(Plugin);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(CliUsageError);
		if (!(caught instanceof CliUsageError)) throw caught;

		expect(caught.message).toContain("user");
		expect(caught.message).toContain("project");
		expect(caught.message).toContain("porject");
		expect(caught.message).toBe('Expected --scope to be one of: user, project; got "porject"');
	});
});
