import type {
  RpcPluginInfo,
  RpcPluginSettingInfo,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-management-types"
import type { RpcSettingValue } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import {
  type Accessor,
  type Component,
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerCapabilities } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { settingsMetadataLabel } from "./mcp"
import { useOmpApi } from "./omp-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

export const PluginSettingControl: Component<{
  setting: RpcPluginSettingInfo
  disabled: boolean
  update: (value: RpcSettingValue) => void
}> = (props) => {
  const display = () => {
    if (props.setting.value !== undefined) return String(props.setting.value)
    if (props.setting.defaultValue !== undefined) return String(props.setting.defaultValue)
    return ""
  }
  const [draft, setDraft] = createSignal(display())
  createEffect(() => setDraft(display()))

  if (props.setting.type === "boolean") {
    return (
      <Switch
        checked={(props.setting.value ?? props.setting.defaultValue) === true}
        disabled={props.disabled}
        onChange={props.update}
        hideLabel
      >
        {props.setting.key}
      </Switch>
    )
  }
  if (props.setting.type === "enum") {
    const options = () => props.setting.values ?? []
    return (
      <SelectV2
        appearance="inline"
        options={options()}
        current={options().find((value) => value === String(props.setting.value ?? props.setting.defaultValue ?? ""))}
        disabled={props.disabled}
        label={(value) => value}
        onSelect={(value) => value !== undefined && props.update(value)}
        placement="bottom-end"
        gutter={6}
      />
    )
  }

  const commit = () => {
    const draftValue = draft()
    if (props.setting.secret && draftValue.length === 0) return
    const value = props.setting.type === "number" ? Number(draftValue) : draftValue
    if (props.setting.type === "number" && !Number.isFinite(value)) return
    props.update(value)
  }
  return (
    <div class="w-full sm:w-[260px]">
      <TextInputV2
        type={props.setting.secret ? "password" : props.setting.type === "number" ? "number" : "text"}
        appearance="base"
        value={draft()}
        disabled={props.disabled}
        aria-label={props.setting.key}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.currentTarget.blur()
        }}
      />
    </div>
  )
}

export const SettingsPluginsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const capabilities = useServerCapabilities()
  const api = useOmpApi(props.directory)
  const [saving, setSaving] = createSignal<string>()
  const [plugins, { mutate }] = createResource(
    () => (capabilities()?.pluginRead ? api.key() : undefined),
    () => api.request<RpcPluginInfo[]>("/api/omp/admin/plugins"),
  )

  const update = async (key: string, path: string, body: unknown) => {
    if (!capabilities()?.pluginWrite || saving()) return
    setSaving(key)
    try {
      mutate(
        await api.request<RpcPluginInfo[]>(path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(undefined)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.plugins")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <Show
          when={plugins()}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          {(items) => (
            <For each={items()}>
              {(plugin) => {
                const features = () => plugin.features ?? []
                const settings = () => plugin.settings ?? []
                return (
                  <div class="settings-v2-section">
                    <h3 class="settings-v2-section-title">{plugin.name}</h3>
                    <SettingsListV2>
                      <SettingsRowV2
                        title={plugin.id}
                        description={
                          plugin.description ??
                          `${settingsMetadataLabel(language, `pluginKind.${plugin.kind}` as const)} · ${plugin.version} · ${settingsMetadataLabel(language, `scope.${plugin.scope}` as const)}`
                        }
                      >
                        <Switch
                          checked={plugin.enabled}
                          disabled={!capabilities()?.pluginWrite || saving() !== undefined || plugin.shadowedBy !== undefined}
                          onChange={(enabled) =>
                            void update(`plugin:${plugin.kind}:${plugin.scope}:${plugin.id}`, "/api/omp/admin/plugins", {
                              plugin: { id: plugin.id, kind: plugin.kind, scope: plugin.scope },
                              enabled,
                            })
                          }
                          hideLabel
                        >
                          {plugin.name}
                        </Switch>
                      </SettingsRowV2>
                      <For each={features()}>
                        {(feature) => (
                          <SettingsRowV2 title={feature.id} description={feature.description}>
                            <Switch
                              checked={feature.enabled}
                              disabled={!capabilities()?.pluginWrite || saving() !== undefined || !plugin.enabled}
                              onChange={(enabled) => {
                                const selected = features()
                                  .filter((item) => (item.id === feature.id ? enabled : item.enabled))
                                  .map((item) => item.id)
                                void update(`feature:${plugin.id}:${feature.id}`, "/api/omp/admin/plugins/features", {
                                  name: plugin.id,
                                  features: selected,
                                })
                              }}
                              hideLabel
                            >
                              {feature.id}
                            </Switch>
                          </SettingsRowV2>
                        )}
                      </For>
                      <For each={settings()}>
                        {(setting) => (
                          <SettingsRowV2 title={setting.key} description={setting.description}>
                            <PluginSettingControl
                              setting={setting}
                              disabled={!capabilities()?.pluginWrite || saving() !== undefined || !plugin.enabled}
                              update={(value) =>
                                void update(`setting:${plugin.id}:${setting.key}`, "/api/omp/admin/plugins/settings", {
                                  name: plugin.id,
                                  key: setting.key,
                                  value,
                                })
                              }
                            />
                          </SettingsRowV2>
                        )}
                      </For>
                    </SettingsListV2>
                  </div>
                )
              }}
            </For>
          )}
        </Show>
      </div>
    </>
  )
}
