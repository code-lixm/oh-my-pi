import { describe, expect, test } from "bun:test"
import { updaterAction } from "./updater-action"

describe("updaterAction", () => {
  test("does not expose update actions when the updater is unavailable or disabled", () => {
    expect(updaterAction(undefined)).toEqual({ available: false, label: "settings.updates.action.checkNow" })
    expect(updaterAction({ status: "disabled" })).toEqual({
      available: false,
      label: "settings.updates.action.checkNow",
    })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      available: true,
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({
      available: true,
      label: "settings.updates.action.checking",
    })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      available: true,
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      available: true,
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      available: true,
      label: "settings.updates.action.installing",
    })
    expect(updaterAction({ status: "up-to-date" })).toEqual({
      available: true,
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "error", message: "network unavailable" })).toEqual({
      available: true,
      label: "settings.updates.action.checkNow",
      run: "check",
    })
  })
})
