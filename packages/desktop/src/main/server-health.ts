import { OMP_WEB_PRODUCT, OMP_WEB_PROTOCOL } from "@oh-my-pi/pi-web/contract"

export type ServerHealth = {
  healthy: true
  product: typeof OMP_WEB_PRODUCT
  protocol: typeof OMP_WEB_PROTOCOL
  version?: string
}

export async function getServerHealth(url: string, password?: string | null): Promise<ServerHealth | undefined> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/api/health", url)
  } catch {
    return
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`omp:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return
    const data: unknown = await response.json()
    if (!data || typeof data !== "object") return
    if (!("healthy" in data) || data.healthy !== true) return
    if (!("product" in data) || data.product !== OMP_WEB_PRODUCT) return
    if (!("protocol" in data) || data.protocol !== OMP_WEB_PROTOCOL) return
    const version = "version" in data && typeof data.version === "string" ? data.version.trim() : ""
    return {
      healthy: true,
      product: OMP_WEB_PRODUCT,
      protocol: OMP_WEB_PROTOCOL,
      ...(version ? { version } : {}),
    }
  } catch {}
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  return Boolean(await getServerHealth(url, password))
}
