import type { RpcMcpServerInfo, RpcPluginInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-management-types"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Accessor, type Component, For, Show, createResource, createSignal } from "solid-js"
import type { dict as englishDictionary } from "@/i18n/en"
import { useLanguage } from "@/context/language"
import { useServerCapabilities } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOmpApi } from "./omp-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

type TranslationKey = keyof typeof englishDictionary
type SettingsMetadataScope = RpcMcpServerInfo["scope"] | RpcPluginInfo["scope"]
type SettingsMetadataValue = `scope.${SettingsMetadataScope}` | `pluginKind.${RpcPluginInfo["kind"]}`
type SettingsMetadataTranslator = { t: (key: TranslationKey) => string }

const settingsMetadataKeys = {
  "scope.user": "settings.metadata.scope.user",
  "scope.project": "settings.metadata.scope.project",
  "scope.native": "settings.metadata.scope.native",
  "scope.global": "settings.metadata.scope.global",
  "pluginKind.marketplace": "settings.metadata.pluginKind.marketplace",
  "pluginKind.npm": "settings.metadata.pluginKind.npm",
} as const satisfies Record<SettingsMetadataValue, TranslationKey>

export function settingsMetadataLabel(language: SettingsMetadataTranslator, metadata: SettingsMetadataValue) {
  return language.t(settingsMetadataKeys[metadata])
}

export const SettingsMcpV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const capabilities = useServerCapabilities()
  const api = useOmpApi(props.directory)
  const [saving, setSaving] = createSignal<string>()
  const [name, setName] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [transport, setTransport] = createSignal<"http" | "sse">("http")
  const [scope, setScope] = createSignal<"user" | "project">("project")
  const [servers, { mutate }] = createResource(
    () => (capabilities()?.mcpWrite ? api.key() : undefined),
    () => api.request<RpcMcpServerInfo[]>("/api/omp/admin/mcp"),
  )

  const request = async (serverName: string, method: "POST" | "PATCH" | "DELETE", body: unknown) => {
    if (!capabilities()?.mcpWrite || saving()) return false
    setSaving(serverName)
    try {
      mutate(
        await api.request<RpcMcpServerInfo[]>("/api/omp/admin/mcp", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      return true
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      setSaving(undefined)
    }
  }

  const add = async () => {
    const serverName = name().trim()
    const serverUrl = url().trim()
    if (!serverName || !serverUrl) return
    const added = await request(serverName, "POST", {
      name: serverName,
      scope: scope(),
      config: { type: transport(), url: serverUrl },
    })
    if (!added) return
    setName("")
    setUrl("")
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.mcp.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.mcp.title")}
              description={language.t("settings.mcp.description")}
            >
              <div class="flex items-center gap-2">
                <SelectV2
                  appearance="inline"
                  options={["http", "sse"] as const}
                  current={transport()}
                  disabled={saving() !== undefined}
                  label={(value) => value.toUpperCase()}
                  onSelect={(value) => value && setTransport(value)}
                  placement="bottom-end"
                  gutter={6}
                />
                <SelectV2
                  appearance="inline"
                  options={["project", "user"] as const}
                  current={scope()}
                  disabled={saving() !== undefined}
                  label={(value) => settingsMetadataLabel(language, `scope.${value}` as const)}
                  onSelect={(value) => value && setScope(value)}
                  placement="bottom-end"
                  gutter={6}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("provider.custom.models.name.label")}
              description={language.t("provider.custom.field.providerID.description")}
            >
              <div class="w-full sm:w-[260px]">
                <TextInputV2
                  class="!w-full min-w-0"
                  appearance="base"
                  value={name()}
                  disabled={saving() !== undefined}
                  placeholder={language.t("provider.custom.field.providerID.placeholder")}
                  aria-label={language.t("provider.custom.models.name.label")}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("provider.custom.field.baseURL.label")}
              description={language.t("settings.mcp.description")}
            >
              <div class="flex w-full min-w-0 flex-col items-end gap-2 sm:w-[260px]">
                <TextInputV2
                  appearance="base"
                  class="!w-full min-w-0"
                  value={url()}
                  disabled={saving() !== undefined}
                  placeholder={language.t("provider.custom.field.baseURL.placeholder")}
                  aria-label={language.t("provider.custom.field.baseURL.label")}
                  onInput={(event) => setUrl(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add()
                  }}
                />
                <ButtonV2
                  variant="neutral"
                  disabled={saving() !== undefined || !name().trim() || !url().trim()}
                  onClick={() => void add()}
                >
                  {language.t("common.submit")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <Show
          when={servers()}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          {(items) => (
            <Show
              when={items().length > 0}
              fallback={<div class="settings-v2-models-status">{language.t("dialog.mcp.empty")}</div>}
            >
              <div class="settings-v2-section">
                <SettingsListV2>
                  <For each={items()}>
                    {(server) => (
                      <SettingsRowV2
                        title={server.name}
                        description={`${server.transport} · ${server.source} · ${settingsMetadataLabel(language, `scope.${server.scope}` as const)}`}
                      >
                        <div class="flex items-center gap-2">
                          <Show when={server.removable && (server.scope === "user" || server.scope === "project")}>
                            <ButtonV2
                              variant="danger"
                              disabled={saving() !== undefined}
                              onClick={() => {
                                if (!globalThis.confirm(`${language.t("common.delete")}: ${server.name}`)) return
                                void request(server.name, "DELETE", { name: server.name, scope: server.scope })
                              }}
                            >
                              {language.t("common.delete")}
                            </ButtonV2>
                          </Show>
                          <Switch
                            checked={server.enabled}
                            disabled={saving() !== undefined}
                            onChange={(enabled) =>
                              void request(server.name, "PATCH", { name: server.name, enabled })
                            }
                            hideLabel
                          >
                            {server.name}
                          </Switch>
                        </div>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </>
  )
}
