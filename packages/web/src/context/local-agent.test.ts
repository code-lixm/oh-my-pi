import { describe, expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })

  test.each([
    { name: "null", items: null },
    { name: "undefined", items: undefined },
  ])("treats a $name agent list as having no custom agents", ({ items }) => {
    expect(hasCustomAgent(items as unknown as Array<{ native?: boolean }>)).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })

  test.each([
    { name: "null", items: null },
    { name: "undefined", items: undefined },
  ])("returns no agent for a $name agent list", ({ items }) => {
    expect(resolveAgent<{ name: string }>(items as unknown as Array<{ name: string }>)).toBeUndefined()
  })
})
