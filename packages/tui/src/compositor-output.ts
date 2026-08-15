import type { Terminal } from "./terminal";

/**
 * Sole compositor-to-terminal submission point. Control/authoritative paints
 * remain reliable; self-contained cosmetic frames use the replaceable slot when
 * the terminal exposes one.
 */
export class CompositorOutput {
	#terminal: Terminal;

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
	}

	submit(data: string, replaceable: boolean): void {
		if (replaceable && this.#terminal.writeLatest) {
			this.#terminal.writeLatest(data);
			return;
		}
		this.#terminal.write(data);
	}
}
