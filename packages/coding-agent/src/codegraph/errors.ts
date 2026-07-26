/**
 * CodeGraph error classes — adapted from upstream `src/errors.ts`
 * (MIT, Copyright (c) 2026 Colby Mchenry — see ./UPSTREAM_LICENSE).
 *
 * Names and shapes are preserved so callers can `instanceof` against
 * the same hierarchies; no per-project path assumptions are encoded
 * here.
 */
export class CodeGraphError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "CodeGraphError";
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

export class CodeGraphFileError extends CodeGraphError {
	override readonly name = "CodeGraphFileError";
}

export class CodeGraphParseError extends CodeGraphError {
	readonly line?: number;
	readonly column?: number;
	override readonly name = "CodeGraphParseError";
	constructor(message: string, line?: number, column?: number) {
		super(message);
		this.line = line;
		this.column = column;
	}
}

export class CodeGraphDatabaseError extends CodeGraphError {
	override readonly name = "CodeGraphDatabaseError";
}

export class CodeGraphSearchError extends CodeGraphError {
	override readonly name = "CodeGraphSearchError";
}

export class CodeGraphConfigError extends CodeGraphError {
	override readonly name = "CodeGraphConfigError";
}

/** Raised when a runtime cannot acquire its cross-process file lock. */
export class FileLockUnavailableError extends CodeGraphError {
	override readonly name = "FileLockUnavailableError";
}

/** Logger used by `runtime.explore` etc. — silent by default in tests. */
export interface CodeGraphLogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: CodeGraphLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

let currentLogger: CodeGraphLogger = silentLogger;

export function setCodeGraphLogger(logger: CodeGraphLogger): void {
	currentLogger = logger;
}

export function getCodeGraphLogger(): CodeGraphLogger {
	return currentLogger;
}

export function logWarn(message: string, context?: Record<string, unknown>): void {
	currentLogger.warn(message, context);
}

export function logError(message: string, context?: Record<string, unknown>): void {
	currentLogger.error(message, context);
}

export function logDebug(message: string, context?: Record<string, unknown>): void {
	currentLogger.debug(message, context);
}
