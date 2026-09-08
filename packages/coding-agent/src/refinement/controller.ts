import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { RefinementController, RefinementOptions } from "../prime-integration/contracts";
import {
	type AutoRefinementReview,
	applyRefinementProposal,
	buildRollbackProposal,
	MAX_PROPOSAL_ROUNDS,
	type MechanicalValidationResult,
	serializeConversationWithTurns,
	snapshotHarnessState,
	validateProposalMechanically,
} from "./refinement";
import {
	commitHarnessStateAndHistory,
	createHarnessState,
	loadHarnessState,
	loadRefinementHistory,
	mergeHarnessStates,
} from "./state";
import type { HarnessScope, HarnessState, RefinementProposal, RefinementResult } from "./types";

const REFINEMENT_DISABLED_ERROR = "Continual harness refinement is disabled";

export interface RefinementIterationContext {
	messages: AgentMessage[];
	state: HarnessState;
	history: RefinementResult[];
	instructions?: string;
	scope: HarnessScope;
	/** Structured critique findings from the separate evaluator stage. */
	critique?: string;
	/** Required changes from the previous round's failed verification. */
	roundFeedback?: string[];
	round: number;
}

export type RefinementPlanFn = (options: RefinementIterationContext) => Promise<RefinementProposal>;

export type RefinementCritiqueFn = (options: {
	messages: AgentMessage[];
	state: HarnessState;
	history: RefinementResult[];
	scope: HarnessScope;
	instructions?: string;
}) => Promise<string>;

export type RefinementVerifyFn = (options: {
	messages: AgentMessage[];
	state: HarnessState;
	history: RefinementResult[];
	proposal: RefinementProposal;
	round: number;
}) => Promise<import("./types").ProposalVerification>;

export type AutoRefinementReviewFn = (options: {
	messages: AgentMessage[];
	state: HarnessState;
	history: RefinementResult[];
	reason: string;
	turnsSinceLastReview: number;
}) => Promise<AutoRefinementReview>;
type ScheduledRefinementRequest =
	| {
			requestId: string;
			generation: number;
			operation: "refine";
			options?: RefinementOptions;
	  }
	| {
			requestId: string;
			generation: number;
			operation: "rollback";
			resultId: string;
			scope?: HarnessScope;
	  };

export interface RefinementControllerDeps {
	agentDir: string;
	/** Session-scoped local harness root; undefined when the session has no artifact directory (local refinement is then unavailable, global remains usable). */
	getLocalHarnessDir: () => string | undefined;
	getMessages: () => AgentMessage[];
	planWithLLM: RefinementPlanFn;
	reviewWithLLM: AutoRefinementReviewFn;
	/** Separate evaluator stages: critique grounds the proposal, verify gates it. */
	critiqueWithLLM: RefinementCritiqueFn;
	verifyWithLLM: RefinementVerifyFn;
	waitForIdle: () => Promise<void>;
	refreshBaseSystemPrompt: () => Promise<void>;
	appendCustomEntry: (type: string, data: unknown) => void;
	isEnabled: () => boolean;
	getAutoRefineTurns: () => number;
	getAutoRefineCooldownMs: () => number;
	logWarning: (message: string, error: unknown) => void;
	disconnectFromAgent?: () => void;
	reconnectToAgent?: () => void;
}

export class RefinementControllerImpl implements RefinementController {
	#turnCount = 0;
	#lastAutoRefineAt = 0;
	#running: Promise<void> | undefined;
	#scheduled: ScheduledRefinementRequest[] = [];
	#scheduledGeneration = 0;
	#scheduledDrain: Promise<void> | undefined;
	readonly #deps: RefinementControllerDeps;

	constructor(deps: RefinementControllerDeps) {
		this.#deps = deps;
	}

	#assertEnabled(): void {
		if (!this.#deps.isEnabled()) throw new Error(REFINEMENT_DISABLED_ERROR);
	}

	onTurnEnd(_session: unknown): Promise<void> {
		if (!this.#deps.isEnabled()) return Promise.resolve();
		this.#turnCount++;
		const turnInterval = Math.max(1, Math.trunc(this.#deps.getAutoRefineTurns()));
		if (this.#turnCount < turnInterval) return Promise.resolve();
		const turnsSinceLastReview = this.#turnCount;
		this.#turnCount = 0;
		return this.#runAutoReview("periodic trajectory review", turnsSinceLastReview);
	}

	onCompaction(): Promise<void> {
		// Compaction rewrote the trajectory: the per-turn gate restarts from a
		// clean counter and the gate check runs immediately (cooldown still applies).
		this.#turnCount = 0;
		return this.#runAutoReview("trajectory rewritten by compaction", 0);
	}

	scheduleRefinement(options?: RefinementOptions): { requestId: string } {
		this.#assertEnabled();
		const requestId = String(Snowflake.next());
		this.#scheduled.push({
			requestId,
			generation: this.#scheduledGeneration,
			operation: "refine",
			options: options ? { ...options } : undefined,
		});
		return { requestId };
	}

	scheduleRollback(resultId: string, scope?: HarnessScope): { requestId: string } {
		this.#assertEnabled();
		const requestId = String(Snowflake.next());
		this.#scheduled.push({
			requestId,
			generation: this.#scheduledGeneration,
			operation: "rollback",
			resultId,
			scope,
		});
		return { requestId };
	}

	#runAutoReview(reason: string, turnsSinceLastReview: number): Promise<void> {
		if (!this.#deps.isEnabled()) return Promise.resolve();
		const now = Date.now();
		const cooldownMs = Math.max(0, Math.trunc(this.#deps.getAutoRefineCooldownMs()));
		if (now - this.#lastAutoRefineAt < cooldownMs) return Promise.resolve();
		void this.#runExclusive(async () => {
			const state = await this.getState();
			const history = await this.#loadMergedHistory();
			const review = await this.#deps.reviewWithLLM({
				messages: this.#deps.getMessages(),
				state,
				history,
				reason,
				turnsSinceLastReview,
			});
			if (!review.shouldRefine) return;
			// The cooldown starts when a refinement actually runs: a rejected
			// review must not consume the window and suppress later real triggers.
			this.#lastAutoRefineAt = Date.now();
			await this.#runRefinement("local", review.instructions ?? review.rationale);
		}).catch(error => this.#deps.logWarning(`Continual-harness review (${reason}) failed`, error));
		return Promise.resolve();
	}

	async refine(_session: unknown, options?: RefinementOptions): Promise<void> {
		this.#assertEnabled();
		return await this.#runExclusive(() => this.#runRefinement(options?.scope ?? "local", options?.instructions));
	}

	async rollback(_session: unknown, resultId: string, scope?: HarnessScope): Promise<void> {
		this.#assertEnabled();
		return await this.#runExclusive(async () => {
			const scopes: HarnessScope[] = scope ? [scope] : ["local", "global"];
			let target: RefinementResult | undefined;
			let effectiveScope: HarnessScope | undefined;
			for (const candidateScope of scopes) {
				const directory = this.#scopeDirectoryOrUndefined(candidateScope);
				if (!directory) continue;
				const history = await loadRefinementHistory(directory, candidateScope);
				const candidate = history.find(result => result.id === resultId);
				if (candidate) {
					target = candidate;
					effectiveScope = candidateScope;
					break;
				}
			}
			if (!target || !effectiveScope) throw new Error(`Refinement ${resultId} was not found`);

			await this.#deps.waitForIdle();
			this.#deps.disconnectFromAgent?.();
			try {
				const freshState = await this.#loadScopeState(effectiveScope);
				const result = applyRefinementProposal(freshState, buildRollbackProposal(target), {
					id: String(Snowflake.next()),
					scope: effectiveScope,
					rollbackOf: resultId,
				});
				await this.#persistResult(effectiveScope, freshState, result);
			} finally {
				this.#deps.reconnectToAgent?.();
			}
		});
	}

	drainScheduled(): Promise<void> {
		if (this.#scheduledDrain) return this.#scheduledDrain;
		const current = this.#drainScheduled();
		this.#scheduledDrain = current;
		void current.then(
			() => {
				if (this.#scheduledDrain === current) this.#scheduledDrain = undefined;
			},
			() => {
				if (this.#scheduledDrain === current) this.#scheduledDrain = undefined;
			},
		);
		return current;
	}

	clearScheduled(): void {
		this.#scheduledGeneration++;
		this.#scheduled = [];
	}

	async #drainScheduled(): Promise<void> {
		try {
			while (true) {
				const request = this.#scheduled.shift();
				if (!request) return;
				if (request.generation !== this.#scheduledGeneration) continue;
				try {
					if (request.operation === "refine") {
						await this.refine(undefined, request.options);
					} else {
						await this.rollback(undefined, request.resultId, request.scope);
					}
				} catch (error) {
					this.#recordScheduledFailure(request, error);
				}
			}
		} catch (error) {
			this.#safeLogWarning("Scheduled refinement drain failed", error);
		}
	}

	#recordScheduledFailure(request: ScheduledRefinementRequest, error: unknown): void {
		const scope = request.operation === "refine" ? request.options?.scope : request.scope;
		const data = {
			requestId: request.requestId,
			operation: request.operation,
			...(scope ? { scope } : {}),
			error: String(error),
		};
		try {
			this.#deps.appendCustomEntry("omp.refinement.failed", data);
		} catch (entryError) {
			this.#safeLogWarning("Failed to record scheduled refinement failure", entryError);
		}
		this.#safeLogWarning(`Scheduled refinement ${request.operation} failed`, error);
	}

	#safeLogWarning(message: string, error: unknown): void {
		try {
			this.#deps.logWarning(message, error);
		} catch {
			// Logging must not turn a handled scheduled request failure into a rejection.
		}
	}

	async getState(): Promise<HarnessState> {
		this.#assertEnabled();
		const localDir = this.#deps.getLocalHarnessDir();
		const [globalState, localState] = await Promise.all([
			loadHarnessState(this.#deps.agentDir, "global"),
			localDir ? loadHarnessState(localDir, "local") : Promise.resolve(undefined),
		]);
		return mergeHarnessStates(globalState, localState);
	}

	/**
	 * The bounded reflection loop: critique → propose → verify → (revise) →
	 * apply. The critic and the proposer are separate model calls; verification
	 * is mechanical first (evidence citations resolve, no duplicates, per-kind
	 * ceiling) then evaluative (forced-format verdict). A failed round feeds its
	 * required changes back into exactly one revision; exhausting
	 * {@link MAX_PROPOSAL_ROUNDS} records the failure and applies nothing.
	 */
	async #runRefinement(scope: HarnessScope, instructions?: string): Promise<void> {
		this.#assertEnabled();
		const [planningState, planningTarget, history] = await Promise.all([
			this.getState(),
			this.#loadScopeState(scope),
			this.#loadMergedHistory(),
		]);
		const messages = this.#deps.getMessages();
		const critique = await this.#deps.critiqueWithLLM({
			messages,
			state: planningState,
			history,
			scope,
			instructions,
		});
		const { turnCount } = serializeConversationWithTurns(messages);

		let roundFeedback: string[] | undefined;
		let lastReasons: string[] | undefined;
		let accepted: { proposal: RefinementProposal; rounds: number } | undefined;
		for (let round = 1; round <= MAX_PROPOSAL_ROUNDS; round++) {
			const proposal = await this.#deps.planWithLLM({
				messages,
				state: planningState,
				history,
				instructions,
				scope,
				critique,
				round,
				...(roundFeedback ? { roundFeedback } : {}),
			});
			if (proposal.edits.length === 0) return;

			// Cheap gate first: mechanical failures never spend an evaluator call.
			const mechanical: MechanicalValidationResult = validateProposalMechanically(
				proposal,
				planningState,
				turnCount,
			);
			if (mechanical.error) {
				lastReasons = [mechanical.error];
				roundFeedback = lastReasons;
				continue;
			}
			const verification = await this.#deps.verifyWithLLM({
				messages,
				state: planningState,
				history,
				proposal,
				round,
			});
			if (verification.verdict === "pass") {
				accepted = { proposal, rounds: round };
				break;
			}
			lastReasons = verification.requiredChanges.length > 0 ? verification.requiredChanges : verification.reasons;
			roundFeedback = lastReasons;
		}
		if (!accepted) {
			// Bounded exhaustion: nothing is applied, and the failure surfaces in
			// the transcript so the next trigger does not silently repeat it.
			throw new Error(
				`Refinement proposal rejected after ${MAX_PROPOSAL_ROUNDS} rounds: ${lastReasons?.join("; ") ?? "unverified"}`,
			);
		}

		await this.#deps.waitForIdle();
		this.#deps.disconnectFromAgent?.();
		try {
			const freshState = await this.#loadScopeState(scope);
			const result = applyRefinementProposal(freshState, accepted.proposal, {
				id: String(Snowflake.next()),
				scope,
				baselineState: snapshotHarnessState(planningTarget),
				rounds: accepted.rounds,
			});
			await this.#persistResult(scope, freshState, result);
		} finally {
			this.#deps.reconnectToAgent?.();
		}
	}

	async #persistResult(scope: HarnessScope, state: HarnessState, result: RefinementResult): Promise<void> {
		this.#assertEnabled();
		const directory = this.#scopeDirectory(scope);
		await commitHarnessStateAndHistory(state, result, scope, directory);
		this.#deps.appendCustomEntry("omp.refinement", result);
		await this.#deps.refreshBaseSystemPrompt();
	}

	async #loadScopeState(scope: HarnessScope): Promise<HarnessState> {
		return (await loadHarnessState(this.#scopeDirectory(scope), scope)) ?? createHarnessState();
	}

	async #loadMergedHistory(): Promise<RefinementResult[]> {
		const localDir = this.#deps.getLocalHarnessDir();
		const [globalHistory, localHistory] = await Promise.all([
			loadRefinementHistory(this.#deps.agentDir, "global"),
			localDir ? loadRefinementHistory(localDir, "local") : Promise.resolve([]),
		]);
		return [...globalHistory, ...localHistory];
	}

	#scopeDirectoryOrUndefined(scope: HarnessScope): string | undefined {
		return scope === "global" ? this.#deps.agentDir : this.#deps.getLocalHarnessDir();
	}

	#scopeDirectory(scope: HarnessScope): string {
		const directory = this.#scopeDirectoryOrUndefined(scope);
		if (!directory) throw new Error("Local harness is unavailable for this session (no artifact directory)");
		return directory;
	}

	async #runExclusive(operation: () => Promise<void>): Promise<void> {
		const prior = this.#running;
		const current = (prior ? prior.catch(() => {}) : Promise.resolve()).then(operation);
		this.#running = current;
		try {
			await current;
		} finally {
			if (this.#running === current) this.#running = undefined;
		}
	}
}

export function createRefinementController(deps: RefinementControllerDeps): RefinementController {
	return new RefinementControllerImpl(deps);
}
