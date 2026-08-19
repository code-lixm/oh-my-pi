import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Agent, Config, Project, ProviderListResponse } from "@/omp/types"
import type { CommandInfo, ReferenceApi } from "@/omp/api"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { OmpWebApi } from "@/utils/omp-api"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const emptyProviderList = { all: [], connected: [], default: {} } satisfies ProviderListResponse
const api = {
  agent: { list: async () => [] },
  command: { list: async () => [] },
  provider: { list: async () => emptyProviderList },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  reference: { list: async () => ({ location: {}, data: [] }) },
  session: { get: async () => ({ id: "unused" }) },
  runtime: {
    globalConfig: async () => ({}),
    config: async () => ({}),
    path: async () => ({ state: "", config: "", worktree: "/project", directory: "/project", home: "/home" }),
    sessionStatuses: async () => ({}),
    permissions: async () => [],
    questions: async () => [],
    mcpStatuses: async () => ({}),
    mcpResources: async () => ({}),
    lsp: async () => [],
    vcs: async () => ({}),
  },
} as unknown as OmpWebApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("refreshes OMP directory config and MCP resources", async () => {
    const configReads: string[] = []
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      api: {
        ...api,
        command: {
          list: async () => {
            mcpReads.push("command")
            return []
          },
        },
        runtime: {
          ...api.runtime,
          config: async () => {
            configReads.push("directory")
            return {}
          },
          mcpStatuses: async () => {
            mcpReads.push("status")
            return {}
          },
          mcpResources: async () => {
            mcpReads.push("resource")
            return {}
          },
        },
      } as unknown as OmpWebApi,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(configReads).toEqual(["directory"])
    expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
  })

})

describe("config queries", () => {

  test("loads OMP global config", async () => {
    const config = { shell: "zsh" } satisfies Config
    const api = {
      runtime: { globalConfig: async () => config },
    } as Pick<OmpWebApi, "runtime">

    const result = await new QueryClient().fetchQuery(loadGlobalConfigQuery(ServerScope.local, api))

    expect(result).toEqual(config)
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as { provider: Pick<OmpWebApi["provider"], "list"> }
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual([
      "local",
      "/repo",
      "path",
    ])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual([
      "https://debian.example",
      "/repo",
      "path",
    ])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads an OMP provider catalog from one location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const model = {
      id: "gpt-5",
      providerID: "openai",
      api: { id: "openai", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
      name: "GPT-5",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      limit: { context: 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-08-01",
      variants: { high: {} },
    } satisfies ProviderListResponse["all"][number]["models"][string]
    const response = {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          source: "api",
          env: [],
          options: {},
          models: { "gpt-5": model },
        },
      ],
      default: { openai: "gpt-5" },
      connected: ["openai"],
    } satisfies ProviderListResponse
    const api = {
      provider: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return response
        },
      },
    } as { provider: Pick<OmpWebApi["provider"], "list"> }

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([["provider", { location: { directory: "/repo" } }]])
    expect(result.connected).toEqual(response.connected)
    expect(result.default).toEqual(response.default)
    expect(result.all).toEqual(new Map([["openai", response.all[0]!]]))
  })

  test("loads raw OMP agents from the location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const agents = [{ name: "build", mode: "primary", permission: [], options: {} }] satisfies Agent[]
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return agents
      },
    } as Pick<OmpWebApi["agent"], "list">

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual(agents)
  })

  test("loads raw OMP commands from the location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const commands = [{ name: "review", template: "Review files" }] satisfies CommandInfo[]
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return commands
      },
    } as Pick<OmpWebApi["command"], "list">

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual(commands)
  })

  test("loads OMP projects from the endpoint", async () => {
    const api = {
      list: async () => [
        { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as OmpWebApi["project"]

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("loads OMP references from the location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
