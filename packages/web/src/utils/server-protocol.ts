import {
  OMP_WEB_PRODUCT,
  OMP_WEB_PROTOCOL,
  type OmpWebCapabilities,
} from "../../shared/omp-web-contract"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type ServerProtocol = typeof OMP_WEB_PROTOCOL
export type ServerCapabilities = OmpWebCapabilities

export type ServerContract = {
  protocol: ServerProtocol
  capabilities: ServerCapabilities
}

const capabilityKeys = [
  "providerWrite",
  "mcpWrite",
  "settingsRead",
  "settingsWrite",
  "pluginRead",
  "pluginWrite",
  "projectMetadataWrite",
  "sessionArchive",
  "workspaceWrite",
  "sessionFork",
  "sessionRevert",
  "sessionShare",
] as const satisfies readonly (keyof ServerCapabilities)[]

function serverCapabilities(value: object): ServerCapabilities {
  if (!("capabilities" in value) || !value.capabilities || typeof value.capabilities !== "object") {
    throw new Error("OMP Web health is missing capabilities")
  }
  const result = {} as ServerCapabilities
  for (const key of capabilityKeys) {
    const capability = Reflect.get(value.capabilities, key)
    if (typeof capability !== "boolean") throw new Error(`OMP Web health has invalid capability: ${key}`)
    result[key] = capability
  }
  return result
}

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

export async function requestServerJson<T>(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const requestHeaders = new Headers(init.headers)
  const auth = headers(server)
  if (auth) requestHeaders.set("Authorization", auth.Authorization)
  const response = await fetch(new URL(path, server.url), { ...init, headers: requestHeaders })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined)
    const message =
      payload &&
      typeof payload === "object" &&
      "data" in payload &&
      payload.data &&
      typeof payload.data === "object" &&
      "message" in payload.data &&
      typeof payload.data.message === "string"
        ? payload.data.message
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

async function probe(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch, path: string) {
  const response = await fetch(new URL(path, server.url), {
    headers: headers(server),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const value: unknown = await response.json()
  if (!value || typeof value !== "object") return
  return value
}

export async function detectServerContract(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Promise<ServerContract> {
  const health = await probe(server, fetch, "/api/health")
  if (
    !health ||
    !("healthy" in health) ||
    health.healthy !== true ||
    !("product" in health) ||
    health.product !== OMP_WEB_PRODUCT ||
    !("protocol" in health) ||
    health.protocol !== OMP_WEB_PROTOCOL
  ) {
    throw new Error("This UI requires an OMP Web server")
  }
  return { protocol: OMP_WEB_PROTOCOL, capabilities: serverCapabilities(health) }
}

export async function detectServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Promise<ServerProtocol> {
  return (await detectServerContract(server, fetch)).protocol
}
