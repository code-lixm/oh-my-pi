import type {
  Config,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@/omp/types"
import type {
  CommandInfo,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  ProjectListOutput,
  ReferenceListInput,
  ReferenceListOutput,
  SessionApi,
} from "@/omp/api"
import type { OmpWebApi } from "@/utils/omp-api"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import {
  cmp,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProjectInfo,
  normalizeProviderList,
} from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { normalizeSessionInfo } from "@/utils/session"
import type { ServerApi } from "@/utils/server"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, api: Pick<OmpWebApi, "runtime">) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () => retry(() => api.runtime.globalConfig()),
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
  readonly current: (input?: ProjectCurrentInput) => Promise<ProjectCurrentOutput>
}

type McpApi = ServerApi["mcp"]
type PermissionApi = ServerApi["permission"]
type QuestionApi = ServerApi["question"]
type VcsApi = ServerApi["vcs"]

export const loadProjectsQuery = (scope: ServerScope, api: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        api.list().then((projects) => {
          return projects
            .filter((p) => !!p?.id)
            .map(normalizeProjectInfo)
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  api: OmpWebApi
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.api)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.api)),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.api)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.api.project))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  api: SessionApi
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.api.get({ sessionID })).then((session) =>
        mergeSession(input.setStore, normalizeSessionInfo(session)),
      ),
    ),
  ).then(() => undefined)
}

type ProviderListApi = Pick<OmpWebApi["provider"], "list">

export const loadProvidersQuery = (
  scope: ServerScope,
  directory: string | null,
  api: { provider: ProviderListApi },
) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: () =>
      retry(async () => {
        const location = directory ? { location: { directory } } : undefined
        return normalizeProviderList(await api.provider.list(location))
      }),
  })

type AgentListApi = Pick<OmpWebApi["agent"], "list">

type CommandListApi = Pick<OmpWebApi["command"], "list">

type ReferenceListApi = {
  readonly list: (input?: ReferenceListInput) => Promise<ReferenceListOutput>
}

export const loadAgentsQuery = (scope: ServerScope, directory: string, api: AgentListApi) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () =>
      retry(() => api.list({ location: { directory } }).then((result) => normalizeAgentList(result))),
  })

export const loadCommands = (directory: string, api: CommandListApi): Promise<CommandInfo[]> =>
  retry(() => api.list({ location: { directory } }))

export const loadPathQuery = (scope: ServerScope, directory: string | null, api: Pick<OmpWebApi, "runtime">) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () => retry(() => api.runtime.path({ directory: directory ?? undefined })),
  })

export const loadReferencesQuery = (scope: ServerScope, directory: string, api: ReferenceListApi) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () =>
      retry(() => api.list({ location: { directory } }).then((result) => result.data)).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  api: OmpWebApi
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  ;(async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient
          .ensureQueryData(loadAgentsQuery(input.scope, input.directory, input.api.agent))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(() =>
          input.api.runtime
            .config({ directory: input.directory })
            .then((config) => input.setStore("config", reconcile(config, { merge: false }))),
        ),
      () =>
        retry(async () => {
          const statuses = await input.api.runtime.sessionStatuses({ directory: input.directory })
          if (!input.session) {
            input.setStore("session_status", statuses)
            return
          }
          input.session.set(
            "session_status",
            produce((draft) => {
              for (const sessionID of Object.keys(draft)) {
                if (statuses[sessionID]) continue
                if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
              }
            }),
          )
          for (const [sessionID, status] of Object.entries(statuses)) {
            input.session.set("session_status", sessionID, reconcile(status))
          }
        }),
      !seededProject &&
        (() =>
          retry(() => input.api.project.current({ location: { directory: input.directory } })).then((project) =>
            input.setStore("project", project.id),
          )),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(loadPathQuery(input.scope, input.directory, input.api)).then((data) => {
            const next = projectID(data.directory ?? input.directory, input.global.project)
            if (next) input.setStore("project", next)
          })),
      () =>
        retry(() =>
          input.api.runtime.vcs({ directory: input.directory }).then((next) => {
            input.setStore("vcs", next)
            input.vcsCache.setStore("value", next)
          }),
        ),
      input.mcp &&
        (() =>
          loadCommands(input.directory, input.api.command).then((commands) => input.setStore("command", commands))),
      () => input.queryClient.fetchQuery(loadReferencesQuery(input.scope, input.directory, input.api.reference)),
      () =>
        retry(() =>
          input.api.runtime.permissions({ directory: input.directory }).then((permissions) => {
            const ids = permissions.map((permission) => permission.sessionID)
            const grouped = groupBySession(
              permissions.filter((permission) => !!permission.id && !!permission.sessionID),
            )
            const warm = input.session
              ? Promise.resolve()
              : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.api.runtime.questions({ directory: input.directory }).then((questions) => {
            const ids = questions.map((question) => question.sessionID)
            const grouped = groupBySession(
              questions.filter((question) => !!question.id && !!question.sessionID) as QuestionRequest[],
            )
            const warm = input.session
              ? Promise.resolve()
              : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
      () => Promise.resolve(input.loadSessions(input.directory)),
      input.mcp &&
        (() => input.queryClient.fetchQuery(loadMcpQuery(input.scope, input.directory, input.api))),
      input.mcp &&
        (() => input.queryClient.fetchQuery(loadMcpResourcesQuery(input.scope, input.directory, input.api))),
      () =>
        input.queryClient.fetchQuery(loadProvidersQuery(input.scope, input.directory, input.api)).catch((err) => {
          const project = getFilename(input.directory)
          showToast({
            variant: "error",
            title: input.translate("toast.project.reloadFailed.title", { project }),
            description: formatServerError(err, input.translate),
          })
        }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}
