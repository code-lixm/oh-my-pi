import type { Accessor } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { requestServerJson } from "@/utils/server-protocol"

/** Authenticated requests to OMP-native bridge routes for the active directory. */
export function useOmpApi(directory: Accessor<string | undefined>) {
  const platform = usePlatform()
  const serverSDK = useServerSDK()

  const request = <T,>(path: string, init?: RequestInit) => {
    const currentDirectory = directory()
    const queryPath = currentDirectory
      ? `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ directory: currentDirectory })}`
      : path
    return requestServerJson<T>(
      serverSDK().server.http,
      platform.fetch ?? globalThis.fetch,
      queryPath,
      init,
    )
  }

  return {
    key: () => `${serverSDK().url}:${directory() ?? ""}`,
    request,
  }
}
