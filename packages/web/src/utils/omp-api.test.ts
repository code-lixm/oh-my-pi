import { describe, expect, test } from "bun:test"
import type { Agent, ProviderListResponse } from "@/omp/types"
import { createOmpApiTransportForServer, createOmpTransportForServer } from "./server"
import { createOmpApi } from "./omp-api"

type CatalogResponses = {
  provider: ProviderListResponse
  agents: unknown[]
  commands: unknown[]
}

function setup(responses?: { vcs?: { branch: string; default_branch: string }; catalog?: CatalogResponses }) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          data: { text: "hello" },
          delivery: "steer",
        })
      }
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/vcs") return Response.json(responses?.vcs ?? {})
      if (request.method === "GET" && responses?.catalog) {
        if (url.pathname === "/api/omp/provider") return Response.json(responses.catalog.provider)
        if (url.pathname === "/api/omp/agent") return Response.json(responses.catalog.agents)
        if (url.pathname === "/api/omp/command") return Response.json(responses.catalog.commands)
      }
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createOmpApi({
    current: createOmpApiTransportForServer({ server, fetch: fetcher }),
    transport: (directory) => createOmpTransportForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

describe("createOmpApi", () => {

  test("converts prompts to the OMP transport contract", async () => {
    const { api, requests } = setup()
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/omp/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves transport parts for OMP optimistic reconciliation", async () => {
    const { api, requests } = setup()
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      transportParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })


  test("uses the OMP session search endpoint", async () => {
    const { api, requests } = setup()
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/omp/experimental/session")
  })


  test("translates OMP file searches to the transport dirs parameter", async () => {
    const { api, requests } = setup()
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/api/omp/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes OMP permission replies through the requested directory", async () => {
    const { api, requests } = setup()
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/omp/session/ses_1/permissions/permission_1")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
  })

  test("returns raw OMP catalog view-models for location-scoped endpoints", async () => {
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
    const provider = {
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
    const agents = [{ name: "build", mode: "primary", permission: [], options: {} }] satisfies Agent[]
    const commands = [{ name: "review", template: "Review files", hints: [] }]
    const { api, requests } = setup({ catalog: { provider, agents, commands } })
    const location = { location: { directory: "/workspace" } }

    expect(await api.provider.list(location)).toEqual(provider)
    expect(await api.agent.list(location)).toEqual(agents)
    expect(await api.command.list(location)).toEqual([{ name: "review", template: "Review files" }])

    const urls = requests.map((request) => new URL(request.url))
    expect(urls.map((url) => url.pathname)).toEqual([
      "/api/omp/provider",
      "/api/omp/agent",
      "/api/omp/command",
    ])
    expect(urls.map((url) => url.searchParams.get("directory"))).toEqual(["/workspace", "/workspace", "/workspace"])
  })

})
