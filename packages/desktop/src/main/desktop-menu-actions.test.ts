import { describe, expect, mock, test } from "bun:test"
import { runDesktopMenuAction } from "./desktop-menu-actions"

describe("desktop menu actions", () => {
  test("routes check-for-updates to the update UI handler exactly once", () => {
    const checkForUpdates = mock(() => {})

    runDesktopMenuAction(null, "app.checkForUpdates", { checkForUpdates })

    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test("does not route relaunch to the update UI handler", () => {
    const checkForUpdates = mock(() => {})
    const relaunch = mock(() => {})

    runDesktopMenuAction(null, "app.relaunch", { checkForUpdates, relaunch })

    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})
