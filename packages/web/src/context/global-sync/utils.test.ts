import { describe, expect, test } from "bun:test"
import type { Agent, ProviderListResponse } from "@/omp/types"

import { directoryKey, normalizeAgentList, normalizePermissionRequest, normalizeProviderList } from "./utils"

describe("normalizeAgentList", () => {
  test("preserves raw OMP agents", () => {
    const agents = [
      {
        name: "build",
        mode: "primary",
        permission: [],
        options: {},
      },
    ] satisfies Agent[]

    expect(normalizeAgentList(agents)).toEqual(agents)
  })
  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats a %s SDK agent payload as an empty agent list", (_name, payload) => {
    expect(normalizeAgentList(payload)).toEqual([])
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    expect(
      normalizePermissionRequest({
        id: "permission-1",
        sessionID: "session-1",
        action: "read",
        resources: ["README.md"],
        save: ["*.md"],
        metadata: { path: "README.md" },
        source: { type: "tool", messageID: "message-1", callID: "call-1" },
      }),
    ).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("normalizes a complete OMP provider response", () => {
    const activeModel = {
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
      id: "openai",
      name: "OpenAI",
      source: "api",
      env: [],
      options: {},
      models: {
        "gpt-5": activeModel,
        "gpt-old": { ...activeModel, id: "gpt-old", name: "GPT Old", status: "deprecated" },
      },
    } satisfies ProviderListResponse["all"][number]
    const response = {
      all: [provider],
      default: { openai: "gpt-5" },
      connected: ["openai"],
    } satisfies ProviderListResponse

    const result = normalizeProviderList(response)

    expect(result.all).toEqual(new Map([["openai", { ...provider, models: { "gpt-5": activeModel } }]]))
    expect(result.default).toEqual(response.default)
    expect(result.connected).toEqual(response.connected)
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
