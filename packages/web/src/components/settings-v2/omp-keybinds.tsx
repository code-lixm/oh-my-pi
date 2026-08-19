import { makeEventListener } from "@solid-primitives/event-listener";
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2";
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2";
import fuzzysort from "fuzzysort";
import {
  type Accessor,
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { useLanguage } from "@/context/language";
import { SettingsListV2 } from "./parts/list";
import { useOmpSettings } from "./omp-settings-context";

function normalizeKey(key: string): string {
  const aliases: Record<string, string> = {
    " ": "space",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Escape: "escape",
    Backspace: "backspace",
    Delete: "delete",
    Enter: "enter",
    Tab: "tab",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
  };
  return aliases[key] ?? key.toLowerCase();
}

function recordKeybinding(event: KeyboardEvent): string | undefined {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("super");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

function formatKey(key: string): string {
  const mac =
    typeof navigator === "object" &&
    /(Mac|iPod|iPhone|iPad)/.test(navigator.platform);
  const labels: Record<string, string> = {
    ctrl: "Ctrl",
    shift: "Shift",
    alt: mac ? "Option" : "Alt",
    super: mac ? "Cmd" : "Super",
    escape: "Esc",
    enter: "Enter",
    space: "Space",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    pageup: "PgUp",
    pagedown: "PgDn",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
  };
  return key
    .split("+")
    .map(
      (part) =>
        labels[part] ??
        (part.length === 1
          ? part.toUpperCase()
          : `${part[0]?.toUpperCase()}${part.slice(1)}`),
    )
    .join("+");
}

export function SettingsOmpKeybindsV2(props: {
  active: Accessor<string | undefined>;
  setActive: (value: string | undefined) => void;
}) {
  const language = useLanguage();
  const settings = useOmpSettings();
  const active = props.active;
  const [filter, setFilter] = createSignal("");
  const state = () => settings.keybindings();
  const keybind = (id: string) =>
    (state()?.snapshot.values[id] ?? []).map(formatKey).join(" / ");
  const used = createMemo(() => {
    const result = new Map<string, string[]>();
    for (const [id, keys] of Object.entries(state()?.snapshot.values ?? {})) {
      for (const key of keys) {
        const normalized = key.toLowerCase();
        const ids = result.get(normalized) ?? [];
        ids.push(id);
        result.set(normalized, ids);
      }
    }
    return result;
  });
  const filtered = createMemo(() => {
    const catalog = state()?.catalog;
    if (!catalog) return new Map<string, string[]>();
    const query = filter().trim();
    const items = catalog.keybindings.map((item) => ({
      ...item,
      keys: keybind(item.id),
    }));
    const matches = query
      ? fuzzysort
          .go(query, items, { keys: ["label", "keys"], threshold: -10000 })
          .map((result) => result.obj)
      : items;
    const grouped = new Map<string, string[]>();
    for (const group of catalog.groups) grouped.set(group.id, []);
    for (const item of matches) grouped.get(item.group)?.push(item.id);
    return grouped;
  });
  const item = (id: string) =>
    state()?.catalog.keybindings.find((candidate) => candidate.id === id);
  const stop = () => props.setActive(undefined);

  onMount(() => {
    const dispose = makeEventListener(
      window,
      "keydown",
      (event) => {
        const id = active();
        if (!id || event.repeat) return;
        if (event.key === "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.key === "Backspace" || event.key === "Delete") {
          void settings.updateKeybinding(id, []);
          stop();
          return;
        }
        const next = recordKeybinding(event);
        if (!next) return;
        const conflicts = (used().get(next) ?? []).filter(
          (candidate) => candidate !== id,
        );
        if (conflicts.length > 0) return;
        void settings.updateKeybinding(id, [next]);
        stop();
      },
      { capture: true },
    );
    onCleanup(dispose);
  });

  return (
    <Show
      when={state()}
      fallback={
        <div class="settings-v2-models-status">
          {language.t("common.loading")}
          {language.t("common.loading.ellipsis")}
        </div>
      }
    >
      {(current) => (
        <>
          <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
            <div class="settings-v2-tab-header-row">
              <h2 class="settings-v2-tab-title">
                {language.t("settings.tab.cliShortcuts")}
              </h2>
              <ButtonV2
                variant="ghost"
                disabled={
                  current().snapshot.configured.length === 0 ||
                  settings.savingKeybinding() !== undefined
                }
                onClick={() => void settings.resetKeybindings()}
              >
                {language.t("settings.shortcuts.reset.button")}
              </ButtonV2>
            </div>
            <div class="settings-v2-tab-search">
              <TextInputV2
                type="search"
                appearance="base"
                value={filter()}
                onInput={(event) => setFilter(event.currentTarget.value)}
                placeholder={language.t(
                  "settings.shortcuts.search.placeholder",
                )}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.shortcuts.search.placeholder")}
              />
            </div>
          </div>
          <div class="settings-v2-tab-body">
            <div class="settings-v2-scope-note" role="note" data-scope="cli">
              <strong>{language.t("settings.scope.cli.title")}</strong>
              <span>{language.t("settings.scope.cli.shortcuts")}</span>
            </div>
            <div class="settings-v2-shortcuts flex flex-col gap-8">
              <For each={current().catalog.groups}>
                {(group) => (
                  <Show when={(filtered().get(group.id) ?? []).length > 0}>
                    <div class="settings-v2-section">
                      <h3 class="settings-v2-section-title">{group.label}</h3>
                      <SettingsListV2>
                        <For each={filtered().get(group.id) ?? []}>
                          {(id) => (
                            <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                              <span>{item(id)?.label ?? id}</span>
                              <button
                                type="button"
                                data-keybind-id={id}
                                disabled={
                                  settings.savingKeybinding() !== undefined
                                }
                                classList={{
                                  "settings-v2-keybind-button": true,
                                  "settings-v2-keybind-button--active":
                                    active() === id,
                                }}
                                onClick={() =>
                                  props.setActive(
                                    active() === id ? undefined : id,
                                  )
                                }
                              >
                                <Show
                                  when={active() === id}
                                  fallback={
                                    keybind(id) ||
                                    language.t("settings.shortcuts.unassigned")
                                  }
                                >
                                  {language.t("settings.shortcuts.pressKeys")}
                                </Show>
                              </button>
                            </div>
                          )}
                        </For>
                      </SettingsListV2>
                    </div>
                  </Show>
                )}
              </For>
            </div>
          </div>
        </>
      )}
    </Show>
  );
}
