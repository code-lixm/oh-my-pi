import { prompt } from "@oh-my-pi/pi-utils";
import { selectPrompt } from "../prompts/prompt-locale";
import nextStepSelectionPrompt from "../prompts/system/next-step-selection.md" with { type: "text" };
import nextStepSelectionPromptZh from "../prompts/system/next-step-selection.zh-CN.md" with { type: "text" };
import type { SessionEntry } from "./session-entries";

/** Custom-entry discriminator for structured next-step offer state. */
export const NEXT_STEP_OFFER_CUSTOM_TYPE = "next_step_offer_state";

/** Default lifetime for a structured offer recorded by the local offer tool. */
export const DEFAULT_NEXT_STEP_OFFER_TTL_MS = 30 * 60_000;

const NEXT_STEP_OFFER_STATE_VERSION = 1;
const MAX_NEXT_STEP_OFFERS = 3;
const OFFER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Stable, user-selectable next action offered after a successful final response. */
export interface NextStepOffer {
	id: string;
	label: string;
	description?: string;
	requiresConfirmation: boolean;
}

/** Immutable session/model/branch context in which an offer was created. */
export interface NextStepOfferIdentity {
	sessionId: string;
	branchId: string;
	modelId: string;
}

/** A safe rewrite of a valid bare-number selection into explicit user intent. */
export interface NextStepOfferSelection {
	offer: NextStepOffer;
	userMessage: string;
}

export interface RecordSuccessfulFinalOptions {
	assistantMessageId: string;
	offers: readonly NextStepOffer[];
	expiresAt: number;
}

export interface NextStepOfferStoreOptions {
	sessionManager: NextStepOfferSessionManager;
	getIdentity(): NextStepOfferIdentity;
	now?(): number;
}

/** Narrow SessionManager surface required by the offer lifecycle. */
export interface NextStepOfferSessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
	appendCustomEntryToBranch(customType: string, data: unknown, parentId: string | null): string;
	ensureOnDisk?(): Promise<void>;
	getBranch(): SessionEntry[];
	getEntries(): SessionEntry[];
	getLeafId(): string | null;
}

interface PersistedActiveOfferState {
	v: typeof NEXT_STEP_OFFER_STATE_VERSION;
	active: true;
	assistantMessageId: string;
	offers: NextStepOffer[];
	expiresAt: number;
	identity: NextStepOfferIdentity;
}

interface PersistedInactiveOfferState {
	v: typeof NEXT_STEP_OFFER_STATE_VERSION;
	active: false;
}

type PersistedOfferState = PersistedActiveOfferState | PersistedInactiveOfferState;

interface ActiveOfferState extends PersistedActiveOfferState {
	entryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneOffer(offer: NextStepOffer): NextStepOffer {
	return offer.description === undefined
		? { id: offer.id, label: offer.label, requiresConfirmation: offer.requiresConfirmation }
		: {
				id: offer.id,
				label: offer.label,
				description: offer.description,
				requiresConfirmation: offer.requiresConfirmation,
			};
}

function cloneIdentity(identity: NextStepOfferIdentity): NextStepOfferIdentity {
	return { sessionId: identity.sessionId, branchId: identity.branchId, modelId: identity.modelId };
}

function assertIdentity(identity: NextStepOfferIdentity): NextStepOfferIdentity {
	if (
		typeof identity.sessionId !== "string" ||
		identity.sessionId.length === 0 ||
		typeof identity.branchId !== "string" ||
		identity.branchId.length === 0 ||
		typeof identity.modelId !== "string" ||
		identity.modelId.length === 0
	) {
		throw new Error("Next-step offers require a concrete session, branch, and model identity.");
	}
	return cloneIdentity(identity);
}

function normalizeOffers(offers: readonly NextStepOffer[]): NextStepOffer[] {
	if (!Array.isArray(offers)) throw new Error("Next-step offers must be an array.");
	if (offers.length > MAX_NEXT_STEP_OFFERS) {
		throw new Error(`At most ${MAX_NEXT_STEP_OFFERS} next-step offers may be recorded.`);
	}

	const ids = new Set<string>();
	return offers.map(offer => {
		if (!isRecord(offer)) throw new Error("Each next-step offer must be an object.");
		const { id, label, description, requiresConfirmation } = offer;
		if (typeof id !== "string" || !OFFER_ID_PATTERN.test(id)) {
			throw new Error("Next-step offer ids must be stable kebab-case identifiers.");
		}
		if (ids.has(id)) throw new Error(`Duplicate next-step offer id: ${id}`);
		ids.add(id);
		if (typeof label !== "string" || label.trim().length === 0 || label !== label.trim()) {
			throw new Error("Next-step offer labels must be non-empty trimmed text.");
		}
		if (description !== undefined && (typeof description !== "string" || description.trim().length === 0)) {
			throw new Error("Next-step offer descriptions must be non-empty text when supplied.");
		}
		if (typeof requiresConfirmation !== "boolean") {
			throw new Error("Each next-step offer must declare requiresConfirmation.");
		}
		return description === undefined
			? { id, label, requiresConfirmation }
			: { id, label, description, requiresConfirmation };
	});
}

function parseIdentity(value: unknown): NextStepOfferIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const { sessionId, branchId, modelId } = value;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		typeof branchId !== "string" ||
		branchId.length === 0 ||
		typeof modelId !== "string" ||
		modelId.length === 0
	) {
		return undefined;
	}
	return { sessionId, branchId, modelId };
}

function parsePersistedState(value: unknown): PersistedOfferState | undefined {
	if (!isRecord(value) || value.v !== NEXT_STEP_OFFER_STATE_VERSION || typeof value.active !== "boolean")
		return undefined;
	if (value.active === false) return { v: NEXT_STEP_OFFER_STATE_VERSION, active: false };
	if (typeof value.assistantMessageId !== "string" || value.assistantMessageId.length === 0) return undefined;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return undefined;
	const identity = parseIdentity(value.identity);
	if (!identity || !Array.isArray(value.offers)) return undefined;
	try {
		const offers = normalizeOffers(value.offers as NextStepOffer[]);
		if (offers.length === 0) return undefined;
		return {
			v: NEXT_STEP_OFFER_STATE_VERSION,
			active: true,
			assistantMessageId: value.assistantMessageId,
			offers,
			expiresAt: value.expiresAt,
			identity,
		};
	} catch {
		return undefined;
	}
}

function sameIdentity(left: NextStepOfferIdentity, right: NextStepOfferIdentity): boolean {
	return left.sessionId === right.sessionId && left.branchId === right.branchId && left.modelId === right.modelId;
}

/**
 * Persisted state machine for structured final-response offers.
 *
 * Tool calls only stage offers. This store binds staged data to a later successful
 * final, owns invalidation, and returns a textual user-intent rewrite rather than
 * executing any suggestion.
 */
export class NextStepOfferStore {
	readonly #sessionManager: NextStepOfferSessionManager;
	readonly #getIdentity: () => NextStepOfferIdentity;
	readonly #now: () => number;
	#active: ActiveOfferState | undefined;
	#staged: NextStepOffer[] | undefined;
	#loadedLeaf: string | null | undefined;

	constructor(options: NextStepOfferStoreOptions) {
		this.#sessionManager = options.sessionManager;
		this.#getIdentity = options.getIdentity;
		this.#now = options.now ?? Date.now;
		this.refresh();
	}

	/** Reload active state from records belonging to the selected semantic branch. */
	refresh(): void {
		const branch = this.#sessionManager.getBranch();
		const branchIds = new Set(branch.map(entry => entry.id));
		const leafId = this.#sessionManager.getLeafId();
		this.#loadedLeaf = leafId;
		this.#active = undefined;
		for (const entry of this.#sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== NEXT_STEP_OFFER_CUSTOM_TYPE) continue;
			const attachedToBranch =
				entry.preserveLeaf === true && (entry.parentId === null ? leafId === null : branchIds.has(entry.parentId));
			if (!branchIds.has(entry.id) && !attachedToBranch) continue;
			const state = parsePersistedState(entry.data);
			// A malformed record is fail-closed: it must not revive an earlier offer.
			if (!state || state.active === false) {
				this.#active = undefined;
				continue;
			}
			this.#active = {
				...state,
				offers: state.offers.map(cloneOffer),
				identity: cloneIdentity(state.identity),
				entryId: entry.id,
			};
		}
	}

	/** Stage one tool call's offers until the containing assistant turn successfully finalizes. */
	stageOffers(offers: readonly NextStepOffer[]): void {
		const normalized = normalizeOffers(offers);
		if (normalized.length === 0) throw new Error("The next-step offer tool requires at least one offer.");
		this.#staged = normalized;
	}

	/** Discard unbound tool output from an interrupted or superseded assistant turn. */
	discardStagedOffers(): void {
		this.#staged = undefined;
	}

	/** Consume staged tool output exactly once when the matching final is known to be successful. */
	consumeStagedOffers(): NextStepOffer[] {
		const offers = this.#staged?.map(cloneOffer) ?? [];
		this.#staged = undefined;
		return offers;
	}

	/**
	 * Persist the only active offer set for a successfully completed final. An
	 * offer-less final explicitly clears prior choices rather than leaving them
	 * associated with stale assistant text.
	 */
	recordSuccessfulFinal(options: RecordSuccessfulFinalOptions): void {
		if (typeof options.assistantMessageId !== "string" || options.assistantMessageId.length === 0) {
			throw new Error("A successful final requires its persisted assistant message id.");
		}
		if (typeof options.expiresAt !== "number" || !Number.isFinite(options.expiresAt)) {
			throw new Error("A next-step offer expiry must be a finite timestamp.");
		}
		const offers = normalizeOffers(options.offers);
		this.#staged = undefined;
		if (offers.length === 0) {
			this.#clear(true);
			return;
		}

		const identity = assertIdentity(this.#getIdentity());
		const state: PersistedActiveOfferState = {
			v: NEXT_STEP_OFFER_STATE_VERSION,
			active: true,
			assistantMessageId: options.assistantMessageId,
			offers,
			expiresAt: options.expiresAt,
			identity,
		};
		const entryId = this.#appendState(state);
		this.#active = { ...state, offers: offers.map(cloneOffer), identity: cloneIdentity(identity), entryId };
		this.#loadedLeaf = this.#sessionManager.getLeafId();
	}

	/** Invalidate an active offer because the user sent a substantive non-selection turn. */
	noteUserMessage(_message?: string): void {
		this.#clear(true);
	}

	/** Invalidate staged/active state when lifecycle code changes session, branch, or model. */
	invalidate(options?: { forcePersist?: boolean }): void {
		this.#clear(true, options?.forcePersist === true);
	}

	/** Keep an offer only when compaction explicitly retained the custom metadata. */
	afterCompaction(options: { metadataPreserved: boolean }): void {
		this.#staged = undefined;
		if (!options.metadataPreserved) this.#clear(true);
	}

	/**
	 * Resolve exactly one safe bare decimal selection. The return value is ordinary
	 * user text for the existing prompt/approval pipeline; this method never invokes
	 * a tool or treats a selection as approval.
	 */
	resolveBareNumber(input: string): NextStepOfferSelection | undefined {
		if (!/^[1-9]\d*$/.test(input)) return undefined;
		const selectedIndex = Number(input) - 1;
		if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0) return undefined;

		this.#refreshIfBranchChanged();
		const active = this.#active;
		if (!active || !this.#isActiveForCurrentIdentity(active)) return undefined;
		if (this.#now() >= active.expiresAt) {
			this.#clear(true);
			return undefined;
		}
		const offer = active.offers[selectedIndex];
		if (!offer) return undefined;

		// Consume before returning text so a duplicate delivery cannot replay an offer.
		this.#clear(true);
		return {
			offer: cloneOffer(offer),
			userMessage: prompt.render(selectPrompt(nextStepSelectionPrompt, nextStepSelectionPromptZh), {
				label: offer.label,
				description: offer.description,
				requiresConfirmation: offer.requiresConfirmation,
			}),
		};
	}

	#refreshIfBranchChanged(): void {
		if (this.#sessionManager.getLeafId() !== this.#loadedLeaf) this.refresh();
	}

	#isActiveForCurrentIdentity(active: ActiveOfferState): boolean {
		const current = this.#getIdentity();
		if (!sameIdentity(active.identity, current)) {
			// Never append an invalidation into a newly selected session. The old
			// branch is no longer active and cannot be selected through this store.
			this.#clear(current.sessionId === active.identity.sessionId);
			return false;
		}
		const stillOnBranch = this.#sessionManager.getBranch().some(entry => entry.id === active.entryId);
		if (!stillOnBranch) {
			this.#clear(false);
			return false;
		}
		return true;
	}

	#appendState(state: PersistedOfferState, preserveLeaf = false): string {
		const entryId = preserveLeaf
			? this.#sessionManager.appendCustomEntryToBranch(
					NEXT_STEP_OFFER_CUSTOM_TYPE,
					state,
					this.#sessionManager.getLeafId(),
				)
			: this.#sessionManager.appendCustomEntry(NEXT_STEP_OFFER_CUSTOM_TYPE, state);
		const persisted = this.#sessionManager.ensureOnDisk?.();
		if (persisted) void persisted.catch(() => {});
		return entryId;
	}

	#clear(persist: boolean, forcePersist = false): void {
		this.#staged = undefined;
		const active = this.#active;
		this.#active = undefined;
		if (!persist || (!active && !forcePersist)) return;
		this.#appendState(
			{
				v: NEXT_STEP_OFFER_STATE_VERSION,
				active: false,
			} satisfies PersistedInactiveOfferState,
			forcePersist,
		);
		this.#loadedLeaf = this.#sessionManager.getLeafId();
	}
}

const stores = new WeakMap<object, NextStepOfferStore>();

/** Reuse one state machine for tools and the owning AgentSession sharing a manager. */
export function getNextStepOfferStore(options: NextStepOfferStoreOptions): NextStepOfferStore {
	const key = options.sessionManager as object;
	const existing = stores.get(key);
	if (existing) return existing;
	const store = new NextStepOfferStore(options);
	stores.set(key, store);
	return store;
}
