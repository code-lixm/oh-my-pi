import { describe, expect, test } from "bun:test";
import type {
  RpcSettingsCatalog,
  RpcThemePalette,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import { createOmpDesktopTheme } from "./omp-settings-context";

function themePalette(
  id: string,
  primary: string,
  neutral: string,
): RpcThemePalette {
  return {
    id,
    name: id,
    neutral,
    ink: "#102030",
    primary,
    success: "#207a46",
    warning: "#a45a00",
    error: "#bd2939",
    info: "#2468ac",
    interactive: "#5b3ea8",
    diffAdd: "#218739",
    diffDelete: "#c2384d",
  };
}

function settingsCatalog(
  light: RpcThemePalette,
  dark: RpcThemePalette,
): RpcSettingsCatalog {
  return {
    version: 1,
    locale: "en",
    tabs: [],
    settings: [],
    theme: { light, dark },
  };
}

describe("createOmpDesktopTheme", () => {
  test("maps catalog light and dark palette primary and neutral to their matching Web schemes", () => {
    const theme = createOmpDesktopTheme(
      settingsCatalog(
        themePalette("light-solar", "#d14d72", "#fff4e6"),
        themePalette("dark-ocean", "#7db7ff", "#17202a"),
      ),
    );

    expect(theme).toMatchObject({
      light: { palette: { primary: "#d14d72", neutral: "#fff4e6" } },
      dark: { palette: { primary: "#7db7ff", neutral: "#17202a" } },
    });
  });

  test("changing one canonical palette does not change the other Web scheme", () => {
    const lightSolar = themePalette("light-solar", "#d14d72", "#fff4e6");
    const lightLavender = themePalette("light-lavender", "#8f6bb3", "#f2edff");
    const darkOcean = themePalette("dark-ocean", "#7db7ff", "#17202a");
    const darkEmber = themePalette("dark-ember", "#ff9e64", "#2a1720");

    const lightChanged = createOmpDesktopTheme(
      settingsCatalog(lightLavender, darkOcean),
    );
    const darkChanged = createOmpDesktopTheme(
      settingsCatalog(lightSolar, darkEmber),
    );

    expect(lightChanged).toMatchObject({
      light: { palette: { primary: "#8f6bb3", neutral: "#f2edff" } },
      dark: { palette: { primary: "#7db7ff", neutral: "#17202a" } },
    });
    expect(darkChanged).toMatchObject({
      light: { palette: { primary: "#d14d72", neutral: "#fff4e6" } },
      dark: { palette: { primary: "#ff9e64", neutral: "#2a1720" } },
    });
  });
});
