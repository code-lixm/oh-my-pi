import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { parseModelString } from "../config/model-resolver";
import type { AgentMessageReceipt, AgentMessageSendOptions, AgentMessageTarget } from "../irc/rlm-message-adapter";
import { createRlmMessageAdapter, type RlmMessageAdapter } from "../irc/rlm-message-adapter";
import type { RlmChildLifecycle } from "../prime-integration/contracts";
import type {
	RlmChildInfo,
	RlmChildRegistry,
	RlmRunningPublication,
	RlmSettlement,
} from "../registry/rlm-child-registry";
import type { RlmChildRegistryEntry, RlmSpawnHandle } from "./rlm-types";

function rlmModelsMatch(
	expected: string,
	actual: string,
	isLiteralModelId?: (provider: string, id: string) => boolean,
): boolean {
	const requested = expected.trim();
	const resolved = actual.trim();
	if (requested === resolved) return true;

	const parseOptions = {
		allowMaxSuffix: isLiteralModelId !== undefined,
		allowAutoAlias: isLiteralModelId !== undefined,
		...(isLiteralModelId === undefined ? {} : { isLiteralModelId }),
	};
	const requestedModel = parseModelString(requested, parseOptions);
	const resolvedModel = parseModelString(resolved, parseOptions);
	if (!requestedModel || !resolvedModel) return false;
	if (
		requestedModel.provider.toLowerCase() !== resolvedModel.provider.toLowerCase() ||
		requestedModel.id.toLowerCase() !== resolvedModel.id.toLowerCase()
	) {
		return false;
	}

	// A selector without an explicit effort may acquire the session's concrete
	// default while the child starts. Explicit levels still must match; `auto`
	// and `inherit` intentionally defer the concrete level to the child session.
	const requestedThinking = requestedModel.thinkingLevel;
	return (
		requestedThinking === undefined ||
		requestedThinking === "auto" ||
		requestedThinking === "inherit" ||
		requestedThinking === resolvedModel.thinkingLevel
	);
}

export interface RlmSpawnedSubagent {
	agentId: string;
	sessionDir: string;
	sessionId?: string | null;
	sessionFile?: string | null;
	model: string;
	settlement: RlmSettlement;
}

export interface RlmBridgeDeps {
	registry: RlmChildRegistry;
	spawnSubagent: (
		prompt: string,
		options: {
			rlmChildId: string;
			sessionDir: string;
			name: string;
			model: string;
			parentAgentId: string;
			depth: number;
			maxDepth: number;
			signal: AbortSignal;
			/** Publish the reserved child as running before its execution settles. */
			publishRunning: (publication: RlmRunningPublication) => Promise<void>;
		},
	) => Promise<RlmSpawnedSubagent>;
	getDefaultModel: () => string | undefined;
	/** Returns true for a provider/model ID whose suffix is literal rather than a thinking selector. */
	isLiteralModelId?: (provider: string, id: string) => boolean;
	/** Current session identity; it owns direct children and receives their terminal notices. */
	ownerAgentId: string;
	/** Upstream parent available to a nested child for `agent_message` only. */
	parentAgentId?: string;
	currentDepth: number;
	maxDepth: number;
	sendToAgent?: (
		agentId: string,
		message: string,
		mode: "steer" | "followUp",
	) => Promise<"delivered" | "queued" | "failed">;
	/** Sibling projection owned by this bridge's upstream parent registry. */
	listSiblings?: () => RlmChildRegistryEntry[];
	/** Parent-owned registry used to await a queued or starting sibling publication. */
	siblingRegistry?: {
		list(): RlmChildRegistryEntry[];
		get?(childId: string): RlmChildRegistryEntry | undefined;
		awaitPublication?(childId: string, signal?: AbortSignal): Promise<unknown>;
		refresh?(): Promise<void>;
	};
	/** Durable parent-side marker for this child agent's first explicit reply. */
	markParentReply?: () => Promise<void>;
	/**
	 * Registers the admission as a manual RLM background job so settlement is
	 * durable and never routed through the owner's async-result sink. Without
	 * it the child still runs, detached, and settles through the registry.
	 */
	registerJob?: (
		label: string,
		run: (ctx: { jobId: string; signal: AbortSignal; markRunning: () => void }) => Promise<string>,
		options: { id: string; description?: string; ownerId?: string },
	) => string;
}

class RlmChildSettlementError extends Error {
	constructor(rlmChildId: string, settlement: RlmSettlement) {
		super(settlement.error ?? `RLM child ${rlmChildId} ${settlement.status}.`);
		this.name = "RlmChildSettlementError";
	}
}

export class RlmBridge implements RlmChildLifecycle {
	readonly #deps: RlmBridgeDeps;
	readonly #messages: RlmMessageAdapter | undefined;
	readonly #terminalNoticeDeliveries = new Map<string, Promise<void>>();

	constructor(deps: RlmBridgeDeps) {
		this.#deps = deps;
		this.#messages = deps.sendToAgent
			? createRlmMessageAdapter({
					registry: {
						list: () => deps.registry.snapshotEntries(),
						get: childId => deps.registry.snapshotEntries().find(entry => entry.rlm_child_id === childId),
						awaitPublication: childId => deps.registry.awaitPublication(childId),
						refresh: () => deps.registry.refresh?.() ?? Promise.resolve(),
					},
					ownerAgentId: deps.ownerAgentId,
					...(deps.parentAgentId === undefined ? {} : { parentAgentId: deps.parentAgentId }),
					...(deps.listSiblings === undefined ? {} : { listSiblings: deps.listSiblings }),
					...(deps.siblingRegistry === undefined ? {} : { siblingRegistry: deps.siblingRegistry }),
					sendToAgent: deps.sendToAgent,
					...(deps.markParentReply === undefined ? {} : { markParentReply: deps.markParentReply }),
				})
			: undefined;
		if (this.#messages) {
			deps.registry.setPendingTerminalNoticeRetry(child => this.#retryPendingTerminalNotice(child));
		}
	}

	async spawnChild(prompt: string, options: { name?: string; model?: string }): Promise<RlmSpawnHandle> {
		const rlmChildId = String(Snowflake.next());
		const name = options.name?.trim() || `rlm-child-${rlmChildId.slice(-8)}`;
		const model = options.model?.trim() || this.#deps.getDefaultModel()?.trim();
		if (!model) throw new Error("RLM child model is required and no parent default model is available");
		if (!Number.isInteger(this.#deps.maxDepth) || this.#deps.maxDepth < -1) {
			throw new Error("RLM maximum depth must be -1 (unlimited) or a non-negative integer.");
		}
		if (this.#deps.maxDepth >= 0 && this.#deps.currentDepth >= this.#deps.maxDepth) {
			throw new Error(`RLM max depth reached: depth=${this.#deps.currentDepth}, max=${this.#deps.maxDepth}`);
		}
		const taskDepth = this.#deps.currentDepth + 1;
		const reservation = await this.#deps.registry.reserveAdmission({
			rlmChildId,
			name,
			model,
			taskDepth,
			maxDepth: this.#deps.maxDepth,
		});
		const admissionDone = Promise.withResolvers<void>();
		let admittedSessionDir = "";
		let admissionError: unknown;
		let jobId: string | undefined;
		try {
			// Commit the durable admission before creating a runnable job. A collision
			// therefore has no AsyncJobManager side effect to cancel or expose.
			const admitted = await this.#deps.registry.commitAdmission(reservation);
			admittedSessionDir = admitted.session_dir;
			if (this.#deps.registerJob) {
				jobId = this.#deps.registerJob(
					`rlm: ${name}`,
					async ctx => {
						await admissionDone.promise;
						if (admissionError !== undefined) {
							throw admissionError instanceof Error ? admissionError : new Error(String(admissionError));
						}
						await this.#runChildJob(prompt, admittedSessionDir, rlmChildId, name, model, taskDepth, ctx);
						return "";
					},
					{ id: rlmChildId, ownerId: this.#deps.ownerAgentId, description: `RLM child ${name}` },
				);
				await this.#deps.registry.bindJob(rlmChildId, jobId);
			}
		} catch (error) {
			admissionError = error;
			this.#deps.registry.rollbackAdmission(reservation, jobId);
			if (admittedSessionDir) {
				await this.#deps.registry
					.markSettled(rlmChildId, {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					})
					.catch(markError =>
						logger.warn("Failed to persist RLM admission failure", { error: String(markError) }),
					);
			}
			throw error;
		} finally {
			admissionDone.resolve();
		}

		if (!this.#deps.registerJob) {
			void this.#runChildJob(prompt, admittedSessionDir, rlmChildId, name, model, taskDepth, {
				markRunning: () => {},
				signal: new AbortController().signal,
			}).catch(() => {});
		}
		return { rlm_child_id: rlmChildId, name, session_dir: admittedSessionDir, model };
	}

	async #runChildJob(
		prompt: string,
		sessionDir: string,
		rlmChildId: string,
		name: string,
		model: string,
		taskDepth: number,
		ctx: { signal: AbortSignal; markRunning: () => void },
	): Promise<void> {
		let earlyRunningPublication: Promise<void> | undefined;
		const publishRunning = (publication: RlmRunningPublication): Promise<void> => {
			if (ctx.signal.aborted || this.#deps.registry.isDisposed) {
				throw ctx.signal.reason instanceof Error
					? ctx.signal.reason
					: new Error("RLM child was cancelled before publication.");
			}
			if (!earlyRunningPublication) {
				ctx.markRunning();
				earlyRunningPublication = this.#deps.registry.markRunning(rlmChildId, publication);
			}
			return earlyRunningPublication;
		};
		try {
			if (ctx.signal.aborted || this.#deps.registry.isDisposed) {
				throw ctx.signal.reason instanceof Error
					? ctx.signal.reason
					: new Error("RLM child was cancelled before it started.");
			}
			const spawned = await this.#deps.spawnSubagent(prompt, {
				rlmChildId,
				sessionDir,
				name,
				model,
				parentAgentId: this.#deps.ownerAgentId,
				depth: taskDepth,
				maxDepth: this.#deps.maxDepth,
				signal: ctx.signal,
				publishRunning,
			});
			if (spawned.agentId !== rlmChildId) {
				throw new Error(`RLM child identity mismatch: expected ${rlmChildId}, received ${spawned.agentId}`);
			}
			if (spawned.sessionDir !== sessionDir) {
				throw new Error(
					`RLM child session directory mismatch: expected ${sessionDir}, received ${spawned.sessionDir}`,
				);
			}
			if (!rlmModelsMatch(model, spawned.model, this.#deps.isLiteralModelId)) {
				throw new Error(`RLM child model mismatch: expected ${model}, received ${spawned.model}`);
			}
			if (!earlyRunningPublication) {
				throw new Error("RLM child settled without publishing its running session.");
			}
			await earlyRunningPublication;
			await this.#deps.registry.markSettled(rlmChildId, spawned.settlement);
			await this.#sendTerminalNotice(rlmChildId, spawned.settlement.status, spawned.settlement.error);
			if (spawned.settlement.status !== "completed") {
				throw new RlmChildSettlementError(rlmChildId, spawned.settlement);
			}
		} catch (error) {
			if (error instanceof RlmChildSettlementError) throw error;
			const settlement: RlmSettlement = {
				status: ctx.signal.aborted ? "cancelled" : "failed",
				error: String(error),
			};
			logger.error("RLM child run failed", { rlmChildId, error: settlement.error });
			await this.#deps.registry.markSettled(rlmChildId, settlement).catch(markError =>
				logger.warn("Failed to persist RLM child failure", {
					rlmChildId,
					error: String(markError),
				}),
			);
			await this.#sendTerminalNotice(rlmChildId, settlement.status, settlement.error).catch(noticeError =>
				logger.warn("Failed to send RLM child failure notice", {
					rlmChildId,
					error: String(noticeError),
				}),
			);
			throw error;
		}
	}

	async #retryPendingTerminalNotice(child: RlmChildInfo): Promise<void> {
		if (this.#deps.registry.isDisposed) return;
		switch (child.run_status) {
			case "completed":
			case "failed":
			case "cancelled":
				await this.#sendTerminalNotice(child.rlm_child_id, child.run_status, child.error);
		}
	}

	/**
	 * Delivers the terminal notice after a child settles. The pending sidecar
	 * state is written before delivery so a failed receipt survives restart.
	 */
	async #sendTerminalNotice(rlmChildId: string, outcome: RlmSettlement["status"], error?: string): Promise<void> {
		if (this.#deps.registry.isDisposed || !this.#messages) return;
		const inFlight = this.#terminalNoticeDeliveries.get(rlmChildId);
		if (inFlight) return await inFlight;
		const delivery = this.#deliverTerminalNotice(rlmChildId, outcome, error);
		this.#terminalNoticeDeliveries.set(rlmChildId, delivery);
		try {
			await delivery;
		} finally {
			if (this.#terminalNoticeDeliveries.get(rlmChildId) === delivery) {
				this.#terminalNoticeDeliveries.delete(rlmChildId);
			}
		}
	}

	async #deliverTerminalNotice(rlmChildId: string, outcome: RlmSettlement["status"], error?: string): Promise<void> {
		try {
			if (this.#deps.registry.isDisposed) return;
			const children = await this.#deps.registry.list();
			if (this.#deps.registry.isDisposed) return;
			const child = children.find(candidate => candidate.rlm_child_id === rlmChildId);
			if (!child || child.terminal_notice === "sent" || child.run_status !== outcome) return;
			if (outcome === "completed" && child.replied_to_parent) {
				await this.#deps.registry.markTerminalNotice(rlmChildId, "sent");
				return;
			}
			await this.#deps.registry.markTerminalNotice(rlmChildId, "pending");
			if (this.#deps.registry.isDisposed) return;
			const message =
				outcome === "completed"
					? `RLM child ${child.name} completed without reply: completed`
					: `RLM child ${child.name} ${outcome}${error ? `: ${error}` : ""}`;
			const receipt: AgentMessageReceipt = {
				deliveryStatus: await this.#deps.sendToAgent!(this.#deps.ownerAgentId, message, "steer"),
				receiverId: this.#deps.ownerAgentId,
			};
			if (receipt.deliveryStatus === "failed") {
				logger.warn("RLM terminal notice delivery failed; retry remains pending", { rlmChildId });
				return;
			}
			if (this.#deps.registry.isDisposed) return;
			await this.#deps.registry.markTerminalNotice(rlmChildId, "sent");
		} catch (noticeError) {
			logger.warn("RLM terminal notice failed", { rlmChildId, error: String(noticeError) });
		}
	}

	listChildren(): RlmChildRegistryEntry[] {
		return this.#deps.registry.snapshotEntries();
	}

	async deleteChild(target: string): Promise<void> {
		try {
			await this.#deps.registry.deleteDirectChild(target, "user requested deletion");
		} catch (error) {
			logger.warn("RLM child deletion failed", { target, error: String(error) });
			throw error;
		}
	}

	async refreshAgents(): Promise<void> {
		if (!this.#messages) throw new Error("RLM agent_message is not available in this session");
		await this.#messages.refresh();
	}

	listAgents(): AgentMessageTarget[] {
		if (!this.#messages) throw new Error("RLM agent_message is not available in this session");
		return this.#messages.listAgents();
	}

	async sendMessage(message: string, options: AgentMessageSendOptions): Promise<AgentMessageReceipt> {
		if (!this.#messages) throw new Error("RLM agent_message is not available in this session");
		await this.#messages.refresh();
		return await this.#messages.send(message, options);
	}

	async broadcastMessage(message: string): Promise<AgentMessageReceipt[]> {
		if (!this.#messages) throw new Error("RLM agent_message is not available in this session");
		await this.#messages.refresh();
		return await this.#messages.broadcast(message);
	}
}

export function createRlmLifecycle(deps: RlmBridgeDeps): RlmChildLifecycle {
	return new RlmBridge(deps);
}
