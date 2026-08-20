import { describe, expect, test } from "bun:test"
import { isPartRenderable } from "./part-renderability"
import {
  compactionDisplayText,
  isSnapcompactArchiveSource,
  readPartText,
  visibleUserMessageText,
} from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("visibleUserMessageText", () => {
  test("keeps non-synthetic text parts in order while ignoring blank and synthetic parts", () => {
    expect(
      visibleUserMessageText([
        { type: "text", text: "First user paragraph" },
        { type: "text", text: "  \n\t  " },
        { type: "text", text: "Synthetic summary", synthetic: true },
        { type: "file", text: "attachment label" },
        { type: "text", text: "Second user paragraph" },
      ]),
    ).toBe("First user paragraph\n\nSecond user paragraph")
  })
})

describe("isPartRenderable", () => {
  test("keeps a file part from an assistant message renderable without text content", () => {
    expect(
      isPartRenderable({
        id: "file_1",
        sessionID: "session_1",
        messageID: "assistant_1",
        type: "file",
        mime: "text/plain",
        url: "file:///repo/result.txt",
      }),
    ).toBe(true)
  })
})

describe("compactionDisplayText", () => {
  test("renders a compaction summary followed by its warning as Markdown", () => {
    expect(compactionDisplayText("Compaction summary marker", "Compaction warning marker")).toBe(
      "Compaction summary marker\n\n> Compaction warning marker",
    )
  })
})

describe("isSnapcompactArchiveSource", () => {
  test.each([
    {
      name: "snapcompact resource image",
      source: {
        type: "resource",
        clientName: "omp-snapcompact",
        uri: "omp://snapcompact/session_1/message_1/1",
      },
      expected: true,
    },
    {
      name: "ordinary image without a source",
      source: undefined,
      expected: false,
    },
    {
      name: "resource from another client",
      source: {
        type: "resource",
        clientName: "mcp-server",
        uri: "mcp://server/image",
      },
      expected: false,
    },
    {
      name: "non-resource source",
      source: { type: "file" },
      expected: false,
    },
  ])("returns $expected for $name", ({ source, expected }) => {
    expect(isSnapcompactArchiveSource(source)).toBe(expected)
  })
})
