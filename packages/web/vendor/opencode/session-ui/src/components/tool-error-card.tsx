import { type ComponentProps, createMemo, Show, splitProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Card, CardDescription } from "@opencode-ai/ui/card"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { formatToolRecord, parseToolError } from "./tool-details"

export interface ToolErrorCardProps extends Omit<ComponentProps<typeof Card>, "children" | "variant"> {
  tool: string
  error: string
  input?: Record<string, unknown>
  title?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  subtitle?: string
  href?: string
  onSubtitleClick?: (event: MouseEvent) => void
}

export function ToolErrorCard(props: ToolErrorCardProps) {
  const i18n = useI18n()
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    copied: false,
  })
  const open = () => props.open ?? state.open
  const copied = () => state.copied
  const [split, rest] = splitProps(props, [
    "tool",
    "error",
    "input",
    "title",
    "defaultOpen",
    "open",
    "onOpenChange",
    "subtitle",
    "href",
    "onSubtitleClick",
  ])
  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }
  const name = createMemo(() => {
    if (split.title) return split.title
    const map: Record<string, string> = {
      read: "ui.tool.read",
      list: "ui.tool.list",
      glob: "ui.tool.glob",
      grep: "ui.tool.grep",
      task: "ui.tool.task",
      webfetch: "ui.tool.webfetch",
      websearch: "ui.tool.websearch",
      bash: "ui.tool.shell",
      shell: "ui.tool.shell",
      patch: "ui.tool.patch",
      apply_patch: "ui.tool.patch",
      question: "ui.tool.questions",
    }
    const key = map[split.tool]
    if (!key) return split.tool
    if (!key.includes(".")) return key
    return i18n.t(key)
  })
  const parsed = createMemo(() => parseToolError(split.tool, split.error))
  const cleaned = () => parsed().cleaned

  const subtitle = createMemo(() => {
    if (split.subtitle) return split.subtitle
    const head = parsed().heading
    if (!head) return i18n.t("ui.toolErrorCard.failed")
    return head[0] ? head[0].toUpperCase() + head.slice(1) : i18n.t("ui.toolErrorCard.failed")
  })

  const body = () => parsed().body
  const input = createMemo(() => formatToolRecord(split.input))

  const copy = async () => {
    const text = cleaned()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  return (
    <Card {...rest} data-kind="tool-error-card" data-open={open() ? "true" : "false"} variant="error">
      <Collapsible class="tool-collapsible" data-open={open() ? "true" : "false"} open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger>
          <div data-component="tool-trigger">
            <div data-slot="basic-tool-tool-trigger-content">
              <span data-slot="basic-tool-tool-indicator" data-component="tool-error-card-icon">
                <Icon name="circle-ban-sign" size="small" style={{ "stroke-width": 1.5 }} />
              </span>
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">{name()}</span>
                    <Show
                      when={split.href && split.subtitle}
                      fallback={<span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                    >
                      <a
                        data-slot="basic-tool-tool-subtitle"
                        class="clickable subagent-link"
                        href={split.href!}
                        onClick={(event) => {
                          event.stopPropagation()
                          split.onSubtitleClick?.(event)
                        }}
                      >
                        {subtitle()}
                      </a>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="tool-error-card-content">
            <Show when={open()}>
              <div data-slot="tool-error-card-copy">
                <Tooltip
                  value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  placement="top"
                  gutter={4}
                >
                  <IconButton
                    icon={copied() ? "check" : "copy"}
                    size="normal"
                    variant="ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void copy()
                    }}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  />
                </Tooltip>
              </div>
            </Show>
            <Show when={input()}>
              {(value) => (
                <div data-component="generic-tool-details">
                  <section data-slot="generic-tool-section">
                    <div data-slot="generic-tool-label">{i18n.t("ui.basicTool.input")}</div>
                    <pre data-slot="generic-tool-value">{value()}</pre>
                  </section>
                </div>
              )}
            </Show>
            <Show when={body()}>{(value) => <CardDescription>{value()}</CardDescription>}</Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Card>
  )
}
