export const OMP_WEB_PRODUCT = "oh-my-pi" as const
export const OMP_WEB_PROTOCOL = "omp-web/v1" as const

export type OmpWebCapabilities = {
  providerWrite: boolean
  mcpWrite: boolean
  settingsRead: boolean
  settingsWrite: boolean
  pluginRead: boolean
  pluginWrite: boolean
  projectMetadataWrite: boolean
  sessionArchive: boolean
  workspaceWrite: boolean
  sessionFork: boolean
  sessionRevert: boolean
  sessionShare: boolean
  nativeSessionRpc: boolean
}

export const OMP_WEB_CAPABILITIES: OmpWebCapabilities = {
  providerWrite: false,
  mcpWrite: true,
  settingsRead: true,
  settingsWrite: true,
  pluginRead: true,
  pluginWrite: true,
  projectMetadataWrite: false,
  sessionArchive: false,
  workspaceWrite: false,
  sessionFork: false,
  sessionRevert: false,
  sessionShare: false,
  nativeSessionRpc: true,
}

export const OMP_WEB_NATIVE_SESSION_ROUTES = {
  snapshot: { method: "GET", path: "/session/:id/omp" },
  shell: { method: "POST", path: "/session/:id/shell" },
  abortBash: { method: "POST", path: "/session/:id/omp/bash/abort" },
  checkpoints: { method: "GET|POST", path: "/session/:id/omp/checkpoints" },
  previewCheckpointRestore: { method: "POST", path: "/session/:id/omp/checkpoints/preview" },
  applyCheckpointRestore: { method: "POST", path: "/session/:id/omp/checkpoints/apply" },
  undoWorkspace: { method: "POST", path: "/session/:id/omp/checkpoints/undo" },
  redoWorkspace: { method: "POST", path: "/session/:id/omp/checkpoints/redo" },
  jobsCancel: { method: "POST", path: "/session/:id/omp/jobs/cancel" },
  branch: { method: "GET|POST", path: "/session/:id/omp/branch" },
  handoff: { method: "POST", path: "/session/:id/omp/handoff" },
  export: { method: "GET", path: "/session/:id/omp/export" },
  login: { method: "POST", path: "/session/:id/omp/login" },
} as const

export type OmpWebNativeSessionRoute = keyof typeof OMP_WEB_NATIVE_SESSION_ROUTES

export type OmpWebHealth = {
  healthy: true
  product: typeof OMP_WEB_PRODUCT
  protocol: typeof OMP_WEB_PROTOCOL
  version: string
  pid: number
  capabilities: OmpWebCapabilities
}
