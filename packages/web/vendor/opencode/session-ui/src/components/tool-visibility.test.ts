import { describe, expect, test } from "bun:test"
import { isContextGroupToolName, isToolVisible } from "./tool-visibility"

describe("tool-card routing", () => {
  test.each(["read", "grep", "find", "multi_grep", "codegraph"])(
    "%s renders as an independent expandable tool card, not a context summary",
    (tool) => {
      expect(isToolVisible(tool)).toBe(true)
      expect(isContextGroupToolName(tool)).toBe(false)
    },
  )

  test("internal todowrite does not render a tool card", () => {
    expect(isToolVisible("todowrite")).toBe(false)
  })
})
