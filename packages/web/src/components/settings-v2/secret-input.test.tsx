import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RpcPluginSettingInfo } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-management-types";
import type { RpcSettingCatalogItem } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings-types";
import { createComponent, type JSX } from "solid-js";
import h from "solid-js/h";
import { render } from "solid-js/web";
import { SettingTextControl } from "./omp";
import { PluginSettingControl } from "./plugins";

type OmpUpdate = { path: string; value: unknown };

type PluginUpdate = { value: unknown };

type ClassicComponent = (props: Record<string, unknown>) => JSX.Element;

let previousReact: PropertyDescriptor | undefined;

beforeEach(() => {
  previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  const createElement = (
    type: string | ClassicComponent,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => {
    if (typeof type === "function") {
      const propsWithChildren =
        children.length === 0
          ? (props ?? {})
          : {
              ...props,
              children: children.length === 1 ? children[0] : children,
            };
      return createComponent(type, propsWithChildren);
    }
    return h(type, props, ...children);
  };
  Object.defineProperty(globalThis, "React", {
    configurable: true,
    writable: true,
    value: { createElement, Fragment: h.Fragment },
  });
});

afterEach(() => {
  if (previousReact) {
    Object.defineProperty(globalThis, "React", previousReact);
  } else {
    Reflect.deleteProperty(globalThis, "React");
  }
});

function mountControl(child: () => JSX.Element) {
  const container = document.createElement("div");
  const dispose = render(child, container);
  document.body.append(container);
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) {
    dispose();
    container.remove();
    throw new Error("Expected the settings control to render an input");
  }
  return {
    input,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

function blur(input: HTMLInputElement) {
  input.focus();
  input.blur();
}

function inputAndBlur(input: HTMLInputElement, value: string) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  input.blur();
}

function ompItem(
  path: string,
  label: string,
  credential: boolean,
): RpcSettingCatalogItem {
  return {
    path,
    tab: "credentials",
    scope: "shared",
    label,
    description: label,
    editor: credential ? "secret" : "text",
    visible: true,
    credential,
  };
}

function pluginSetting(
  overrides: Partial<RpcPluginSettingInfo> = {},
): RpcPluginSettingInfo {
  return {
    key: "API_TOKEN",
    type: "string",
    secret: true,
    configured: true,
    ...overrides,
  };
}

describe("settings-v2 secret inputs", () => {
  test("preserves an existing configured OMP credential instead of overwriting it with an empty string on blur", () => {
    const path = "provider.apiKey";
    const updates: OmpUpdate[] = [];
    const mounted = mountControl(() =>
      createComponent(SettingTextControl, {
        item: ompItem(path, "Provider API key", true),
        value: undefined,
        configured: true,
        disabled: false,
        type: "password",
        serialize: (value) => value,
        update: (updatePath, value) =>
          updates.push({ path: updatePath, value }),
      }),
    );
    try {
      blur(mounted.input);
      expect(updates).toHaveLength(0);
    } finally {
      mounted.dispose();
    }
  });

  test("submits a newly entered OMP credential exactly once with the new secret on blur", () => {
    const path = "provider.apiKey";
    const updates: OmpUpdate[] = [];
    const mounted = mountControl(() =>
      createComponent(SettingTextControl, {
        item: ompItem(path, "Provider API key", true),
        value: undefined,
        configured: true,
        disabled: false,
        type: "password",
        serialize: (value) => value,
        update: (updatePath, value) =>
          updates.push({ path: updatePath, value }),
      }),
    );
    try {
      inputAndBlur(mounted.input, "new-secret");
      expect(updates).toEqual([{ path, value: "new-secret" }]);
    } finally {
      mounted.dispose();
    }
  });

  test("preserves an existing configured plugin secret instead of overwriting it with an empty string on blur", () => {
    const updates: PluginUpdate[] = [];
    const mounted = mountControl(() =>
      createComponent(PluginSettingControl, {
        setting: pluginSetting(),
        disabled: false,
        update: (value) => updates.push({ value }),
      }),
    );
    try {
      blur(mounted.input);
      expect(updates).toHaveLength(0);
    } finally {
      mounted.dispose();
    }
  });

  test("submits a newly entered plugin secret exactly once with the new secret on blur", () => {
    const updates: PluginUpdate[] = [];
    const mounted = mountControl(() =>
      createComponent(PluginSettingControl, {
        setting: pluginSetting(),
        disabled: false,
        update: (value) => updates.push({ value }),
      }),
    );
    try {
      inputAndBlur(mounted.input, "plugin-secret");
      expect(updates).toEqual([{ value: "plugin-secret" }]);
    } finally {
      mounted.dispose();
    }
  });

  test("submits clearing an ordinary OMP text setting as an empty string", () => {
    const path = "provider.name";
    const updates: OmpUpdate[] = [];
    const mounted = mountControl(() =>
      createComponent(SettingTextControl, {
        item: ompItem(path, "Provider name", false),
        value: "existing-name",
        configured: true,
        disabled: false,
        type: "text",
        serialize: (value) => value,
        update: (updatePath, value) =>
          updates.push({ path: updatePath, value }),
      }),
    );
    try {
      inputAndBlur(mounted.input, "");
      expect(updates).toEqual([{ path, value: "" }]);
    } finally {
      mounted.dispose();
    }
  });
});
