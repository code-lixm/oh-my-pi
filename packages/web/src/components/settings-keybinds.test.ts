import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createKeybindSettingsController } from "./settings-keybinds";

const RETIRED_IDS = ["agent.cycle", "agent.cycle.reverse"] as const;

describe("Web keybind catalog", () => {
  test("hides retired agent-cycle commands from catalog, live options, and saved overrides", () => {
    const persisted: Record<string, string> = {
      "agent.cycle": "ctrl+shift+a",
      "agent.cycle.reverse": "ctrl+shift+r",
      "persisted.keep": "ctrl+shift+p",
    };
    const target = document.implementation.createHTMLDocument(
      "web-keybind-catalog",
    );

    createRoot((dispose) => {
      try {
        const controller = createKeybindSettingsController(
          {
            command: {
              catalog: [
                {
                  id: "agent.cycle",
                  title: "Cycle agent",
                  keybind: "ctrl+shift+a",
                },
                {
                  id: "session.keep",
                  title: "Keep session",
                  keybind: "ctrl+shift+s",
                },
              ],
              options: [
                {
                  id: "agent.cycle.reverse",
                  title: "Cycle agent backwards",
                  keybind: "ctrl+shift+r",
                },
                {
                  id: "file.keep",
                  title: "Keep file",
                  keybind: "ctrl+shift+f",
                },
              ],
              keybinds: () => {},
            },
            settings: {
              current: { keybinds: persisted },
              keybinds: {
                get: (id) => persisted[id],
                set: (id, keybind) => {
                  persisted[id] = keybind;
                },
                resetAll: () => {
                  for (const id of Object.keys(persisted)) delete persisted[id];
                },
              },
            },
            target,
          },
          {
            locale: () => "en",
            t: (
              key: string | number,
              _params?: Record<string, string | number | boolean>,
            ) => String(key),
          },
        );

        const ids = [...controller.catalog.filtered("").values()].flat();

        expect(ids).toEqual(
          expect.arrayContaining([
            "session.keep",
            "file.keep",
            "persisted.keep",
          ]),
        );
        for (const id of RETIRED_IDS) expect(ids).not.toContain(id);
      } finally {
        dispose();
      }
    });
  });
});
