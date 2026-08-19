import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionOwnership } from "./session-ownership"

describe("createSessionOwnership", () => {
  test("runs a captured action while the session key stays stable", () => {
    let ran = 0
    createRoot((dispose) => {
      const ownership = createSessionOwnership(() => "local\u0000dir/session-a")
      const owner = ownership.capture()
      owner.run(() => ran++)
      expect(ran).toBe(1)
      dispose()
    })
  })

  test("skips the delayed action when the session key throws mid-flight", () => {
    let key = () => "local\u0000dir/session-a"
    let ran = 0
    createRoot((dispose) => {
      const ownership = createSessionOwnership(() => key())
      const owner = ownership.capture()
      // The directory-scoped SDK tears down while the delayed callback is queued.
      key = () => {
        throw new Error("SDK context unavailable")
      }
      expect(() => owner.run(() => ran++)).not.toThrow()
      expect(ran).toBe(0)
      dispose()
    })
  })

  test("resumes running actions after the session key comes back", () => {
    let key: () => string = () => "local\u0000dir/session-a"
    let ran = 0
    createRoot((dispose) => {
      const ownership = createSessionOwnership(() => key())
      const owner = ownership.capture()
      key = () => {
        throw new Error("SDK context unavailable")
      }
      owner.run(() => ran++)
      key = () => "local\u0000dir/session-b"
      owner.run(() => ran++)
      // The key moved to a different session: the stale capture must stay skipped.
      expect(ran).toBe(0)
      const fresh = ownership.capture()
      fresh.run(() => ran++)
      expect(ran).toBe(1)
      dispose()
    })
  })
})
