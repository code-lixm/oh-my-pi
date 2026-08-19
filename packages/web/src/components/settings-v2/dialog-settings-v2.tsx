import { makeEventListener } from "@solid-primitives/event-listener";
import type {
  RpcSettingScope,
  RpcSettingTab,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import { Icon, type IconProps } from "@opencode-ai/ui/icon";
import { useDialog } from "@opencode-ai/ui/context/dialog";
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2";
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2";
import {
  type Accessor,
  type Component,
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  startTransition,
} from "solid-js";
import { useLanguage } from "@/context/language";
import { useLayout } from "@/context/layout";
import { usePlatform } from "@/context/platform";
import { useServerCapabilities } from "@/context/server-sdk";
import { useServerSync } from "@/context/server-sync";
import { useTabs } from "@/context/tabs";
import { SettingsKeybinds } from "../settings-keybinds";
import { SettingsModelsV2 } from "./models";
import { SettingsMcpV2 } from "./mcp";
import { SettingsOmpV2 } from "./omp";
import { SettingsOmpKeybindsV2 } from "./omp-keybinds";
import { useOmpSettings } from "./omp-settings-context";
import { SettingsPluginsV2 } from "./plugins";
import { SettingsProvidersV2 } from "./providers";
import { SettingsServersV2 } from "./servers";
import { SettingsGeneralV2 } from "./general";
import "./settings-v2.css";

type DialogSettingsProps = {
  sessionID?: string;
  defaultValue?: string;
};

const OMP_TAB_ICONS: Record<string, IconProps["name"]> = {
  appearance: "eye",
  model: "models",
  interaction: "speech-bubble",
  context: "brain",
  memory: "archive",
  files: "file-tree",
  shell: "terminal",
  tools: "code",
  tasks: "task",
  providers: "sliders",
  sync: "cloud-upload",
};

function ompTabValue(scope: RpcSettingScope, tab: RpcSettingTab) {
  return `omp:${scope}:${tab}`;
}

type SettingsNavSection = "shared" | "web" | "cli";

function settingsNavSection(value: string): SettingsNavSection {
  if (value.startsWith("omp:shared:") || value === "plugins" || value === "mcp")
    return "shared";
  if (value.startsWith("omp:cli:") || value === "cli-shortcuts") return "cli";
  return "web";
}

export const DialogSettings: Component<DialogSettingsProps> = (props) => {
  const layout = useLayout();
  const tabs = useTabs();
  const serverSync = useServerSync();
  const directory = createMemo(() => {
    const route = layout.route();
    if (route.type === "dir-new-sesssion") return route.dir;
    if (route.type === "draft") {
      const draft = tabs.store.find(
        (item) => item.type === "draft" && item.draftID === route.draftID,
      );
      return draft?.type === "draft" ? draft.directory : undefined;
    }
    if (route.type === "session")
      return serverSync().session.get(route.sessionId)?.directory;
    return undefined;
  });

  return <DialogSettingsContent {...props} directory={directory} />;
};

const DialogSettingsContent: Component<
  DialogSettingsProps & { directory: Accessor<string | undefined> }
> = (props) => {
  const language = useLanguage();
  const platform = usePlatform();
  const dialog = useDialog();
  const capabilities = useServerCapabilities();
  const omp = useOmpSettings();
  const [tab, setTab] = createSignal(props.defaultValue ?? "general");
  const [section, setSection] = createSignal<SettingsNavSection>(
    settingsNavSection(props.defaultValue ?? "general"),
  );
  const [recordingKeybinding, setRecordingKeybinding] = createSignal<string>();
  const disposeRecordingEscape = makeEventListener(
    window,
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !recordingKeybinding()) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setRecordingKeybinding(undefined);
    },
    { capture: true },
  );
  onCleanup(disposeRecordingEscape);
  const displayVersion = () =>
    platform.platform === "desktop"
      ? platform.version
      : platform.runtimeVersion?.();

  const ompTabIds = (scope: RpcSettingScope): RpcSettingTab[] => {
    const catalog = omp.state()?.catalog;
    if (!catalog) return [];
    const visible = new Set(
      catalog.settings
        .filter((item) => item.visible && item.scope === scope)
        .map((item) => item.tab),
    );
    return catalog.tabs
      .filter((item) => visible.has(item.id))
      .map((item) => item.id);
  };
  const ompTabLabel = (tab: RpcSettingTab) =>
    omp.state()?.catalog.tabs.find((item) => item.id === tab)?.label ?? tab;

  const selectTab = (value: string) => {
    setSection(settingsNavSection(value));
    setTab(value);
    if (value !== "cli-shortcuts") setRecordingKeybinding(undefined);
  };

  const selectSection = (next: SettingsNavSection) => {
    const first =
      next === "shared"
        ? ompTabIds("shared")[0]
        : next === "cli"
          ? ompTabIds("cli")[0]
          : undefined;
    const value =
      next === "web"
        ? "general"
        : first
          ? ompTabValue(next, first)
          : next === "shared"
            ? "plugins"
            : "cli-shortcuts";
    setSection(next);
    void startTransition(() => selectTab(value));
  };

  const showProviders = () => {
    void dialog.show(() => (
      <DialogSettings sessionID={props.sessionID} defaultValue="providers" />
    ));
  };

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => selectTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col h-full min-h-0 w-full">
            <div class="settings-v2-scope-switcher">
              <button
                type="button"
                data-selected={section() === "shared"}
                onClick={() => selectSection("shared")}
              >
                {language.t("settings.scope.shared.nav")}
              </button>
              <button
                type="button"
                data-selected={section() === "web"}
                onClick={() => selectSection("web")}
              >
                {language.t("settings.scope.web.nav")}
              </button>
              <Show when={capabilities()?.settingsRead}>
                <button
                  type="button"
                  data-selected={section() === "cli"}
                  onClick={() => selectSection("cli")}
                >
                  {language.t("settings.scope.cli.nav")}
                </button>
              </Show>
            </div>
            <div class="settings-v2-nav-scroll">
              <Show when={section() === "shared"}>
                <div class="flex flex-col gap-1.5 w-full">
                  <For each={ompTabIds("shared")}>
                    {(item) => (
                      <TabsV2.Trigger value={ompTabValue("shared", item)}>
                        <Icon name={OMP_TAB_ICONS[item] ?? "settings-gear"} />
                        {ompTabLabel(item)}
                      </TabsV2.Trigger>
                    )}
                  </For>
                  <Show when={capabilities()?.pluginRead}>
                    <TabsV2.Trigger value="plugins">
                      <Icon name="checklist" />
                      {language.t("status.popover.tab.plugins")}
                    </TabsV2.Trigger>
                  </Show>
                  <Show when={capabilities()?.mcpWrite}>
                    <TabsV2.Trigger value="mcp">
                      <Icon name="mcp" />
                      {language.t("settings.mcp.title")}
                    </TabsV2.Trigger>
                  </Show>
                </div>
              </Show>

              <Show when={section() === "web"}>
                <div class="flex flex-col gap-1.5 w-full">
                  <TabsV2.Trigger value="general">
                    <Icon name="window-cursor" />
                    {language.t("settings.tab.general")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="web-shortcuts">
                    <Icon name="keyboard" />
                    {language.t("settings.tab.webShortcuts")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="servers">
                    <Icon name="server" />
                    {language.t("status.popover.tab.servers")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="providers">
                    <Icon name="providers" />
                    {language.t("settings.providers.title")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="models">
                    <Icon name="selector" />
                    {language.t("settings.models.title")}
                  </TabsV2.Trigger>
                </div>
              </Show>

              <Show when={capabilities()?.settingsRead && section() === "cli"}>
                <div class="flex flex-col gap-1.5 w-full">
                  <For each={ompTabIds("cli")}>
                    {(item) => (
                      <TabsV2.Trigger value={ompTabValue("cli", item)}>
                        <Icon name={OMP_TAB_ICONS[item] ?? "settings-gear"} />
                        {ompTabLabel(item)}
                      </TabsV2.Trigger>
                    )}
                  </For>
                  <TabsV2.Trigger value="cli-shortcuts">
                    <Icon name="keyboard" />
                    {language.t("settings.tab.cliShortcuts")}
                  </TabsV2.Trigger>
                </div>
              </Show>
            </div>
            <div class="settings-v2-nav-footer">
              <span>
                {language.t(
                  platform.platform === "desktop"
                    ? "app.name.desktop"
                    : "app.name.web",
                )}
              </span>
              <Show when={displayVersion()}>
                {(version) => <span>{version()}</span>}
              </Show>
            </div>
          </div>
        </TabsV2.List>

        <For each={ompTabIds("shared")}>
          {(item) => (
            <TabsV2.Content
              value={ompTabValue("shared", item)}
              class="settings-v2-panel"
            >
              <SettingsOmpV2 tab={item} scope="shared" />
            </TabsV2.Content>
          )}
        </For>
        <TabsV2.Content value="plugins" class="settings-v2-panel">
          <SettingsPluginsV2 directory={props.directory} />
        </TabsV2.Content>
        <TabsV2.Content value="mcp" class="settings-v2-panel">
          <SettingsMcpV2 directory={props.directory} />
        </TabsV2.Content>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="web-shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2
            directory={props.directory}
            onBack={showProviders}
          />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <For each={ompTabIds("cli")}>
          {(item) => (
            <TabsV2.Content
              value={ompTabValue("cli", item)}
              class="settings-v2-panel"
            >
              <SettingsOmpV2 tab={item} scope="cli" />
            </TabsV2.Content>
          )}
        </For>
        <TabsV2.Content value="cli-shortcuts" class="settings-v2-panel">
          <SettingsOmpKeybindsV2
            active={recordingKeybinding}
            setActive={setRecordingKeybinding}
          />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  );
};
