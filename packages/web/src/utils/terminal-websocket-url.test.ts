import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("builds the ticketed OMP PTY URL", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      ticket: "connect-ticket",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.pathname).toBe("/api/omp/pty/pty_test/connect")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("cursor")).toBe("0")
    expect(url.searchParams.get("ticket")).toBe("connect-ticket")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("adds query auth without embedding credentials outside same-origin", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      sameOrigin: false,
      username: "omp",
      password: "secret",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.pathname).toBe("/api/omp/pty/pty_test/connect")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("auth_token")).toBe(btoa("omp:secret"))
  })

  test("keeps saved same-origin credentials out of query auth", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "omp",
      password: "secret",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/api/omp/pty/pty_test/connect")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("adds query auth when same-origin credential transport requests it", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "omp",
      password: "secret",
      authToken: true,
    })

    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/api/omp/pty/pty_test/connect")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("auth_token")).toBe(btoa("omp:secret"))
  })
})
