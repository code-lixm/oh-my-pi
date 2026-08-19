export const VERSION: string;

export function getAgentDir(): string;
export interface FileLockOptions {
	retries?: number;
	retryDelayMs?: number;
}

export function withFileLock<T>(filePath: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T>;
