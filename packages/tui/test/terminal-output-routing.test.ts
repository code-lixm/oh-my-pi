import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { setTerminalOutputBrokerFactoryForTest, type TerminalOutputBroker } from "@oh-my-pi/pi-tui/terminal-output";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const DIRECT_RESIZE_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	HERDR_ENV: undefined,
	CMUX_WORKSPACE_ID: undefined,
	CMUX_SURFACE_ID: undefined,
	CMUX_REMOTE_TRANSPORT: undefined,
	TERM: undefined,
	TERM_PROGRAM: undefined,
	WT_SESSION: undefined,
	PI_TUI_RESIZE_IN_PLACE: "0",
};

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

class MutableRows implements Component {
	#rows: readonly string[];

	constructor(rows: readonly string[]) {
		this.#rows = rows;
	}

	setRows(rows: readonly string[]): void {
		this.#rows = rows;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		return this.#rows.map(row => row.slice(0, width));
	}
}

class RoutingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	readonly latestWrites: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	writeLatest(data: string): void {
		this.latestWrites.push(data);
		super.write(data);
	}

	clearOutput(): void {
		this.writes.length = 0;
		this.latestWrites.length = 0;
	}
}

class RecordingNativeBroker implements TerminalOutputBroker {
	readonly reliableWrites: string[] = [];
	readonly latestWrites: string[] = [];

	constructor(private readonly acceptLatest = true) {}

	writeReliable(data: string): boolean {
		this.reliableWrites.push(data);
		return true;
	}

	writeLatest(_frameId: number, data: string): boolean {
		this.latestWrites.push(data);
		return this.acceptLatest;
	}

	flush(_timeoutMs?: number): boolean {
		return true;
	}

	close(_timeoutMs?: number): boolean {
		return true;
	}

	stats(): never {
		throw new Error("stats is outside the terminal-output routing contract");
	}

	clear(): void {
		this.reliableWrites.length = 0;
		this.latestWrites.length = 0;
	}
}

function disposeHarnessAndRestoreFactory(
	harness: ProcessTerminalRenderHarness | undefined,
	restoreFactory: () => void,
): void {
	try {
		harness?.dispose();
	} finally {
		restoreFactory();
	}
}

describe("terminal-output routing", () => {
	it("keeps fullscreen and transient resize frames replaceable without moving normal paint or alt controls off write", async () => {
		await withEnvPatch(DIRECT_RESIZE_ENV, async () => {
			const terminal = new RoutingVirtualTerminal(40, 6);
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			const normalRows = new MutableRows(["NORMAL-ROUTE"]);
			tui.addChild(normalRows);

			try {
				tui.start();
				await scheduler.drain(terminal);
				expect(terminal.writes.some(data => data.includes("NORMAL-ROUTE"))).toBe(true);
				expect(terminal.latestWrites).toEqual([]);

				terminal.clearOutput();
				const overlay = tui.showOverlay(new MutableRows(["FULLSCREEN-ROUTE"]), {
					fullscreen: true,
					mouseTracking: false,
				});
				await scheduler.drain(terminal);

				expect(terminal.latestWrites.some(data => data.includes("FULLSCREEN-ROUTE"))).toBe(true);
				expect(terminal.writes.some(data => data.includes("FULLSCREEN-ROUTE"))).toBe(false);
				expect(terminal.writes.join("")).toContain("\x1b[?1049h");

				terminal.clearOutput();
				overlay.hide();
				await scheduler.drain(terminal);
				expect(terminal.writes.join("")).toContain("\x1b[?1049l");

				terminal.clearOutput();
				normalRows.setRows(["NORMAL-DIFF"]);
				tui.requestRender();
				await scheduler.drain(terminal);
				expect(terminal.writes.some(data => data.includes("NORMAL-DIFF"))).toBe(true);
				expect(terminal.latestWrites.some(data => data.includes("NORMAL-DIFF"))).toBe(false);

				terminal.clearOutput();
				terminal.resize(20, 6);
				await terminal.flush();
				expect(tui.resizeViewportPaints).toBe(1);
				expect(terminal.latestWrites.some(data => data.includes("NORMAL-DIFF"))).toBe(true);
				expect(terminal.latestWrites.some(data => data.includes("\x1b[?1049h"))).toBe(false);
				expect(terminal.writes.join("")).toContain("\x1b[?1049h");
			} finally {
				tui.stop();
			}
		});
	});

	it("sends ProcessTerminal replaceable frames to native latest while control writes remain reliable", () => {
		const broker = new RecordingNativeBroker();
		const restoreFactory = setTerminalOutputBrokerFactoryForTest(() => broker);
		let harness: ProcessTerminalRenderHarness | undefined;
		try {
			harness = createProcessTerminalRenderHarness();
			broker.clear();
			harness.writes.length = 0;

			harness.terminal.writeLatest("replaceable-frame");
			harness.terminal.write("reliable-control");

			expect(broker.latestWrites).toEqual(["replaceable-frame"]);
			expect(broker.reliableWrites).toEqual(["reliable-control"]);
			expect(harness.writes).toEqual([]);
		} finally {
			disposeHarnessAndRestoreFactory(harness, restoreFactory);
		}
	});

	it("downgrades an oversized ConPTY latest frame to reliable chunks instead of native latest", async () => {
		const broker = new RecordingNativeBroker();
		const restoreFactory = setTerminalOutputBrokerFactoryForTest(() => broker);
		let harness: ProcessTerminalRenderHarness | undefined;
		try {
			harness = createProcessTerminalRenderHarness();
			const activeHarness = harness;
			if (!activeHarness) throw new Error("ProcessTerminal harness was not created");
			broker.clear();
			activeHarness.writes.length = 0;
			await withEnvPatch({ WSL_DISTRO_NAME: "terminal-output-routing", WSL_INTEROP: undefined }, () => {
				Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
				const frame = "x".repeat(20_000);

				activeHarness.terminal.writeLatest(frame);

				expect(broker.latestWrites).toEqual([]);
				expect(broker.reliableWrites.length).toBeGreaterThan(1);
				expect(broker.reliableWrites.join("")).toBe(frame);
				expect(activeHarness.writes).toEqual([]);
			});
		} finally {
			if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
			else Reflect.deleteProperty(process, "platform");
			disposeHarnessAndRestoreFactory(harness, restoreFactory);
		}
	});

	it("stops ProcessTerminal instead of adding a direct stdout writer after native latest rejects a replaceable frame", () => {
		const broker = new RecordingNativeBroker(false);
		const restoreFactory = setTerminalOutputBrokerFactoryForTest(() => broker);
		let harness: ProcessTerminalRenderHarness | undefined;
		try {
			harness = createProcessTerminalRenderHarness();
			broker.clear();
			harness.writes.length = 0;

			const rendersBeforeReject = harness.probe.widths.length;
			harness.terminal.writeLatest("rejected-frame");
			harness.tui.resetDisplay();
			expect(harness.probe.widths).toHaveLength(rendersBeforeReject);

			expect(broker.latestWrites).toEqual(["rejected-frame"]);
			expect(harness.writes).toEqual([]);
		} finally {
			disposeHarnessAndRestoreFactory(harness, restoreFactory);
		}
	});

	it("keeps ProcessTerminal output direct when native broker construction falls back", () => {
		const restoreFactory = setTerminalOutputBrokerFactoryForTest(() => {
			throw new Error("native terminal output unavailable");
		});
		let harness: ProcessTerminalRenderHarness | undefined;
		try {
			harness = createProcessTerminalRenderHarness();
			harness.writes.length = 0;

			harness.terminal.writeLatest("direct-fallback-frame");

			expect(harness.writes).toEqual(["direct-fallback-frame"]);
		} finally {
			disposeHarnessAndRestoreFactory(harness, restoreFactory);
		}
	});
});
