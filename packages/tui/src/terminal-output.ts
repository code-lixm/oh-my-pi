import * as nativeBindings from "@oh-my-pi/pi-natives";
import { isBunTestRuntime, isTerminalHeadless, logger } from "@oh-my-pi/pi-utils";

/** Options accepted by the native `TerminalOutputBroker` constructor. */
export interface TerminalOutputBrokerOptions {
	reliableCapacity?: number;
}

/** Snapshot returned by the native `TerminalOutputBroker`. */
export interface TerminalOutputBrokerStats {
	reliableCapacity: number;
	reliableQueued: number;
	reliableAccepted: number;
	reliableWritten: number;
	reliableRejected: number;
	latestAccepted: number;
	latestWritten: number;
	latestRejected: number;
	latestSuperseded: number;
	latestPending: boolean;
	lastLatestFrameId?: number;
	closed: boolean;
	workerFinished: boolean;
	workerFailed: boolean;
	failure?: string;
}

/** Native terminal-output contract used by the TypeScript lifecycle wrapper. */
export interface TerminalOutputBroker {
	writeReliable(data: string): boolean;
	writeLatest(frameId: number, data: string): boolean;
	flush(timeoutMs?: number): boolean;
	close(timeoutMs?: number): boolean;
	stats(): TerminalOutputBrokerStats;
}

/** Factory seam for broker-contract tests; production resolves the N-API class. */
export type TerminalOutputBrokerFactory = (options?: TerminalOutputBrokerOptions) => TerminalOutputBroker;

type TerminalOutputBrokerConstructor = new (options?: TerminalOutputBrokerOptions) => TerminalOutputBroker;

/** Lifecycle surface held by ProcessTerminal after it claims output ownership. */
export interface TerminalOutputOwner {
	readonly usesNativeBroker: boolean;
	reliable(data: string): boolean;
	latest(frameId: number, data: string): boolean;
	flush(timeoutMs?: number): boolean;
	close(timeoutMs?: number): boolean;
}

let brokerFactoryForTest: TerminalOutputBrokerFactory | undefined;
let activeTerminalOutputOwner: ManagedTerminalOutputOwner | null = null;

function writeDirectTerminalControl(data: string): boolean {
	return process.stdout.write(data);
}

function resolveNativeTerminalOutputBroker(options?: TerminalOutputBrokerOptions): TerminalOutputBroker | null {
	const candidate = Reflect.get(nativeBindings, "TerminalOutputBroker");
	if (typeof candidate !== "function") return null;
	const Broker = candidate as TerminalOutputBrokerConstructor;
	return new Broker(options);
}

/**
 * Process-owned terminal output lifecycle. It reserves the sole stdout owner
 * before startup output begins, then either delegates all writes to the native
 * broker or retains the pre-install direct-write fallback for this session.
 */
class ManagedTerminalOutputOwner implements TerminalOutputOwner {
	#broker: TerminalOutputBroker | null;
	#released = false;
	#workerFailed = false;

	constructor(broker: TerminalOutputBroker | null) {
		this.#broker = broker;
	}

	get usesNativeBroker(): boolean {
		return this.#broker !== null;
	}

	reliable(data: string): boolean {
		if (this.#released || this.#workerFailed) return false;
		if (!this.#broker) return writeDirectTerminalControl(data);
		try {
			return this.#broker.writeReliable(data);
		} catch (err) {
			this.#workerFailed = true;
			logger.warn("terminal output broker reliable write failed", { err });
			return false;
		}
	}

	latest(frameId: number, data: string): boolean {
		if (this.#released || this.#workerFailed) return false;
		if (!this.#broker) return this.reliable(data);
		try {
			return this.#broker.writeLatest(frameId, data);
		} catch (err) {
			this.#workerFailed = true;
			logger.warn("terminal output broker latest write failed", { err });
			return false;
		}
	}

	flush(timeoutMs?: number): boolean {
		if (this.#released) return true;
		if (this.#workerFailed) return false;
		if (!this.#broker) return true;
		try {
			return this.#broker.flush(timeoutMs);
		} catch (err) {
			this.#workerFailed = true;
			logger.warn("terminal output broker flush failed", { err });
			return false;
		}
	}

	close(timeoutMs?: number): boolean {
		if (this.#released) return true;
		let closed = false;
		if (!this.#broker) {
			closed = true;
		} else {
			try {
				closed = this.#broker.close(timeoutMs);
			} catch (err) {
				this.#workerFailed = true;
				logger.warn("terminal output broker close failed", { err });
			}
		}
		if (!closed) return false;
		this.#released = true;
		if (activeTerminalOutputOwner === this) activeTerminalOutputOwner = null;
		return true;
	}
}

/** True while a ProcessTerminal owns terminal output, direct fallback included. */
export function hasActiveTerminalOutputOwner(): boolean {
	return activeTerminalOutputOwner !== null;
}

/**
 * Write a terminal control sequence through the active owner. Outside a live
 * TUI it uses the legacy direct writer; while a native owner exists it never
 * falls back to a second writer when the broker rejects output.
 */
export function writeTerminalControl(data: string): boolean {
	if (isTerminalHeadless()) return false;
	return activeTerminalOutputOwner?.reliable(data) ?? writeDirectTerminalControl(data);
}

/**
 * Claim output ownership before the first startup control sequence. Native
 * construction is intentionally attempted exactly once; a failure leaves this
 * owner on the legacy direct writer for its full lifetime.
 */
export function installTerminalOutputOwner(options?: TerminalOutputBrokerOptions): TerminalOutputOwner {
	if (activeTerminalOutputOwner) {
		throw new Error("A terminal output owner is already active");
	}

	let broker: TerminalOutputBroker | null = null;
	if (!isBunTestRuntime() || brokerFactoryForTest) {
		try {
			broker = brokerFactoryForTest?.(options) ?? resolveNativeTerminalOutputBroker(options);
		} catch (err) {
			logger.warn("terminal output broker construction failed; using direct terminal output", { err });
		}
	}

	const owner = new ManagedTerminalOutputOwner(broker);
	activeTerminalOutputOwner = owner;
	return owner;
}

/**
 * Override N-API construction for isolated broker tests. Tests must restore
 * the returned callback after closing their owner.
 */
export function setTerminalOutputBrokerFactoryForTest(factory: TerminalOutputBrokerFactory | undefined): () => void {
	if (activeTerminalOutputOwner) {
		throw new Error("Cannot replace the terminal output broker factory while an owner is active");
	}
	const previous = brokerFactoryForTest;
	brokerFactoryForTest = factory;
	return () => {
		if (activeTerminalOutputOwner) {
			throw new Error("Cannot restore the terminal output broker factory while an owner is active");
		}
		brokerFactoryForTest = previous;
	};
}
