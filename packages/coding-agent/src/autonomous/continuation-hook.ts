import type { AutonomousContinuationProvider } from "../prime-integration/contracts";
import type { AutonomousController } from "./controller";

/**
 * Creates the adapter injected by AgentSession. The controller remains owned by
 * the session persistence layer, so this provider carries no cross-session state.
 */
export function createAutonomousProvider(controller: AutonomousController): AutonomousContinuationProvider {
	return {
		get state() {
			return controller.state;
		},
		checkContinuation(lastMessage, options) {
			return controller.checkContinuation(lastMessage, options);
		},
	};
}
