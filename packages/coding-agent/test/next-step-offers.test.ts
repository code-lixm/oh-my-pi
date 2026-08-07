import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { type NextStepOffer, NextStepOfferStore } from "@oh-my-pi/pi-coding-agent/session/next-step-offers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface MutableIdentity {
	sessionId: string;
	branchId: string;
	modelId: string;
}

interface MutableClock {
	now: number;
}

const OFFERS: NextStepOffer[] = [
	{
		id: "commit-current-change",
		label: "Commit the current change",
		description: "Create a local commit after the user reviews the diff.",
		requiresConfirmation: true,
	},
	{
		id: "build-local-cli",
		label: "Build the local CLI",
		requiresConfirmation: false,
	},
];

/**
 * The session store is the product boundary for structured handoff offers:
 * tools may record offers, but only this state machine decides whether a later
 * bare number becomes an explicit user choice.
 */
describe("structured next-step offer lifecycle", () => {
	let tempDir: TempDir;
	let identity: MutableIdentity;
	let clock: MutableClock;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-next-step-offers-");
		identity = {
			sessionId: "session-a",
			branchId: "branch-a",
			modelId: "openai-codex/gpt-5.6-terra",
		};
		clock = { now: 1_000 };
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	function createStore(sessionManager: SessionManager): NextStepOfferStore {
		return new NextStepOfferStore({
			sessionManager,
			getIdentity: () => ({ ...identity }),
			now: () => clock.now,
		});
	}

	function record(store: NextStepOfferStore, finalId = "final-a", expiresAt = 2_000): void {
		store.recordSuccessfulFinal({
			assistantMessageId: finalId,
			offers: OFFERS,
			expiresAt,
		});
	}

	it("persists only the latest successful final offer and restores it for the same session identity", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"));
		identity.sessionId = manager.getSessionId();
		const first = createStore(manager);
		record(first, "final-one");
		first.recordSuccessfulFinal({
			assistantMessageId: "final-two",
			offers: [OFFERS[1]!],
			expiresAt: 2_000,
		});
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
		const resumed = createStore(resumedManager);
		const selected = resumed.resolveBareNumber("1");
		if (!selected) throw new Error("Expected the restored latest offer to resolve");

		expect(selected.offer).toEqual(OFFERS[1]);
		expect(selected.userMessage).toContain("Build the local CLI");
		expect(resumed.resolveBareNumber("2")).toBeUndefined();
	});

	it("keeps forced invalidation on a selected skill leaf across reload without reviving its ancestor offer", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"));
		identity.sessionId = manager.getSessionId();
		const store = createStore(manager);

		manager.appendMessage({ role: "user", content: "anchor", timestamp: clock.now });
		record(store, "final-on-ancestor");
		const customTargetId = manager.appendCustomMessageEntry(
			SKILL_PROMPT_MESSAGE_TYPE,
			"<skill>Apply the selected workflow.</skill>",
			true,
			{ name: "workflow", path: "/skills/workflow/SKILL.md", lineCount: 1 },
			"user",
		);

		// This creates an ordinary inactive child before returning to the semantic leaf.
		store.invalidate();
		manager.branch(customTargetId);
		store.invalidate({ forcePersist: true });

		expect(manager.getLeafId()).toBe(customTargetId);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		const resumedManager = await SessionManager.open(sessionFile, tempDir.path());
		expect(resumedManager.getLeafId()).toBe(customTargetId);

		const resumed = createStore(resumedManager);
		expect(resumed.resolveBareNumber("1")).toBeUndefined();
	});

	it("records at most three structured choices and clears an earlier offer when a later final has none", () => {
		const store = createStore(SessionManager.inMemory());

		expect(() =>
			store.recordSuccessfulFinal({
				assistantMessageId: "too-many",
				offers: [
					...OFFERS,
					{ id: "deploy", label: "Deploy", requiresConfirmation: true },
					{ id: "release", label: "Release", requiresConfirmation: true },
				],
				expiresAt: 2_000,
			}),
		).toThrow();

		record(store);
		store.recordSuccessfulFinal({ assistantMessageId: "final-without-offers", offers: [], expiresAt: 2_000 });
		expect(store.resolveBareNumber("1")).toBeUndefined();
	});

	it("rewrites a valid bare number into explicit user intent and consumes the offer without executing it", () => {
		const store = createStore(SessionManager.inMemory());
		record(store);

		const selection = store.resolveBareNumber("1");
		if (!selection) throw new Error("Expected a valid offer selection");

		expect(selection.offer).toEqual(OFFERS[0]);
		expect(selection.userMessage).toContain("selected the most recent suggested next step");
		expect(selection.userMessage).toContain("Commit the current change");
		expect(selection.offer.requiresConfirmation).toBe(true);
		// The resolver returns text for the ordinary prompt/approval pipeline; it
		// neither contains an executable command nor invokes a tool itself.
		expect(selection.userMessage).not.toContain("xd://");
		expect(store.resolveBareNumber("1")).toBeUndefined();
	});

	it("does not capture ordinary numeric text or malformed numeric input", () => {
		const store = createStore(SessionManager.inMemory());
		record(store);

		for (const input of ["0", "01", "-1", "1.0", "1 ", " 1", "1\n", "1 files changed", "999"]) {
			expect(store.resolveBareNumber(input), input).toBeUndefined();
		}
		// A rejected parse is not itself a choice. The prompt flow separately calls
		// noteUserMessage for an actual non-bare user turn, which invalidates it.
		expect(store.resolveBareNumber("2")?.offer.id).toBe("build-local-cli");
	});

	it("expires an offer at its explicit expiry boundary", () => {
		const store = createStore(SessionManager.inMemory());
		record(store, "final-a", 1_001);

		clock.now = 1_001;
		expect(store.resolveBareNumber("1")).toBeUndefined();
	});

	it("invalidates on a substantive intervening user turn but not while parsing a valid selection", () => {
		const store = createStore(SessionManager.inMemory());
		record(store);

		store.noteUserMessage("Please explain the risk first.");
		expect(store.resolveBareNumber("1")).toBeUndefined();
	});

	it("invalidates when the selected model, session, or branch changes", () => {
		const invalidators: Array<{ name: string; mutate: () => void }> = [
			{
				name: "model switch",
				mutate: () => {
					identity.modelId = "openai-codex/gpt-5.6-sol";
				},
			},
			{
				name: "session switch",
				mutate: () => {
					identity.sessionId = "session-b";
				},
			},
			{
				name: "branch switch",
				mutate: () => {
					identity.branchId = "branch-b";
				},
			},
		];

		for (const { name, mutate } of invalidators) {
			identity = {
				sessionId: "session-a",
				branchId: "branch-a",
				modelId: "openai-codex/gpt-5.6-terra",
			};
			const store = createStore(SessionManager.inMemory());
			record(store);
			mutate();
			expect(store.resolveBareNumber("1"), name).toBeUndefined();
		}
	});

	it("keeps an offer only across compaction that explicitly preserves its metadata", () => {
		const preserved = createStore(SessionManager.inMemory());
		record(preserved);
		preserved.afterCompaction({ metadataPreserved: true });
		expect(preserved.resolveBareNumber("2")?.offer.id).toBe("build-local-cli");

		const dropped = createStore(SessionManager.inMemory());
		record(dropped);
		dropped.afterCompaction({ metadataPreserved: false });
		expect(dropped.resolveBareNumber("2")).toBeUndefined();
	});
});
