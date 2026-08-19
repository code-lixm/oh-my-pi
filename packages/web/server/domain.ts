export interface WebSessionRecord {
	id: string;
	projectID: string;
	directory: string;
	sessionPath?: string;
	parentID?: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: number;
	updatedAt: number;
}

export interface StoredMessage {
	id: string;
	sessionID: string;
	data: unknown;
}

export interface StoredEvent {
	sequence: number;
	sessionID?: string;
	directory: string;
	payload: unknown;
	createdAt: number;
}

export type InteractionKind = "question" | "permission" | "notification";

export interface StoredInteraction {
	id: string;
	sessionID: string;
	kind: InteractionKind;
	request: unknown;
	status: "pending" | "resolved" | "rejected";
	createdAt: number;
}
