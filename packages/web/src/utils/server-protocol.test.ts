import { describe, expect, test } from "bun:test"
import { detectServerContract, detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const ompCapabilities = {
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
} as const

const ompHealth = (overrides: Record<string, unknown> = {}) => ({
  healthy: true,
  product: "oh-my-pi",
  protocol: "omp-web/v1",
  version: "2.0.0",
  pid: 123,
  capabilities: ompCapabilities,
  ...overrides,
})

const healthFetcher = (health: unknown) =>
  Object.assign(
    (input: string | URL | Request) => {
      const pathname = new URL(input instanceof Request ? input.url : input).pathname
      return Promise.resolve(pathname === "/api/health" ? json(health) : json({}, 404))
    },
    { preconnect: globalThis.fetch.preconnect },
  )

describe("OMP Web health admission", () => {
  test("accepts exact OMP health and exposes every capability", async () => {
    expect(await detectServerProtocol(server, healthFetcher(ompHealth()))).toBe("omp-web/v1")
    expect(await detectServerContract(server, healthFetcher(ompHealth()))).toEqual({
      protocol: "omp-web/v1",
      capabilities: ompCapabilities,
    })
  })

  const missingProduct: Record<string, unknown> = { ...ompHealth() }
  delete missingProduct.product
  const missingProtocol: Record<string, unknown> = { ...ompHealth() }
  delete missingProtocol.protocol

  for (const { name, health } of [
    { name: "a non-OMP product marker", health: ompHealth({ product: "opencode" }) },
    { name: "a missing product marker", health: missingProduct },
    { name: "a missing protocol marker", health: missingProtocol },
    { name: "a non-OMP protocol marker", health: ompHealth({ protocol: "unsupported-protocol" }) },
  ]) {
    test(`rejects ${name}`, async () => {
      await expect(detectServerContract(server, healthFetcher(health))).rejects.toThrow(
        "This UI requires an OMP Web server",
      )
    })
  }

  test("rejects health that omits an explicit capability", async () => {
    const incompleteCapabilities: Record<string, unknown> = { ...ompCapabilities }
    delete incompleteCapabilities.sessionShare

    await expect(
      detectServerContract(server, healthFetcher(ompHealth({ capabilities: incompleteCapabilities }))),
    ).rejects.toThrow("OMP Web health has invalid capability: sessionShare")
  })
})
