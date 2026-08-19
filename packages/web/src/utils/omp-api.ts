import type { ServerApi } from "./server"
import type {
  AgentPartInput,
  Agent,
  Config,
  FilePartInput,
  Path,
  PermissionRequest,
  LspStatus,
  PtyShellsResponse,
  QuestionRequest,
  ProviderListResponse,
  Session,
  SessionStatus,
  TextPartInput,
} from "@/omp/types"
import type { OmpTransportClient } from "@/omp/transport"
import type {
  Project,
  McpResource,
  McpServer,
  ProjectCurrent,
  CommandInfo,
  SessionApi,
  SessionCommandInput,
  SessionCommandOutput,
  SessionCompactInput,
  SessionCompactOutput,
  SessionInfo,
  SessionPromptInput,
  SessionPromptOutput,
  SessionShellInput,
  SessionShellOutput,
} from "@/omp/api"

type OmpTransportFactory = (directory?: string) => OmpTransportClient
type OmpSessionCreateInput = NonNullable<Parameters<SessionApi["create"]>[0]> & {
  title?: string
  parentID?: string
}
type OmpSessionApi = Omit<
  SessionApi,
  "create" | "prompt" | "command" | "shell" | "compact" | "rename" | "archive" | "remove"
> & {
  create: (input?: OmpSessionCreateInput) => Promise<SessionInfo>
  prompt: (input: SessionPromptInput & OmpPromptTransport) => Promise<SessionPromptOutput>
  command: (input: SessionCommandInput) => Promise<SessionCommandOutput>
  shell: (input: SessionShellInput & OmpPromptTransport) => Promise<SessionShellOutput>
  compact: (input: SessionCompactInput & { model?: OmpPromptTransport["model"] }) => Promise<SessionCompactOutput>
  rename: (input: Parameters<SessionApi["rename"]>[0] & OmpLocation) => Promise<void>
  remove: (input: Parameters<SessionApi["remove"]>[0] & OmpLocation) => Promise<void>
}
type OmpPermissionApi = Omit<ServerApi["permission"], "reply"> & {
  reply: (
    input: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } },
  ) => ReturnType<ServerApi["permission"]["reply"]>
}
type OmpProviderApi = Omit<ServerApi["provider"], "list"> & {
  list: (input?: Parameters<ServerApi["provider"]["list"]>[0]) => Promise<ProviderListResponse>
}
type OmpAgentApi = Omit<ServerApi["agent"], "list"> & {
  list: (input?: Parameters<ServerApi["agent"]["list"]>[0]) => Promise<Agent[]>
}
type OmpCommandApi = Omit<ServerApi["command"], "list"> & {
  list: (input?: Parameters<ServerApi["command"]["list"]>[0]) => Promise<CommandInfo[]>
}
type OmpRuntimeApi = {
  readonly globalConfig: () => Promise<Config>
  readonly updateGlobalConfig: (config: Config) => Promise<void>
  readonly config: (location?: OmpLocation) => Promise<Config>
  readonly path: (location?: OmpLocation) => Promise<Path>
  readonly sessionStatuses: (location?: OmpLocation) => Promise<Record<string, SessionStatus>>
  readonly permissions: (location?: OmpLocation) => Promise<PermissionRequest[]>
  readonly questions: (location?: OmpLocation) => Promise<QuestionRequest[]>
  readonly mcpStatuses: (location?: OmpLocation) => Promise<Record<string, McpServer["status"]>>
  readonly mcpResources: (location?: OmpLocation) => Promise<Record<string, McpResource>>
  readonly connectMcp: (name: string, location?: OmpLocation) => Promise<void>
  readonly disconnectMcp: (name: string, location?: OmpLocation) => Promise<void>
  readonly authenticateMcp: (name: string, location?: OmpLocation) => Promise<void>
  readonly shells: (location?: OmpLocation) => Promise<PtyShellsResponse>
  readonly ptyConnectTicket: (ptyID: string, location?: OmpLocation) => Promise<string | undefined>
  readonly lsp: (location?: OmpLocation) => Promise<LspStatus[]>
  readonly vcs: (location?: OmpLocation) => Promise<{ branch?: string; default_branch?: string }>
}
export type OmpWebApi = Omit<ServerApi, "session" | "permission" | "provider" | "agent" | "command"> & {
  readonly runtime: OmpRuntimeApi
  readonly session: OmpSessionApi
  readonly permission: OmpPermissionApi
  readonly provider: OmpProviderApi
  readonly agent: OmpAgentApi
  readonly command: OmpCommandApi
}
type OmpPromptTransport = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  transportParts?: (TextPartInput | FilePartInput | AgentPartInput)[]
}
type OmpLocation = { directory?: string }
type OmpApiInput = {
  current: ServerApi
  transport: OmpTransportFactory
  directory?: string
}

function mime(uri: string) {
  const match = /^data:([^;,]+)/.exec(uri)
  return match?.[1] ?? "application/octet-stream"
}

function sessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    agent: session.agent,
    model: session.model && {
      id: session.model.id,
      providerID: session.model.providerID,
      variant: session.model.variant,
    },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: session.time,
    title: session.title,
    location: { directory: session.directory, workspaceID: session.workspaceID },
    subpath: session.path,
    revert: session.revert && {
      messageID: session.revert.messageID,
      partID: session.revert.partID,
      snapshot: session.revert.snapshot,
    },
  }
}


export function createOmpApi(input: OmpApiInput): OmpWebApi {
  const directory = (location?: { directory?: string }) => location?.directory ?? input.directory
  const transport = (location?: { directory?: string }) => input.transport(directory(location))
  const located = <T>(data: T, value?: { directory?: string }) => ({
    location: {
      directory: directory(value) ?? "",
      project: { id: "", directory: directory(value) ?? "" },
    },
    data,
  })

  return {
    ...input.current,
    runtime: {
      async updateGlobalConfig(config) {
        await transport().global.config.update({ config })
      },
      async globalConfig() {
        return (await transport().global.config.get()).data ?? {}
      },
      async config(location) {
        return (await transport(location).config.get()).data ?? {}
      },
      async path(location) {
        const result = await transport(location).path.get({ directory: directory(location) })
        if (!result.data) throw new Error("OMP runtime path is unavailable")
        return result.data
      },
      async sessionStatuses(location) {
        return (await transport(location).session.status()).data ?? {}
      },
      async permissions(location) {
        return (await transport(location).permission.list()).data ?? []
      },
      async questions(location) {
        return (await transport(location).question.list()).data ?? []
      },
      async mcpStatuses(location) {
        return (await transport(location).mcp.status()).data ?? {}
      },
      async mcpResources(location) {
        return Object.fromEntries(
          Object.entries((await transport(location).experimental.resource.list()).data ?? {}).map(([key, resource]) => [
            key,
            { ...resource, server: resource.client },
          ]),
        )
      },
      async lsp(location) {
        return (await transport(location).lsp.status()).data ?? []
      },
      async shells(location) {
        return (await transport(location).pty.shells()).data ?? []
      },
      async ptyConnectTicket(ptyID, location) {
        const result = await transport(location).pty.connectToken(
          { ptyID, directory: directory(location) },
          { throwOnError: false },
        )
        if (result.response.status === 200) return result.data?.ticket
      },
      async connectMcp(name, location) {
        await transport(location).mcp.connect({ name, directory: directory(location) })
      },
      async disconnectMcp(name, location) {
        await transport(location).mcp.disconnect({ name, directory: directory(location) })
      },
      async authenticateMcp(name, location) {
        await transport(location).mcp.auth.authenticate({ name, directory: directory(location) })
      },
      async vcs(location) {
        const result = await transport(location).vcs.get()
        return { branch: result.data?.branch, default_branch: result.data?.default_branch }
      },
    },
    provider: {
      ...input.current.provider,
      async list(value) {
        const location = value?.location
        const result = await transport(location).provider.list({ directory: directory(location) })
        return result.data ?? { all: [], default: {}, connected: [] }
      },
    },
    agent: {
      ...input.current.agent,
      async list(value) {
        const location = value?.location
        const result = await transport(location).app.agents({ directory: directory(location) })
        return result.data ?? []
      },
    },
    command: {
      ...input.current.command,
      async list(value) {
        const location = value?.location
        const result = await transport(location).command.list({ directory: directory(location) })
        return (result.data ?? []).map(command => ({
          name: command.name,
          template: command.template,
          description: command.description,
          agent: command.agent,
          subtask: command.subtask,
        }))
      },
    },
    session: {
      ...input.current.session,
      async list(
        value?: Parameters<ServerApi["session"]["list"]>[0],
        options?: Parameters<ServerApi["session"]["list"]>[1],
      ) {
        const result = await transport({ directory: value?.directory }).experimental.session.list(
          {
            directory: value?.directory,
            roots: value?.parentID === null ? true : undefined,
            search: value?.search,
            limit: value?.limit,
          },
          options,
        )
        return { data: (result.data ?? []).map(sessionInfo), cursor: {} }
      },
      async create(value?: OmpSessionCreateInput) {
        const result = await transport(value?.location ?? undefined).session.create({
          directory: directory(value?.location ?? undefined),
          title: value?.title,
          parentID: value?.parentID,
        })
        if (!result.data) throw new Error("Failed to create session")
        return sessionInfo(result.data)
      },
      async get(value: Parameters<ServerApi["session"]["get"]>[0]) {
        const result = await transport().session.get(value)
        if (!result.data) throw new Error(`Session not found: ${value.sessionID}`)
        return sessionInfo(result.data)
      },
      async active() {
        const result = await transport().session.status()
        return Object.fromEntries(
          Object.entries(result.data ?? {}).flatMap(([sessionID, status]) =>
            status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
          ),
        )
      },
      async rename(value: Parameters<ServerApi["session"]["rename"]>[0] & OmpLocation) {
        await transport(value).session.update({ sessionID: value.sessionID, title: value.title })
      },
      async remove(value: Parameters<ServerApi["session"]["remove"]>[0] & OmpLocation) {
        await transport(value).session.delete(value)
      },
      async fork(value: Parameters<ServerApi["session"]["fork"]>[0]) {
        const result = await transport().session.fork(value)
        if (!result.data) throw new Error("Failed to fork session")
        return sessionInfo(result.data)
      },
      async interrupt(value: Parameters<ServerApi["session"]["interrupt"]>[0]) {
        await transport().session.abort(value)
      },
      async prompt(value: SessionPromptInput & OmpPromptTransport) {
        await transport().session.promptAsync({
          sessionID: value.sessionID,
          messageID: value.id ?? undefined,
          agent: value.agent,
          model: value.model,
          variant: value.variant,
          parts: value.transportParts ?? [
            { type: "text", text: value.text },
            ...(value.files ?? []).map((file) => ({
              type: "file" as const,
              mime: file.mention ? "text/plain" : mime(file.uri),
              url: file.uri,
              filename: file.name,
              source: file.mention
                ? {
                    type: "file" as const,
                    text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
                    path: file.uri,
                  }
                : undefined,
            })),
            ...(value.agents ?? []).map((agent) => ({
              type: "agent" as const,
              name: agent.name,
              source: agent.mention
                ? { value: agent.mention.text, start: agent.mention.start, end: agent.mention.end }
                : undefined,
            })),
          ],
        })
        return {
          admittedSeq: 0,
          id: value.id ?? "",
          sessionID: value.sessionID,
          timeCreated: Date.now(),
          type: "user",
          data: { text: value.text },
          delivery: value.delivery ?? "steer",
        }
      },
      async command(value: SessionCommandInput) {
        await transport().session.command({
          sessionID: value.sessionID,
          messageID: value.id ?? undefined,
          command: value.command,
          arguments: value.arguments ?? "",
          agent: value.agent ?? undefined,
          model: value.model ? `${value.model.providerID}/${value.model.id}` : undefined,
          variant: value.model?.variant,
          parts: value.files?.map((file) => ({
            type: "file" as const,
            mime: mime(file.uri),
            url: file.uri,
            filename: file.name,
          })),
        })
        return {
          admittedSeq: 0,
          id: value.id ?? "",
          sessionID: value.sessionID,
          timeCreated: Date.now(),
          type: "user",
          data: { text: `/${value.command} ${value.arguments ?? ""}`.trim() },
          delivery: value.delivery ?? "steer",
        }
      },
      async shell(value: SessionShellInput & OmpPromptTransport) {
        const result = await transport().session.shell({
          sessionID: value.sessionID,
          command: value.command,
          agent: value.agent,
          model: value.model,
        })
        if (!result.data) throw new Error("Failed to run shell command")
      },
      compact: async (value: SessionCompactInput & { model?: OmpPromptTransport["model"] }) => {
        if (!value.model) throw new Error("A model is required to compact an OMP session")
        await transport().session.summarize({
          sessionID: value.sessionID,
          providerID: value.model.providerID,
          modelID: value.model.modelID,
        })
        return {
          admittedSeq: 0,
          id: value.id ?? "",
          sessionID: value.sessionID,
          timeCreated: Date.now(),
          type: "compaction",
        }
      },
      revert: {
        stage: async (value: Parameters<ServerApi["session"]["revert"]["stage"]>[0]) => {
          await transport().session.revert(value)
          return { messageID: value.messageID }
        },
        clear: async (value: Parameters<ServerApi["session"]["revert"]["clear"]>[0]) => {
          await transport().session.unrevert(value)
        },
        commit: input.current.session.revert.commit,
      },
    },
    project: {
      ...input.current.project,
      async list() {
        return ((await transport().project.list()).data ?? []) as Project[]
      },
      async current(value?: Parameters<ServerApi["project"]["current"]>[0]) {
        const result = await transport(value?.location).project.current()
        if (!result.data) throw new Error("Project not found")
        return { id: result.data.id, directory: result.data.worktree } satisfies ProjectCurrent
      },
      async directories(value: Parameters<ServerApi["project"]["directories"]>[0]) {
        const result = await transport(value.location).worktree.list()
        return (result.data ?? []).map((item) => ({ directory: item }))
      },
    },
    vcs: {
      ...input.current.vcs,
      async status(value?: Parameters<ServerApi["vcs"]["status"]>[0]) {
        const result = await transport(value?.location).vcs.status()
        return located(result.data ?? [], value?.location)
      },
      async diff(value: Parameters<ServerApi["vcs"]["diff"]>[0]) {
        const result = await transport(value.location).vcs.diff({
          mode: value.mode === "working" ? "git" : value.mode,
          context: value.context,
        })
        return located(
          (result.data ?? []).map((file) => ({
            file: file.file,
            patch: file.patch ?? "",
            additions: file.additions,
            deletions: file.deletions,
            status: file.status ?? "modified",
          })),
          value.location,
        )
      },
    },
    file: {
      ...input.current.file,
      async list(value?: Parameters<ServerApi["file"]["list"]>[0]) {
        const result = await transport(value?.location).file.list({ path: value?.path ?? "" })
        return located(result.data ?? [], value?.location)
      },
      async find(value: Parameters<ServerApi["file"]["find"]>[0]) {
        const result = await transport(value.location).find.files({
          query: value.query,
          dirs: value.type === undefined ? undefined : value.type === "directory" ? "true" : "false",
          limit: value.limit,
        })
        return located(
          (result.data ?? []).map((path) => ({ path, type: value.type ?? "file" })),
          value.location,
        )
      },
    },
    integration: {
      ...input.current.integration,
      async get(value: Parameters<ServerApi["integration"]["get"]>[0]) {
        const methods = ((await transport(value.location).provider.auth()).data?.[value.integrationID] ?? []).map(
          (method, index) =>
            method.type === "api"
              ? { type: "key" as const, label: method.label }
              : { type: "oauth" as const, id: String(index), label: method.label, prompts: method.prompts },
        )
        return located(
          {
            id: value.integrationID,
            name: value.integrationID,
            methods,
            connections: [],
          },
          value.location,
        )
      },
      connect: {
        ...input.current.integration.connect,
        key: async (value: Parameters<ServerApi["integration"]["connect"]["key"]>[0]) => {
          await transport(value.location).auth.set({
            providerID: value.integrationID,
            auth: { type: "api", key: value.key },
          })
          await transport(value.location).instance.dispose()
          await input.transport().instance.dispose()
        },
      },
      oauth: {
        ...input.current.integration.oauth,
        connect: async (value: Parameters<ServerApi["integration"]["oauth"]["connect"]>[0]) => {
          const method = Number(value.methodID)
          const result = await transport(value.location).provider.oauth.authorize(
            { providerID: value.integrationID, method, inputs: value.inputs },
            { throwOnError: true },
          )
          if (!result.data) throw new Error("Failed to start OAuth authorization")
          return located(
            {
              attemptID: `${value.integrationID}:${method}`,
              url: result.data.url,
              instructions: result.data.instructions,
              mode: result.data.method,
              time: { created: Date.now(), expires: Date.now() + 10 * 60 * 1000 },
            },
            value.location,
          )
        },
        complete: async (value: Parameters<ServerApi["integration"]["oauth"]["complete"]>[0]) => {
          const method = Number(value.attemptID.split(":").at(-1))
          await transport(value.location).provider.oauth.callback(
            { providerID: value.integrationID, method, code: value.code },
            { throwOnError: true },
          )
          await transport(value.location).instance.dispose()
          await input.transport().instance.dispose()
        },
        status: async (value: Parameters<ServerApi["integration"]["oauth"]["status"]>[0]) => {
          const method = Number(value.attemptID.split(":").at(-1))
          await transport(value.location).provider.oauth.callback(
            { providerID: value.integrationID, method },
            { throwOnError: true },
          )
          await transport(value.location).instance.dispose()
          await input.transport().instance.dispose()
          return located(
            { status: "complete" as const, time: { created: Date.now(), expires: Date.now() } },
            value.location,
          )
        },
      },
    },
    pty: {
      ...input.current.pty,
      async list(value?: Parameters<ServerApi["pty"]["list"]>[0]) {
        return located((await transport(value?.location).pty.list()).data ?? [], value?.location)
      },
      async create(value?: Parameters<ServerApi["pty"]["create"]>[0]) {
        const result = await transport(value?.location).pty.create({
          command: value?.command,
          args: value?.args ? [...value.args] : undefined,
          cwd: value?.cwd,
          title: value?.title,
          env: value?.env,
        })
        if (!result.data) throw new Error("Failed to create terminal")
        return located(result.data, value?.location)
      },
      async get(value: Parameters<ServerApi["pty"]["get"]>[0]) {
        const result = await transport(value.location).pty.get({ ptyID: value.ptyID })
        if (!result.data) throw new Error(`Terminal not found: ${value.ptyID}`)
        return located(result.data, value.location)
      },
      async update(value: Parameters<ServerApi["pty"]["update"]>[0]) {
        const result = await transport(value.location).pty.update({
          ptyID: value.ptyID,
          title: value.title,
          size: value.size,
        })
        if (!result.data) throw new Error(`Terminal not found: ${value.ptyID}`)
        return located(result.data, value.location)
      },
      async remove(value: Parameters<ServerApi["pty"]["remove"]>[0]) {
        await transport(value.location).pty.remove({ ptyID: value.ptyID })
      },
    },
    permission: {
      ...input.current.permission,
      async reply(value: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } }) {
        await transport(value.location).permission.respond({
          sessionID: value.sessionID,
          permissionID: value.requestID,
          response: value.reply,
          directory: directory(value.location),
        })
      },
    },
    question: {
      ...input.current.question,
      async reply(value: Parameters<ServerApi["question"]["reply"]>[0]) {
        await transport().question.reply({
          requestID: value.requestID,
          answers: value.answers.map((answer) => [...answer]),
        })
      },
      async reject(value: Parameters<ServerApi["question"]["reject"]>[0]) {
        await transport().question.reject({ requestID: value.requestID })
      },
    },
  }
}
