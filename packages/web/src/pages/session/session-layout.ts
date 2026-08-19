import { useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { SessionRouteKey, SessionStateKey, ServerScope } from "@/utils/server-scope"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { base64Encode } from "@opencode-ai/core/util/encode"

// The directory-scoped SDK can be momentarily unavailable while the server or
// workspace context is being torn down and rebuilt (e.g. lineage re-resolution
// or a server handoff). Reading the session key must not throw when that
// happens — callers treat a missing directory as "no stable session yet" and
// re-resolve once the SDK comes back. Falling back to a bare route key keeps
// the reactive identity stable across the gap.
export const useSessionKey = () => {
  const params = useParams()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const scope = () => {
    try {
      return serverSDK()?.scope ?? ServerScope.local
    } catch {
      return ServerScope.local
    }
  }
  const directory = () => {
    try {
      const dir = sdk()?.directory
      return dir ? base64Encode(dir) : undefined
    } catch {
      return undefined
    }
  }
  const workspaceKey = () => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory()))
  const sessionKey = () => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory(), params.id))
  return { params, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  const tabs = layout.tabs(sessionKey)
  const view = layout.view(sessionKey)
  return {
    params,
    sessionKey,
    workspaceKey,
    tabs: () => tabs,
    view: () => view,
  }
}
