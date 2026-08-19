import type { Accessor } from "solid-js"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import type { OmpJsonValue, OmpSessionSnapshotView } from "../../../shared/omp-view-model"
import { useOmpApi } from "../settings-v2/omp-api"

type DialogOmpRuntimeProps = {
  sessionID: string
  directory: Accessor<string | undefined>
}

type JsonRecord = { [key: string]: OmpJsonValue }
type RuntimeItem = { name?: string; status?: string }

const hiddenAbsolutePath = /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/]|file:)/i

const sensitiveRuntimeText = /\b(?:system\s*prompt|credential|authorization|api[_ -]?key|bearer\s|tool\s+schema)\b/i
function record(value: OmpJsonValue | undefined | null): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value
}

function safeText(value: OmpJsonValue | undefined): string | undefined {
  if (typeof value !== "string") return
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized || hiddenAbsolutePath.test(normalized) || sensitiveRuntimeText.test(normalized)) return
  return normalized
}

function number(value: OmpJsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringAt(value: JsonRecord | undefined, keys: readonly string[]) {
  for (const key of keys) {
    const text = safeText(value?.[key])
    if (text) return text
  }
}

function numberAt(value: JsonRecord | undefined, keys: readonly string[]) {
  for (const key of keys) {
    const candidate = number(value?.[key])
    if (candidate !== undefined) return candidate
  }
}

function items(value: OmpJsonValue | undefined | null): OmpJsonValue[] {
  if (Array.isArray(value)) return value
  const source = record(value)
  if (!source) return []
  for (const key of ["items", "jobs", "active", "running"] as const) {
    if (Array.isArray(source[key])) return source[key]
  }
  return Object.values(source).filter((item) => typeof item === "object" && item !== null)
}

function runtimeItems(value: OmpJsonValue | undefined | null): RuntimeItem[] {
  return items(value).map((item) => {
    const source = record(item)
    return {
      name: safeText(item) ?? stringAt(source, ["name", "title", "agent", "tool", "id"]),
      status: stringAt(source, ["status", "state", "phase", "lifecycle"]),
    }
  })
}

function modeEnabled(value: OmpJsonValue | undefined) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return !["false", "off", "disabled", "inactive"].includes(value.toLowerCase())
  const source = record(value)
  if (!source) return false
  for (const key of ["enabled", "active", "on"] as const) {
    if (typeof source[key] === "boolean") return source[key]
  }
  return true
}

function contextUsage(value: OmpJsonValue | undefined): string | undefined {
  const direct = number(value)
  if (direct !== undefined) return direct <= 1 ? `${Math.round(direct * 100)}%` : String(Math.round(direct))

  const source = record(value)
  if (!source) return
  const ratio = numberAt(source, ["percentage", "percent", "ratio"])
  if (ratio !== undefined) return `${Math.round(ratio <= 1 ? ratio * 100 : ratio)}%`

  const used = numberAt(source, ["used", "current", "consumed", "tokens"])
  const limit = numberAt(source, ["limit", "max", "total", "capacity"])
  if (used !== undefined && limit !== undefined) return `${Math.round(used)} / ${Math.round(limit)}`
  if (used !== undefined) return String(Math.round(used))
}

function activity(value: OmpJsonValue | undefined) {
  const source = record(value)
  return {
    phase: stringAt(source, ["phase", "state"]),
    label: stringAt(source, ["label", "title", "name"]),
    detail: stringAt(source, ["detail", "message", "summary"]),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sessionRoute(sessionID: string, suffix = "") {
  return `/api/omp/session/${encodeURIComponent(sessionID)}/omp${suffix}`
}

function sessionActionRoute(sessionID: string, suffix: string) {
  return `/api/omp/session/${encodeURIComponent(sessionID)}${suffix}`
}

function Metric(props: { label: string; value: string | number | undefined }) {
  const language = useLanguage()
  return (
    <div class="min-w-0 rounded-md border border-border-weak-base bg-surface-base px-3 py-2">
      <dt class="text-11-medium text-text-weak truncate">{props.label}</dt>
      <dd class="mt-0.5 min-w-0 text-13-regular text-text-base truncate">
        {props.value ?? language.t("session.ompRuntime.unavailable")}
      </dd>
    </div>
  )
}

function StatusList(props: {
  empty: string
  items: RuntimeItem[]
  unnamed: (number: number) => string
  more: (count: number) => string
}) {
  return (
    <Show when={props.items.length > 0} fallback={<p class="text-12-regular text-text-weak">{props.empty}</p>}>
      <ul class="flex min-w-0 flex-col gap-1.5">
        <For each={props.items.slice(0, 3)}>
          {(item, index) => (
            <li class="flex min-w-0 items-center gap-2 text-12-regular">
              <span class="min-w-0 flex-1 truncate text-text-base">{item.name ?? props.unnamed(index() + 1)}</span>
              <Show when={item.status}>
                {(status) => <span class="shrink-0 truncate text-text-weak max-w-[40%]">{status()}</span>}
              </Show>
            </li>
          )}
        </For>
        <Show when={props.items.length > 3}>
          <li class="text-12-regular text-text-weak">{props.more(props.items.length - 3)}</li>
        </Show>
      </ul>
    </Show>
  )
}

export function DialogOmpRuntime(props: DialogOmpRuntimeProps) {
  const language = useLanguage()
  const api = useOmpApi(props.directory)
  const [pending, setPending] = createSignal<string>()
  const [exportPath, setExportPath] = createSignal<string>()
  const [snapshot, { refetch }] = createResource(
    () => [api.key(), props.sessionID] as const,
    ([, sessionID]) => api.request<OmpSessionSnapshotView>(sessionRoute(sessionID)),
  )

  const refresh = async () => {
    try {
      await refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.ompRuntime.actionFailed"),
        description: errorMessage(error),
      })
    }
  }

  const mutate = async (name: string, path: string, success: string) => {
    if (pending()) return
    setPending(name)
    try {
      await api.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      showToast({ variant: "success", icon: "circle-check", title: language.t(success) })
      await refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.ompRuntime.actionFailed"),
        description: errorMessage(error),
      })
    } finally {
      setPending(undefined)
    }
  }

  const exportSession = async () => {
    if (pending()) return
    setPending("export")
    try {
      const response = await api.request<{ path?: string }>(sessionRoute(props.sessionID, "/export"))
      const path = response.path
      setExportPath(path)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("session.ompRuntime.exported"),
        description: path ?? language.t("session.ompRuntime.exportPathUnavailable"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.ompRuntime.actionFailed"),
        description: errorMessage(error),
      })
    } finally {
      setPending(undefined)
    }
  }

  const state = createMemo(() => snapshot()?.state)
  const activityState = createMemo(() => activity(state()?.activity))
  const subagents = createMemo(() => runtimeItems(snapshot()?.subagents))
  const jobs = createMemo(() => runtimeItems(snapshot()?.jobs))
  const lspCount = createMemo(() => {
    const value = state()?.lsp
    if (Array.isArray(value)) return value.length
    if (!value) return 0
    return items(value).length || 1
  })
  const tools = createMemo(() => snapshot()?.state.tools ?? [])
  const todoCounts = createMemo(() => {
    const todos = snapshot()?.state.todos ?? []
    const done = todos.filter((todo) => ["completed", "done"].includes(todo.status.toLowerCase())).length
    return { total: todos.length, done }
  })

  return (
    <Dialog
      title={language.t("session.ompRuntime.title")}
      class="w-full max-w-2xl [&_[data-slot=dialog-body]]:min-w-0"
    >
      <div class="flex max-h-[70vh] min-w-0 flex-col gap-4 overflow-y-auto px-2.5 pb-3" aria-live="polite">
        <div class="flex min-w-0 items-center justify-between gap-3">
          <p class="min-w-0 text-12-regular text-text-weak truncate">{language.t("session.ompRuntime.status")}</p>
          <Button
            type="button"
            variant="ghost"
            size="small"
            class="shrink-0"
            onClick={() => void refresh()}
            disabled={snapshot.loading || Boolean(pending())}
            aria-label={language.t("session.ompRuntime.refresh")}
          >
            <Show when={snapshot.loading}>
              <Spinner class="size-3" />
            </Show>
            {language.t("session.ompRuntime.refresh")}
          </Button>
        </div>

        <Show when={!snapshot() && snapshot.loading}>
          <div class="flex items-center justify-center gap-2 py-8 text-13-regular text-text-weak">
            <Spinner class="size-4" />
            <span>{language.t("session.ompRuntime.loading")}</span>
          </div>
        </Show>

        <Show when={!snapshot() && snapshot.error}>
          <div class="flex flex-col items-start gap-3 rounded-md border border-border-weak-base bg-surface-base p-4" role="alert">
            <p class="text-13-regular text-text-base">{language.t("session.ompRuntime.loadError")}</p>
            <Button type="button" variant="secondary" size="small" onClick={() => void refresh()}>
              {language.t("session.ompRuntime.retry")}
            </Button>
          </div>
        </Show>

        <Show when={!snapshot() && !snapshot.loading && !snapshot.error}>
          <div class="rounded-md border border-border-weak-base bg-surface-base p-4 text-13-regular text-text-weak">
            {language.t("session.ompRuntime.empty")}
          </div>
        </Show>

        <Show when={snapshot()} keyed>
          {(value) => {
            const current = () => value.state
            const model = () => current().model && `${current().model!.provider} / ${current().model!.id}`
            const lsp = () => (lspCount() > 0 ? language.t("session.ompRuntime.lspServices", { count: lspCount() }) : language.t("session.ompRuntime.lspUnavailable"))
            const tokensPerSecond = () => {
              const value = current().tokensPerSecond
              return value === null || value === undefined ? undefined : value.toFixed(1)
            }
            return (
              <>
                <section class="min-w-0" aria-labelledby="omp-runtime-overview">
                  <h3 id="omp-runtime-overview" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.status")}
                  </h3>
                  <dl class="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
                    <Metric
                      label={language.t("session.ompRuntime.state")}
                      value={language.t(`session.ompRuntime.runtime.${current().runtime}`)}
                    />
                    <Metric label={language.t("session.ompRuntime.model")} value={model()} />
                    <Metric
                      label={language.t("session.ompRuntime.streaming")}
                      value={current().isStreaming ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")}
                    />
                    <Metric
                      label={language.t("session.ompRuntime.bashRunning")}
                      value={current().isBashRunning ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")}
                    />
                    <Metric
                      label={language.t("session.ompRuntime.evalRunning")}
                      value={current().isEvalRunning ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")}
                    />
                    <Metric
                      label={language.t("session.ompRuntime.compacting")}
                      value={current().isCompacting ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")}
                    />
                    <Metric label={language.t("session.ompRuntime.queued")} value={current().queuedMessageCount ?? 0} />
                    <Metric label={language.t("session.ompRuntime.messages")} value={current().messageCount ?? 0} />
                    <Metric label={language.t("session.ompRuntime.tps")} value={tokensPerSecond()} />
                    <Metric label={language.t("session.ompRuntime.contextUsage")} value={contextUsage(current().contextUsage)} />
                    <Metric label={language.t("session.ompRuntime.lsp")} value={lsp()} />
                  </dl>
                </section>

                <section class="min-w-0 border-t border-border-weak-base pt-4" aria-labelledby="omp-runtime-activity">
                  <h3 id="omp-runtime-activity" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.activity")}
                  </h3>
                  <Show
                    when={activityState().phase || activityState().label || activityState().detail}
                    fallback={<p class="mt-2 text-12-regular text-text-weak">{language.t("session.ompRuntime.activityEmpty")}</p>}
                  >
                    <dl class="mt-2 flex min-w-0 flex-col gap-1.5 text-12-regular">
                      <Show when={activityState().phase}>
                        {(phase) => <Metric label={language.t("session.ompRuntime.activityPhase")} value={phase()} />}
                      </Show>
                      <Show when={activityState().label}>
                        {(label) => <Metric label={language.t("session.ompRuntime.activityLabel")} value={label()} />}
                      </Show>
                      <Show when={activityState().detail}>
                        {(detail) => <Metric label={language.t("session.ompRuntime.activityDetail")} value={detail()} />}
                      </Show>
                    </dl>
                  </Show>
                </section>

                <section class="min-w-0 border-t border-border-weak-base pt-4" aria-labelledby="omp-runtime-modes">
                  <h3 id="omp-runtime-modes" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.modes")}
                  </h3>
                  <dl class="mt-2 grid min-w-0 grid-cols-3 gap-2">
                    <Metric label={language.t("session.ompRuntime.planMode")} value={modeEnabled(current().planMode) ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")} />
                    <Metric label={language.t("session.ompRuntime.goalMode")} value={modeEnabled(current().goalMode) ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")} />
                    <Metric label={language.t("session.ompRuntime.vibeMode")} value={modeEnabled(current().vibeMode) ? language.t("session.ompRuntime.enabled") : language.t("session.ompRuntime.disabled")} />
                  </dl>
                </section>

                <section class="min-w-0 border-t border-border-weak-base pt-4" aria-labelledby="omp-runtime-work">
                  <h3 id="omp-runtime-work" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.tools")}
                  </h3>
                  <Show when={tools().length > 0} fallback={<p class="mt-2 text-12-regular text-text-weak">{language.t("session.ompRuntime.toolsEmpty")}</p>}>
                    <ul class="mt-2 flex min-w-0 flex-col gap-1.5">
                      <For each={tools().slice(0, 3)}>
                        {(tool) => <li class="truncate text-12-regular text-text-base">{tool.name}</li>}
                      </For>
                      <Show when={tools().length > 3}>
                        <li class="text-12-regular text-text-weak">{language.t("session.ompRuntime.toolsMore", { count: tools().length - 3 })}</li>
                      </Show>
                    </ul>
                  </Show>
                  <div class="mt-3">
                    <Metric
                      label={language.t("session.ompRuntime.todos")}
                      value={todoCounts().total > 0 ? language.t("session.ompRuntime.todosSummary", { done: todoCounts().done, total: todoCounts().total }) : language.t("session.ompRuntime.todosEmpty")}
                    />
                  </div>
                </section>

                <div class="grid min-w-0 gap-4 border-t border-border-weak-base pt-4 sm:grid-cols-2">
                  <section class="min-w-0" aria-labelledby="omp-runtime-subagents">
                    <h3 id="omp-runtime-subagents" class="text-12-medium text-text-weak">
                      {language.t("session.ompRuntime.subagents")}
                    </h3>
                    <div class="mt-2">
                      <StatusList
                        items={subagents()}
                        empty={language.t("session.ompRuntime.subagentsEmpty")}
                        unnamed={(count) => language.t("session.ompRuntime.subagentUnnamed", { count })}
                        more={(count) => language.t("session.ompRuntime.itemsMore", { count })}
                      />
                    </div>
                  </section>
                  <section class="min-w-0" aria-labelledby="omp-runtime-jobs">
                    <h3 id="omp-runtime-jobs" class="text-12-medium text-text-weak">
                      {language.t("session.ompRuntime.jobs")}
                    </h3>
                    <div class="mt-2">
                      <StatusList
                        items={jobs()}
                        empty={language.t("session.ompRuntime.jobsEmpty")}
                        unnamed={(count) => language.t("session.ompRuntime.jobUnnamed", { count })}
                        more={(count) => language.t("session.ompRuntime.itemsMore", { count })}
                      />
                    </div>
                  </section>
                </div>

                <section class="min-w-0 border-t border-border-weak-base pt-4" aria-labelledby="omp-runtime-providers">
                  <h3 id="omp-runtime-providers" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.providers")}
                  </h3>
                  <Show when={value.loginProviders.length > 0} fallback={<p class="mt-2 text-12-regular text-text-weak">{language.t("session.ompRuntime.providersEmpty")}</p>}>
                    <ul class="mt-2 flex min-w-0 flex-col gap-1.5">
                      <For each={value.loginProviders}>
                        {(provider) => (
                          <li class="flex min-w-0 items-center gap-2 text-12-regular">
                            <span class="min-w-0 flex-1 truncate text-text-base">{provider.name}</span>
                            <span class="shrink-0 truncate text-text-weak">
                              {provider.authenticated
                                ? language.t("session.ompRuntime.providerAuthenticated")
                                : provider.available
                                  ? language.t("session.ompRuntime.providerAvailable")
                                  : language.t("session.ompRuntime.providerUnavailable")}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>

                <section class="min-w-0 border-t border-border-weak-base pt-4" aria-labelledby="omp-runtime-actions">
                  <h3 id="omp-runtime-actions" class="text-12-medium text-text-weak">
                    {language.t("session.ompRuntime.actions")}
                  </h3>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending())} onClick={() => void mutate("checkpoint", sessionRoute(props.sessionID, "/checkpoints"), "session.ompRuntime.checkpointCreated")}>
                      {language.t("session.ompRuntime.checkpointCreate")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending())} onClick={() => void mutate("undo", sessionRoute(props.sessionID, "/checkpoints/undo"), "session.ompRuntime.checkpointUndone")}>
                      {language.t("session.ompRuntime.checkpointUndo")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending())} onClick={() => void mutate("redo", sessionRoute(props.sessionID, "/checkpoints/redo"), "session.ompRuntime.checkpointRedone")}>
                      {language.t("session.ompRuntime.checkpointRedo")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending()) || !current().isStreaming} onClick={() => void mutate("abort-agent", sessionActionRoute(props.sessionID, "/abort"), "session.ompRuntime.agentAborted")}>
                      {language.t("session.ompRuntime.abortAgent")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending()) || !current().isBashRunning} onClick={() => void mutate("abort-bash", sessionRoute(props.sessionID, "/bash/abort"), "session.ompRuntime.bashAborted")}>
                      {language.t("session.ompRuntime.abortBash")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending()) || jobs().length === 0} onClick={() => void mutate("cancel-jobs", sessionRoute(props.sessionID, "/jobs/cancel"), "session.ompRuntime.jobsCancelled")}>
                      {language.t("session.ompRuntime.cancelJobs")}
                    </Button>
                    <Button type="button" variant="secondary" size="small" disabled={Boolean(pending())} onClick={() => void exportSession()}>
                      {language.t("session.ompRuntime.export")}
                    </Button>
                  </div>
                  <Show when={exportPath()}>
                    {(path) => (
                      <div class="mt-3 min-w-0 rounded-md border border-border-weak-base bg-surface-base px-3 py-2">
                        <p class="text-11-medium text-text-weak">{language.t("session.ompRuntime.exportPath")}</p>
                        <p class="mt-0.5 truncate text-12-regular text-text-base">{path()}</p>
                      </div>
                    )}
                  </Show>
                </section>
              </>
            )
          }}
        </Show>
      </div>
    </Dialog>
  )
}
