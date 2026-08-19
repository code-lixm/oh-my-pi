export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	size: number;
	firstMessage: string;
	allMessagesText: string;
	status?: "active" | "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
}

export function listAllSessions(storage?: FileSessionStorage, sessionsRoot?: string): Promise<SessionInfo[]>;
export class FileSessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
}

export function listSessionsFromDirs(sessionDirs: string[], storage: FileSessionStorage): Promise<SessionInfo[]>;
export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined;
export function computeCompatibleSessionDirs(cwd: string, storage: FileSessionStorage, sessionsRoot?: string): string[];
