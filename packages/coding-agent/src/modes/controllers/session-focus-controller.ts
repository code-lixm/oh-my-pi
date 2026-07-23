/**
 * SessionFocusController - Weak retargeting primitive between the rendering/
 * input layer and the AgentSession it displays.
 *
 * Focusing re-points the transcript, streaming event subscription, status
 * line, and editor prompt/interrupt at a subagent's live AgentSession (from
 * AgentRegistry) without touching the main session underneath; unfocusing
 * re-attaches the main session and rebuilds the transcript from its
 * authoritative state.
 */

import { tSettingsUi } from "../../i18n/settings-locale";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext } from "../types";
export class SessionFocusController {
	#focusedAgentId: string | undefined;
	/** Session currently attached while focused; undefined when unfocused. */
	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}

	/** Focus a live agent in the fullscreen read-only transcript view. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const ref = this.registry.get(id);
		if (!ref?.session || (ref.status !== "running" && ref.status !== "idle")) {
			throw new Error(tSettingsUi("Agent {id} is not live", { id }));
		}
		const session = ref.session;
		if (id === this.#focusedAgentId && session === this.#attachedSession) return;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(event => this.#onRegistryEvent(event));
		await this.#attach(session);
		this.ctx.showFocusedAgentView(id);
	}

	/** Cycle through live subagents in stable creation order. Main is reached only via Esc. */
	async cycleAgent(direction: "next" | "previous"): Promise<void> {
		const agentIds = this.registry
			.list()
			.filter(ref => ref.kind === "sub" && ref.session && (ref.status === "running" || ref.status === "idle"))
			.sort((left, right) => left.createdAt - right.createdAt)
			.map(ref => ref.id);
		if (agentIds.length === 0) {
			this.ctx.showStatus(tSettingsUi("No live subagents"));
			return;
		}

		const currentIndex = this.#focusedAgentId ? agentIds.indexOf(this.#focusedAgentId) : -1;
		const targetIndex =
			currentIndex < 0
				? direction === "next"
					? 0
					: agentIds.length - 1
				: (currentIndex + (direction === "next" ? 1 : -1) + agentIds.length) % agentIds.length;
		return this.focusAgent(agentIds[targetIndex]!);
	}

	/** Focus the focused agent's parent agent, falling back to the main session. No-op when unfocused. */
	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.registry.get(parentId)) {
			return this.focusAgent(parentId);
		}
		return this.unfocus();
	}

	/** Return to the main session. No-op when unfocused. */
	async unfocus(): Promise<void> {
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		await this.#attach(this.ctx.session);
		this.ctx.hideFocusedAgentView();
		this.ctx.showStatus(tSettingsUi("Returned to main session"));
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const detached =
			event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !detached) return;
		void this.unfocus().then(() => {
			this.ctx.showStatus(
				tSettingsUi("Agent {id} is {status}; returned to main session", {
					id: event.ref.id,
					status: gone ? "gone" : event.ref.status,
				}),
			);
		});
	}

	/** Retarget core, both directions: swap subscription, transcript, and status line onto `target`. */
	async #attach(target: AgentSession): Promise<void> {
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		// Orphan-delta guard: when attaching mid-turn the message_start for the
		// in-flight assistant message predates the attach. message_update carries
		// the full accumulating message, so synthesize the missing start before
		// the first orphaned update; every other handler is tolerant of unknown
		// anchors (guarded by streamingComponent/pendingTools lookups).
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
			}
			await this.ctx.eventController.handleEvent(event);
		});
		const focusedRef = this.#focusedAgentId ? this.registry.get(this.#focusedAgentId) : undefined;
		this.ctx.statusLine.setSession(target, this.#focusedAgentId, focusedRef?.displayName);
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		// Mid-turn attach: no agent_start will arrive; arm the loader/turn state manually.
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
