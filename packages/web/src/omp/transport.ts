// OMP Web transport boundary. All requests are namespaced by `utils/server.ts`;
// no feature module may construct the upstream client directly.
export { createOpencodeClient as createOmpTransportClient } from "@opencode-ai/sdk/v2/client"
export type { OpencodeClient as OmpTransportClient } from "@opencode-ai/sdk/v2/client"
