import type {
  RpcSettingCatalogItem,
  RpcSettingPath,
  RpcSettingScope,
  RpcSettingTab,
  RpcSettingValue,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2";
import { Switch } from "@opencode-ai/ui/v2/switch-v2";
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2";
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2";
import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { useLanguage } from "@/context/language";
import { useServerCapabilities } from "@/context/server-sdk";
import { SettingsListV2 } from "./parts/list";
import { SettingsRowV2 } from "./parts/row";
import { useOmpSettings } from "./omp-settings-context";
import "./settings-v2.css";

type SettingControlProps = {
  item: RpcSettingCatalogItem;
  value: RpcSettingValue | undefined;
  configured: boolean;
  disabled: boolean;
  update: (path: RpcSettingPath, value: RpcSettingValue) => void;
};

export const SettingTextControl: Component<
  SettingControlProps & {
    type: "text" | "password" | "number";
    serialize: (value: string) => RpcSettingValue;
  }
> = (props) => {
  const display = () => {
    if (props.item.credential) return "";
    if (props.value === undefined || props.value === null) return "";
    if (typeof props.value === "object") return JSON.stringify(props.value);
    return String(props.value);
  };
  const [draft, setDraft] = createSignal(display());
  createEffect(() => setDraft(display()));
  const commit = () => {
    const value = draft();
    if (props.item.credential && value.length === 0) return;
    if (value === display()) return;
    props.update(props.item.path, props.serialize(value));
  };
  return (
    <div class="w-full sm:w-[260px]">
      <TextInputV2
        data-action={`omp-setting-${props.item.path}`}
        type={props.type}
        appearance="base"
        value={draft()}
        min={props.type === "number" ? props.item.min : undefined}
        max={props.type === "number" ? props.item.max : undefined}
        step={props.type === "number" && props.item.integer ? 1 : undefined}
        disabled={props.disabled}
        placeholder={
          props.item.credential && props.configured ? "••••••••" : undefined
        }
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        aria-label={props.item.label}
      />
    </div>
  );
};

const SettingJsonControl: Component<SettingControlProps> = (props) => {
  const display = () => {
    const value = props.value ?? props.item.defaultValue;
    return value === undefined ? "" : JSON.stringify(value, null, 2);
  };
  const [draft, setDraft] = createSignal(display());
  const [invalid, setInvalid] = createSignal(false);
  createEffect(() => {
    setDraft(display());
    setInvalid(false);
  });
  const commit = () => {
    if (draft() === display()) return;
    try {
      const value = JSON.parse(draft()) as RpcSettingValue;
      setInvalid(false);
      props.update(props.item.path, value);
    } catch {
      setInvalid(true);
    }
  };
  return (
    <TextareaV2
      class="w-full sm:w-[360px] [&_[data-slot=textarea-v2-textarea]]:font-mono"
      data-action={`omp-setting-${props.item.path}`}
      value={draft()}
      disabled={props.disabled}
      invalid={invalid()}
      rows={4}
      onInput={(event) => {
        setDraft(event.currentTarget.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
          event.currentTarget.blur();
      }}
      spellcheck={false}
      autocorrect="off"
      autocomplete="off"
      autocapitalize="off"
      aria-label={props.item.label}
    />
  );
};

const SettingMultiSelectControl: Component<SettingControlProps> = (props) => {
  const current = () =>
    Array.isArray(props.value)
      ? props.value.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
  const set = (value: string, checked: boolean) => {
    const next = current().filter((entry) => entry !== value);
    if (checked) next.push(value);
    props.update(props.item.path, next);
  };
  const move = (value: string, delta: number) => {
    const next = [...current()];
    const index = next.indexOf(value);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    props.update(props.item.path, next);
  };
  return (
    <div class="omp-settings-multiselect">
      <For each={props.item.options ?? []}>
        {(option) => {
          const checked = () => current().includes(option.value);
          return (
            <div class="omp-settings-multiselect-option">
              <Switch
                checked={checked()}
                disabled={props.disabled}
                onChange={(value) => set(option.value, value)}
                hideLabel
              >
                {option.label}
              </Switch>
              <span>{option.label}</span>
              <Show when={props.item.ordered && checked()}>
                <div class="omp-settings-order-buttons">
                  <button
                    type="button"
                    disabled={
                      props.disabled || current().indexOf(option.value) === 0
                    }
                    aria-label={`${option.label} ↑`}
                    onClick={() => move(option.value, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={
                      props.disabled ||
                      current().indexOf(option.value) === current().length - 1
                    }
                    aria-label={`${option.label} ↓`}
                    onClick={() => move(option.value, 1)}
                  >
                    ↓
                  </button>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
};

const SettingControl: Component<SettingControlProps> = (props) => {
  const options = () => props.item.options ?? [];
  const currentOption = () =>
    options().find((option) => option.value === String(props.value ?? ""));
  if (props.item.editor === "boolean") {
    return (
      <Switch
        checked={props.value === true}
        disabled={props.disabled}
        onChange={(value) => props.update(props.item.path, value)}
        hideLabel
      >
        {props.item.label}
      </Switch>
    );
  }
  if (props.item.editor === "select") {
    return (
      <SelectV2
        appearance="inline"
        data-action={`omp-setting-${props.item.path}`}
        options={options()}
        current={currentOption()}
        disabled={props.disabled}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => {
          if (!option) return;
          const value =
            typeof props.item.defaultValue === "number"
              ? Number(option.value)
              : option.value;
          props.update(props.item.path, value);
        }}
        placement="bottom-end"
        gutter={6}
      />
    );
  }
  if (props.item.editor === "multiselect")
    return <SettingMultiSelectControl {...props} />;
  if (props.item.editor === "number") {
    return (
      <SettingTextControl
        {...props}
        type="number"
        serialize={(value) => Number(value)}
      />
    );
  }
  if (props.item.editor === "json") return <SettingJsonControl {...props} />;
  return (
    <SettingTextControl
      {...props}
      type={props.item.editor === "secret" ? "password" : "text"}
      serialize={(value) => value}
    />
  );
};

export const SettingsOmpV2: Component<{
  tab: RpcSettingTab;
  scope: RpcSettingScope;
}> = (props) => {
  const language = useLanguage();
  const capabilities = useServerCapabilities();
  const settings = useOmpSettings();
  const selected = createMemo(() =>
    settings.state()?.catalog.tabs.find((tab) => tab.id === props.tab),
  );
  const groups = createMemo(() => {
    const catalog = settings.state()?.catalog;
    if (!catalog) return [];
    const grouped = new Map<
      string,
      { label: string; items: RpcSettingCatalogItem[] }
    >();
    for (const item of catalog.settings) {
      if (!item.visible || item.tab !== props.tab || item.scope !== props.scope)
        continue;
      const key = item.group ?? "";
      const group = grouped.get(key) ?? {
        label: item.groupLabel ?? item.group ?? "",
        items: [],
      };
      group.items.push(item);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  });

  return (
    <Show
      when={settings.state()}
      fallback={
        <div class="settings-v2-models-status">
          {language.t("common.loading")}
          {language.t("common.loading.ellipsis")}
        </div>
      }
    >
      {(current) => (
        <>
          <div class="settings-v2-tab-header">
            <h2 class="settings-v2-tab-title">
              {selected()?.label ?? props.tab}
            </h2>
          </div>
          <div class="settings-v2-tab-body">
            <div
              class="settings-v2-scope-note"
              role="note"
              data-scope={props.scope}
            >
              <strong>
                {language.t(`settings.scope.${props.scope}.title`)}
              </strong>
              <span>
                {language.t(`settings.scope.${props.scope}.description`)}
              </span>
            </div>
            <For each={groups()}>
              {(group) => (
                <div class="settings-v2-section">
                  <Show when={group.label}>
                    <h3 class="settings-v2-section-title">{group.label}</h3>
                  </Show>
                  <SettingsListV2>
                    <For each={group.items}>
                      {(item) => (
                        <SettingsRowV2
                          title={item.label}
                          description={item.description}
                        >
                          <SettingControl
                            item={item}
                            value={current().snapshot.values[item.path]}
                            configured={current().snapshot.configured.includes(
                              item.path,
                            )}
                            disabled={
                              !capabilities()?.settingsWrite ||
                              settings.saving() !== undefined
                            }
                            update={(path, value) =>
                              void settings.update(path, value)
                            }
                          />
                        </SettingsRowV2>
                      )}
                    </For>
                  </SettingsListV2>
                </div>
              )}
            </For>
          </div>
        </>
      )}
    </Show>
  );
};
