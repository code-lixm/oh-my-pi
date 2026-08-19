import type {
  RpcKeybindingsCatalog,
  RpcKeybindingsSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-keybindings-types";
import type {
  RpcSettingPath,
  RpcSettingValue,
  RpcSettingsCatalog,
  RpcThemePalette,
  RpcSettingsLocale,
  RpcSettingsSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import { useTheme } from "@opencode-ai/ui/theme/context";
import type {
  DesktopTheme,
  ThemePaletteColors,
} from "@opencode-ai/ui/theme/types";
import {
  type Accessor,
  type Component,
  type ParentProps,
  type Resource,
  createContext,
  createEffect,
  createResource,
  createSignal,
  useContext,
} from "solid-js";
import { useLanguage } from "@/context/language";
import { useServerCapabilities } from "@/context/server-sdk";
import { showToast } from "@/utils/toast";
import { useOmpApi } from "./omp-api";

export interface OmpSettingsState {
  catalog: RpcSettingsCatalog;
  snapshot: RpcSettingsSnapshot;
}

export interface OmpKeybindingsState {
  catalog: RpcKeybindingsCatalog;
  snapshot: RpcKeybindingsSnapshot;
}

export interface OmpSettingsController {
  state: Resource<OmpSettingsState>;
  keybindings: Resource<OmpKeybindingsState>;
  saving: Accessor<RpcSettingPath | undefined>;
  savingKeybinding: Accessor<string | undefined>;
  update(path: RpcSettingPath, value: RpcSettingValue): Promise<void>;
  updateKeybinding(keybinding: string, keys: string[]): Promise<void>;
  resetKeybindings(): Promise<void>;
}

const Context = createContext<OmpSettingsController>();

type CatalogResourceSource = {
  apiKey: string;
  locale: RpcSettingsLocale;
};

function catalogLocale(locale: string): RpcSettingsLocale {
  return locale === "zh" ? "zh-CN" : "en";
}

function catalogPath(path: string, locale: RpcSettingsLocale): string {
  return `${path}?${new URLSearchParams({ locale })}`;
}

function toWebHexColor(value: string): `#${string}` {
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`Invalid OMP theme color: ${value}`);
  return value as `#${string}`;
}

function toWebPalette(palette: RpcThemePalette): ThemePaletteColors {
  return {
    neutral: toWebHexColor(palette.neutral),
    ink: toWebHexColor(palette.ink),
    primary: toWebHexColor(palette.primary),
    success: toWebHexColor(palette.success),
    warning: toWebHexColor(palette.warning),
    error: toWebHexColor(palette.error),
    info: toWebHexColor(palette.info),
    interactive: toWebHexColor(palette.interactive),
    diffAdd: toWebHexColor(palette.diffAdd),
    diffDelete: toWebHexColor(palette.diffDelete),
  };
}

export function createOmpDesktopTheme(
  catalog: RpcSettingsCatalog,
): DesktopTheme {
  const { light, dark } = catalog.theme;
  return {
    id: "omp",
    name: "OMP",
    light: { palette: toWebPalette(light) },
    dark: { palette: toWebPalette(dark) },
  };
}
export const OmpSettingsProvider: Component<
  ParentProps<{ directory: Accessor<string | undefined> }>
> = (props) => {
  const language = useLanguage();
  const capabilities = useServerCapabilities();
  const theme = useTheme();
  const api = useOmpApi(props.directory);
  const [saving, setSaving] = createSignal<RpcSettingPath>();
  const [savingKeybinding, setSavingKeybinding] = createSignal<string>();
  const catalogSource = (): CatalogResourceSource | undefined => {
    if (!capabilities()?.settingsRead) return undefined;
    return { apiKey: api.key(), locale: catalogLocale(language.locale()) };
  };

  const load = async ({
    locale,
  }: CatalogResourceSource): Promise<OmpSettingsState> => {
    const [catalog, snapshot] = await Promise.all([
      api.request<RpcSettingsCatalog>(
        catalogPath("/api/omp/admin/settings/catalog", locale),
      ),
      api.request<RpcSettingsSnapshot>("/api/omp/admin/settings"),
    ]);
    return { catalog, snapshot };
  };

  const [state, { mutate }] = createResource(catalogSource, load);

  createEffect(() => {
    const current = state();
    if (!current) return;
    theme.registerTheme(createOmpDesktopTheme(current.catalog));
  });

  const loadKeybindings = async ({
    locale,
  }: CatalogResourceSource): Promise<OmpKeybindingsState> => {
    const [catalog, snapshot] = await Promise.all([
      api.request<RpcKeybindingsCatalog>(
        catalogPath("/api/omp/admin/keybindings/catalog", locale),
      ),
      api.request<RpcKeybindingsSnapshot>("/api/omp/admin/keybindings"),
    ]);
    return { catalog, snapshot };
  };

  const [keybindings, { mutate: mutateKeybindings }] = createResource(
    catalogSource,
    loadKeybindings,
  );

  const update = async (path: RpcSettingPath, value: RpcSettingValue) => {
    if (!capabilities()?.settingsWrite || saving()) return;
    setSaving(path);
    try {
      const snapshot = await api.request<RpcSettingsSnapshot>(
        "/api/omp/admin/settings",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, value }),
        },
      );
      const catalog = await api.request<RpcSettingsCatalog>(
        catalogPath(
          "/api/omp/admin/settings/catalog",
          catalogLocale(language.locale()),
        ),
      );
      mutate({ catalog, snapshot });
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(undefined);
    }
  };

  const updateKeybinding = async (keybinding: string, keys: string[]) => {
    if (!capabilities()?.settingsWrite || savingKeybinding()) return;
    setSavingKeybinding(keybinding);
    try {
      const snapshot = await api.request<RpcKeybindingsSnapshot>(
        "/api/omp/admin/keybindings",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keybinding, keys }),
        },
      );
      const current = keybindings();
      if (current) mutateKeybindings({ ...current, snapshot });
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingKeybinding(undefined);
    }
  };

  const resetKeybindings = async () => {
    if (!capabilities()?.settingsWrite || savingKeybinding()) return;
    setSavingKeybinding("*");
    try {
      const snapshot = await api.request<RpcKeybindingsSnapshot>(
        "/api/omp/admin/keybindings",
        {
          method: "DELETE",
        },
      );
      const current = keybindings();
      if (current) mutateKeybindings({ ...current, snapshot });
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingKeybinding(undefined);
    }
  };

  return (
    <Context.Provider
      value={{
        state,
        keybindings,
        saving,
        savingKeybinding,
        update,
        updateKeybinding,
        resetKeybindings,
      }}
    >
      {props.children}
    </Context.Provider>
  );
};

export function useOmpSettings(): OmpSettingsController {
  const value = useContext(Context);
  if (!value)
    throw new Error("useOmpSettings must be used inside OmpSettingsProvider");
  return value;
}
