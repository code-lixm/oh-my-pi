import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController } from "./updater-controller"

export function setupAutoUpdater() {
  return createUpdaterController({ enabled: UPDATER_ENABLED })
}
