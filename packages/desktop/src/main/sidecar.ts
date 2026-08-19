import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}
const parentPort = getParentPort()


let child: ChildProcess | undefined
let stopping = false

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  if (child) return
  try {
    const executable = process.env.OMP_WEB_EXECUTABLE ?? "bun"
    const args = process.env.OMP_WEB_ENTRY ? [process.env.OMP_WEB_ENTRY] : []
    args.push(
      "--hostname",
      command.hostname,
      "--port",
      String(command.port),
      "--cwd",
      process.env.OMP_WEB_ROOT_DIRECTORY ?? process.cwd(),
      "--static",
      requiredEnv("OMP_WEB_STATIC"),
      "--db",
      join(command.userDataPath, "omp-web.sqlite"),
      "--username",
      "omp",
      "--password",
      command.password,
    )
    if (process.env.OMP_WEB_OMP_COMMAND) args.push("--omp-command", process.env.OMP_WEB_OMP_COMMAND)

    const spawned = spawn(executable, args, {
      cwd: process.env.OMP_WEB_ROOT_DIRECTORY ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    spawned.stdout?.pipe(process.stdout)
    spawned.stderr?.pipe(process.stderr)
    spawned.once("spawn", () => parentPort.postMessage({ type: "ready" }))
    spawned.once("error", (error) => {
      parentPort.postMessage({ type: "error", error: serializeError(error) })
      setImmediate(() => process.exit(1))
    })
    spawned.once("exit", (code, signal) => {
      child = undefined
      if (stopping) return
      parentPort.postMessage({
        type: "error",
        error: { message: `OMP Web sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})` },
      })
      setImmediate(() => process.exit(code ?? 1))
    })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  stopping = true
  const running = child
  if (running) {
    const exited = Promise.withResolvers<void>()
    running.once("exit", () => exited.resolve())
    running.kill("SIGTERM")
    const timeout = setTimeout(() => running.kill("SIGKILL"), 6_000)
    await exited.promise.finally(() => clearTimeout(timeout))
  }
  child = undefined
  parentPort.postMessage({ type: "stopped" })
  setImmediate(() => process.exit(0))
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
