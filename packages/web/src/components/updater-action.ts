import { createMemo } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterAction(state: UpdaterState | undefined) {
  if (!state || state.status === "disabled") {
    return { available: false, label: "settings.updates.action.checkNow" as const }
  }
  switch (state.status) {
    case "checking":
      return { available: true, label: "settings.updates.action.checking" as const }
    case "downloading":
      return { available: true, label: "settings.updates.action.downloading" as const }
    case "ready":
      return { available: true, label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { available: true, label: "settings.updates.action.installing" as const }
    default:
      return { available: true, label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    async run() {
      const current = action()
      if (!current.available) return
      const run = current.run
      if (run === "install") return platform.updater?.install()
      if (run !== "check") return

      const state = await platform.updater?.check()
      if (state?.status === "up-to-date") {
        const version = platform.runtimeVersion?.()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: version
            ? language.t("settings.updates.toast.latest.description", { version })
            : undefined,
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
  }
}
