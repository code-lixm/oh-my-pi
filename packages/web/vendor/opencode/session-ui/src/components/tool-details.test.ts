import { describe, expect, test } from "bun:test"
import { formatToolRecord, parseToolError, shouldDeferGenericToolContent } from "./tool-details"

describe("tool details", () => {
  test("keeps nested unknown-tool input and metadata visible while omitting absent detail panels", () => {
    const input: Record<string, unknown> = {
      request: {
        paths: ["src/one.ts", { path: "src/two.ts", options: { recursive: true } }],
        labels: ["primary", "nested"],
      },
      options: { preview: false },
    }
    const metadata: Record<string, unknown> = {
      execution: {
        attempts: [{ phase: "sync", result: { changed: ["a", "b"] } }],
      },
      context: { sources: ["remote", { region: "eu-west-1" }] },
    }

    expect(formatToolRecord(input)).toBe(JSON.stringify(input, null, 2))
    expect(formatToolRecord(metadata)).toBe(JSON.stringify(metadata, null, 2))
    expect(formatToolRecord(undefined)).toBe("")
    expect(formatToolRecord({})).toBe("")
  })

  test("shows the final failure marker after removing an Error prefix from a failed tool", () => {
    expect(parseToolError("custom.sync", "Error: custom.sync Request failed: failed-error-marker")).toEqual({
      cleaned: "custom.sync Request failed: failed-error-marker",
      heading: "Request failed",
      body: "failed-error-marker",
    })
  })
})

describe("shouldDeferGenericToolContent", () => {
  test.each([
    { name: "defers an explicitly deferred controlled closed card", deferContent: true, open: false, expected: true },
    { name: "keeps an explicitly deferred controlled open card mounted", deferContent: true, open: true, expected: false },
    { name: "does not defer when no deferred content was requested", deferContent: undefined, open: false, expected: false },
  ])("$name", ({ deferContent, open, expected }) => {
    expect(shouldDeferGenericToolContent(deferContent, open)).toBe(expected)
  })
})
