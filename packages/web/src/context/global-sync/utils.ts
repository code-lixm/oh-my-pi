import type { PermissionV2Request } from "@/omp/api"
import type { Agent, PermissionRequest, Project, ProviderListResponse } from "@/omp/types"
import type { Project as CurrentProject } from "@/omp/api"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeAgentList(input: Agent[] | null | undefined): Agent[] {
  return Array.isArray(input) ? input : []
}

export function normalizePermissionRequest(input: PermissionV2Request | PermissionRequest): PermissionRequest {
  if ("permission" in input) return input
  return {
    id: input.id,
    sessionID: input.sessionID,
    permission: input.action,
    patterns: input.resources,
    always: input.save ?? [],
    metadata: input.metadata ?? {},
    tool:
      input.source?.type === "tool" ? { messageID: input.source.messageID, callID: input.source.callID } : undefined,
  }
}

export function normalizeProviderList(providers: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...providers,
    all: new Map(
      providers.all.map((provider) => [
        provider.id,
        {
          ...provider,
          models: Object.fromEntries(
            Object.entries(provider.models).filter(([, model]) => model.status !== "deprecated"),
          ),
        },
      ]),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}

export function normalizeProjectInfo(project: Project | CurrentProject): Project {
  return {
    ...project,
    vcs: project.vcs === "git" ? "git" : undefined,
  }
}
