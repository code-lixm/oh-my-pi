import * as nativeBindings from "@oh-my-pi/pi-natives";
import { isInsideTerminalMultiplexer } from "./terminal-capabilities";

export interface NativeInputGateEnvironment {
	platform: NodeJS.Platform;
	stdinIsTTY: boolean;
	env: NodeJS.ProcessEnv;
}

/** Direct-Unix gate with an unconditional kill switch. */
export function shouldUseNativeInput(environment: NativeInputGateEnvironment): boolean {
	const configured = environment.env.PI_TUI_NATIVE_INPUT;
	if (configured === "0" || configured === "false") return false;
	if (environment.platform !== "darwin" && environment.platform !== "linux") return false;
	if (!environment.stdinIsTTY) return false;
	if (isInsideTerminalMultiplexer(environment.env)) return false;
	return true;
}

export interface NativeInputOptions {
	queueBytes?: number;
	readChunkBytes?: number;
}

export interface NativeInputStats {
	queueCapacityBytes: number;
	queuedEvents: number;
	queuedBytes: number;
	eventsRead: number;
	bytesRead: number;
	eventsDropped: number;
	bytesDropped: number;
	wakesSent: number;
	running: boolean;
	stopped: boolean;
	workerFailed: boolean;
	failure?: string;
}

export interface NativeInputBridge {
	start(): boolean;
	read(maxEvents: number, maxBytes: number): Uint8Array[];
	waitForInput(): Promise<boolean>;
	stop(): boolean;
	stats(): NativeInputStats;
}

type NativeInputConstructor = new (
	onWake: (error: Error | null, wake: number) => void,
	options?: NativeInputOptions,
) => NativeInputBridge;

export function createNativeInputBridge(
	onWake: (error: Error | null, wake: number) => void,
	options?: NativeInputOptions,
): NativeInputBridge | undefined {
	const candidate = Reflect.get(nativeBindings, "NativeInput");
	if (typeof candidate !== "function") return undefined;
	const NativeInput = candidate as NativeInputConstructor;
	return new NativeInput(onWake, options);
}

export interface EditorShadowState {
	text: string;
	cursorLine: number;
	cursorCol: number;
}

export interface EditorInputShadow {
	reset(state: EditorShadowState, generation: number): boolean;
	applyPrintable(input: string, before: EditorShadowState, after: EditorShadowState, generation: number): boolean;
}

interface NativeEditorShadowBinding {
	reset(text: string, cursorLine: number, cursorCol: number, generation: number): boolean;
	applyPrintable(
		input: string,
		beforeText: string,
		beforeLine: number,
		beforeCol: number,
		afterText: string,
		afterLine: number,
		afterCol: number,
		generation: number,
	): boolean;
}

type NativeEditorShadowConstructor = new () => NativeEditorShadowBinding;

class NativeEditorInputShadow implements EditorInputShadow {
	#binding: NativeEditorShadowBinding;

	constructor(binding: NativeEditorShadowBinding) {
		this.#binding = binding;
	}

	reset(state: EditorShadowState, generation: number): boolean {
		return this.#binding.reset(state.text, state.cursorLine, state.cursorCol, generation);
	}

	applyPrintable(input: string, before: EditorShadowState, after: EditorShadowState, generation: number): boolean {
		return this.#binding.applyPrintable(
			input,
			before.text,
			before.cursorLine,
			before.cursorCol,
			after.text,
			after.cursorLine,
			after.cursorCol,
			generation,
		);
	}
}

/** Resolve the optional N-API editor shadow without making it authoritative. */
export function createNativeEditorInputShadow(): EditorInputShadow | undefined {
	const candidate = Reflect.get(nativeBindings, "NativeEditorShadow");
	if (typeof candidate !== "function") return undefined;
	const NativeEditorShadow = candidate as NativeEditorShadowConstructor;
	return new NativeEditorInputShadow(new NativeEditorShadow());
}
