type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OMP_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// electron-builder has no OMP update provider, so native update actions must stay unavailable.
export const UPDATER_ENABLED = false
