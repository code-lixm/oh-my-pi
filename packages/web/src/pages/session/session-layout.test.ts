import { afterEach, describe, expect, test, vi } from "bun:test"
import * as router from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import * as sdkCtx from "@/context/sdk"
import * as serverSdkCtx from "@/context/server-sdk"
import type { Accessor } from "solid-js"
import type { DirectorySDK } from "@/context/sdk"
import type { ServerSDK } from "@/context/server-sdk"
import { useSessionKey } from "./session-layout"

const dirB64 = base64Encode("/work")

type Stub = {
  sdk?: () => unknown
  serverSdk?: () => unknown
  id?: string
}

function stub(overrides: Stub) {
  vi.spyOn(router, "useParams").mockReturnValue({ id: overrides.id ?? "session-a" })
  vi.spyOn(sdkCtx, "useSDK").mockReturnValue(
    (overrides.sdk ?? (() => undefined)) as unknown as Accessor<DirectorySDK>,
  )
  vi.spyOn(serverSdkCtx, "useServerSDK").mockReturnValue(
    (overrides.serverSdk ?? (() => undefined)) as unknown as Accessor<ServerSDK>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe("useSessionKey", () => {
  test("derives the session and workspace keys from the directory-scoped SDK", () => {
    stub({ sdk: () => ({ directory: "/work" }), serverSdk: () => ({ scope: "local" }) })
    const { sessionKey, workspaceKey } = useSessionKey()
    expect(String(sessionKey())).toBe(`local\u0000${dirB64}/session-a`)
    expect(String(workspaceKey())).toBe(`local\u0000${dirB64}`)
  })

  test("does not throw and falls back to a bare route key when the SDK accessor returns undefined", () => {
    stub({ sdk: () => undefined, serverSdk: () => ({ scope: "local" }) })
    const { sessionKey } = useSessionKey()
    expect(() => sessionKey()).not.toThrow()
    expect(String(sessionKey())).toBe(`local\u0000/session-a`)
  })

  test("does not throw when the server SDK accessor throws", () => {
    stub({
      sdk: () => ({ directory: "/work" }),
      serverSdk: () => {
        throw new Error("no server")
      },
    })
    const { sessionKey } = useSessionKey()
    expect(() => sessionKey()).not.toThrow()
    expect(String(sessionKey())).toBe(`local\u0000${dirB64}/session-a`)
  })
})
