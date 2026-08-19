import { describe, expect, spyOn, test } from "bun:test"
import { getServerHealth } from "./server-health"

const OMP_HEALTH = {
  healthy: true,
  product: "oh-my-pi",
  protocol: "omp-web/v1",
} as const

const rejectedHealthResponses = [
  {
    name: "a healthy-only response without OMP identity",
    body: { healthy: true },
  },
  {
    name: "a response missing the OMP product",
    body: { healthy: true, protocol: "omp-web/v1" },
  },
  {
    name: "a response with a foreign product",
    body: { healthy: true, product: "opencode", protocol: "omp-web/v1" },
  },
  {
    name: "a response missing the OMP protocol",
    body: { healthy: true, product: "oh-my-pi" },
  },
  {
    name: "a response with an incompatible protocol",
    body: { healthy: true, product: "oh-my-pi", protocol: "opencode-web/v1" },
  },
  {
    name: "an unhealthy response with otherwise valid OMP identity",
    body: { healthy: false, product: "oh-my-pi", protocol: "omp-web/v1" },
  },
] as const

describe("getServerHealth", () => {
  test("requests the OMP API health endpoint with OMP Basic auth and trims the version", async () => {
    let request: Request | undefined
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async (input, init) => {
        request = new Request(input, init)
        return Response.json({ ...OMP_HEALTH, version: " 1.18.18-omp.1 " })
      }) as typeof globalThis.fetch,
    )

    try {
      expect(await getServerHealth("http://127.0.0.1:8787/global/health", "sidecar-password")).toEqual({
        ...OMP_HEALTH,
        version: "1.18.18-omp.1",
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(request?.url).toBe("http://127.0.0.1:8787/api/health")
      expect(request?.method).toBe("GET")
      expect(request?.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("omp:sidecar-password").toString("base64")}`,
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("accepts a valid OMP health response without a version", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(OMP_HEALTH))

    try {
      expect(await getServerHealth("http://127.0.0.1:8787", "sidecar-password")).toEqual(OMP_HEALTH)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  for (const { name, body } of rejectedHealthResponses) {
    test(`rejects ${name}`, async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body))

      try {
        expect(await getServerHealth("http://127.0.0.1:8787", "sidecar-password")).toBeUndefined()
      } finally {
        fetchSpy.mockRestore()
      }
    })
  }

  test("does not fall back to the legacy global health endpoint", async () => {
    const paths: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname
        paths.push(path)
        if (path === "/global/health") return Response.json(OMP_HEALTH)
        return new Response(null, { status: 404 })
      }) as typeof globalThis.fetch,
    )

    try {
      expect(await getServerHealth("http://127.0.0.1:8787", "sidecar-password")).toBeUndefined()
      expect(paths).toEqual(["/api/health"])
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
