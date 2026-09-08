export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	version: number;
	created_at: number;
	updated_at: number;
	[key: string]: unknown;
}

export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface HarnessRefinementEvent {
	id: string;
	summary: string;
	timestamp: number;
	scope: HarnessScope;
	rollbackOf?: string;
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id: string;
	title?: string;
	content?: string;
	/** Trajectory citations backing this edit (`turn:<index>`), validated mechanically. */
	evidence?: string[];
	[key: string]: unknown;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

/** Evaluator verdict over a proposal before it is allowed to touch state. */
export interface ProposalVerification {
	verdict: "pass" | "fail";
	reasons: string[];
	requiredChanges: string[];
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
	/** Proposal rounds consumed before this result was accepted. */
	rounds?: number;
}
