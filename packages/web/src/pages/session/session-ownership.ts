import { createComputed, onCleanup } from "solid-js"

// The session key is derived from the directory-scoped SDK, which can be
// momentarily unavailable during a context teardown/rebuild. A throwing key
// must be treated as "the session changed away" rather than crash the delayed
// ownership actions (requestAnimationFrame/setTimeout callbacks) that read it.
function readSessionKey(sessionKey: () => string): string {
  try {
    return sessionKey()
  } catch {
    return ""
  }
}

export function createSessionOwnership(sessionKey: () => string) {
  let current = readSessionKey(sessionKey)
  let generation = 0
  const transition = () => {
    const next = readSessionKey(sessionKey)
    if (next === current) return
    current = next
    generation++
  }
  createComputed(transition)
  onCleanup(() => generation++)

  return {
    key: () => {
      transition()
      return `${generation}:${current}`
    },
    capture() {
      transition()
      const captured = generation
      return {
        key: `${captured}:${current}`,
        current: () => {
          transition()
          return generation === captured
        },
        run<T>(action: () => T) {
          transition()
          if (generation !== captured) return
          return action()
        },
      }
    },
  }
}
