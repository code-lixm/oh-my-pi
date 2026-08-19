import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank usernames to omp", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "omp", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the OMP username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("omp:secret"))
  })
})
