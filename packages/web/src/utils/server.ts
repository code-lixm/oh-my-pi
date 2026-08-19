import { OmpApiTransport, type OmpApiTransportClient } from "@/omp/api"
import { createOmpTransportClient } from "@/omp/transport"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "omp"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "omp",
    password: decoded.slice(separator + 1),
  }
}

function ompApiFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const wrapped = async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== "/api/health" && !url.pathname.startsWith("/api/omp/")) {
      const transportPath = url.pathname.startsWith("/api/") ? url.pathname.slice("/api".length) : url.pathname
      url.pathname = `/api/omp${transportPath.startsWith("/") ? "" : "/"}${transportPath}`
    }
    return fetcher(new Request(url, request))
  }
  return wrapped as unknown as typeof globalThis.fetch
}

export function createOmpTransportForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOmpTransportClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOmpTransportClient({
    ...config,
    fetch: ompApiFetch(config.fetch ?? globalThis.fetch),
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createOmpApiTransportForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OmpApiTransportClient {
  return OmpApiTransport.make({
    baseUrl: input.server.url,
    fetch: ompApiFetch(input.fetch ?? globalThis.fetch),
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

export type ServerApi = OmpApiTransportClient
