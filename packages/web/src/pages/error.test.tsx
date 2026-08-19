import { describe, expect, test } from "bun:test"
import { I18nProvider } from "@opencode-ai/ui/context"
import * as Sentry from "@sentry/solid"
import { VERSION } from "@oh-my-pi/pi-utils/dirs"
import { LanguageProvider, useLanguage } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import type { UpdaterPlatform } from "@/updater"
import { createComponent, type JSX } from "solid-js"
import h from "solid-js/h"
import { render } from "solid-js/web"
import { ErrorPage } from "./error"

function ErrorPageHarness(props: { error: unknown }) {
  const language = useLanguage()
  return createComponent(I18nProvider, {
    value: {
      locale: language.intl,
      layoutLocale: language.layoutLocale,
      t: language.t,
      plural: language.plural,
    },
    children: (() => createComponent(ErrorPage, { error: props.error })) as unknown as JSX.Element,
  })
}

function createPlatform(
  input: { runtimeVersion?: Platform["runtimeVersion"]; updater?: UpdaterPlatform } = {},
): Platform {
  return {
    platform: "desktop",
    os: "macos",
    runtimeVersion: input.runtimeVersion,
    updater: input.updater,
    openExternal: () => {},
    restart: async () => {},
    notify: async () => {},
    openDirectoryPickerDialog: async () => null,
    storage: () => ({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }),
  }
}

function buttonWithText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  )
}

describe("ErrorPage", () => {
  test("hides disabled reporting and updates while keeping runtime version and long error details visible", async () => {
    await Sentry.close(0)

    const longMessage = `unrecoverable state: ${"x".repeat(20_000)}`
    const disabledUpdater = {
      state: () => ({ status: "disabled" as const }),
      check: async () => ({ status: "disabled" as const }),
      install: async () => {},
    } satisfies UpdaterPlatform
    const container = document.createElement("div")
    const existingReact = Object.getOwnPropertyDescriptor(globalThis, "React")
    let dispose: (() => void) | undefined
    let shimmedReact = false
    try {
      if (!Reflect.set(globalThis, "React", { createElement: h })) {
        throw new Error("Unable to install React compatibility shim")
      }
      shimmedReact = true
      dispose = render(
        () =>
          createComponent(PlatformProvider, {
            value: createPlatform({ runtimeVersion: () => VERSION, updater: disabledUpdater }),
            children: (() =>
              createComponent(LanguageProvider, {
                locale: "en",
                children: (() =>
                  createComponent(ErrorPageHarness, { error: new Error(longMessage) })) as unknown as JSX.Element,
              })) as unknown as JSX.Element,
          }),
        container,
      )
      document.body.append(container)

      expect(buttonWithText(container, "Report Error")).toBeUndefined()
      expect(container.textContent).not.toContain("Please report this error to the OMP team")
      expect(container.textContent).not.toContain("Discord")
      expect(buttonWithText(container, "Check for updates")).toBeUndefined()
      expect(container.textContent).toContain(`Version: ${VERSION}`)

      const details = container.querySelector<HTMLTextAreaElement>('textarea[data-slot="input-input"]')
      expect(details).toBeInstanceOf(HTMLTextAreaElement)
      expect(details!.value).toContain(longMessage)

      const surface = container.querySelector<HTMLElement>("[data-tauri-drag-region]")
      expect(surface).not.toBeNull()
      expect(surface!.classList.contains("overflow-y-auto")).toBe(true)
    } finally {
      try {
        dispose?.()
        container.remove()
      } finally {
        try {
          if (shimmedReact) {
            if (existingReact) Object.defineProperty(globalThis, "React", existingReact)
            else Reflect.deleteProperty(globalThis, "React")
          }
        } finally {
          await Sentry.close(0)
        }
      }
    }
  })
})
