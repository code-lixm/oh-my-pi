import { base64Encode } from "@opencode-ai/core/util/encode";
import { createQuery } from "@tanstack/solid-query";
import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import type { PromptInputControls } from "@/components/prompt-input/contracts";
import { useOmpSettings } from "@/components/settings-v2/omp-settings-context";
import { useOmpApi } from "@/components/settings-v2/omp-api";
import type { PromptProjectControls } from "@/components/prompt-project-selector";
import { useDirectoryPicker } from "@/components/directory-picker";
import { useGlobal } from "@/context/global";
import { useLayout } from "@/context/layout";
import { useLanguage } from "@/context/language";
import { useLocal, type ModelSelection } from "@/context/local";
import type { QueryOptionsApi } from "@/context/server-sync";
import { useServerSDK } from "@/context/server-sdk";
import { useServerCapabilities } from "@/context/server-sdk";
import { serverName, ServerConnection, useServer } from "@/context/server";
import { useSDK } from "@/context/sdk";
import { useSync } from "@/context/sync";
import { useTabs } from "@/context/tabs";
import { useProviders } from "@/hooks/use-providers";
import { pathKey } from "@/utils/path-key";
import { showToast } from "@/utils/toast";
import {
  OMP_APPROVAL_MODES,
  OMP_THINKING_LEVELS,
  type OmpApprovalMode,
  type OmpComposerRuntime,
  type OmpThinkingLevel,
} from "../../../../shared/omp-view-model";

export function createPromptInputController(input: {
  sessionKey: Accessor<string>;
  sessionID: Accessor<string | undefined>;
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">;
  model?: ModelSelection;
}) {
  const layout = useLayout();
  const local = useLocal();
  const sdk = useSDK();
  const sync = useSync();
  const providers = useProviders(() => sdk().directory);
  const view = layout.view(input.sessionKey);
  const agentsQuery = createQuery(() =>
    input.queryOptions.agents(pathKey(sdk().directory)),
  );
  const globalProvidersQuery = createQuery(() =>
    input.queryOptions.providers(null),
  );
  const providersQuery = createQuery(() =>
    input.queryOptions.providers(pathKey(sdk().directory)),
  );
  const language = useLanguage();
  const capabilities = useServerCapabilities();
  const ompSettings = useOmpSettings();
  const ompApi = useOmpApi(() => sdk().directory);
  const [runtime, { mutate: mutateRuntime }] = createResource(
    input.sessionID,
    async (sessionID) => {
      try {
        return await ompApi.request<OmpComposerRuntime>(
          `/api/omp/session/${encodeURIComponent(sessionID)}/runtime`,
        );
      } catch (error) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  );
  const [savingRuntime, setSavingRuntime] = createSignal<"thinking" | "approval">();

  const thinkingOptions = createMemo(() => {
    const values = runtime()?.thinking.options ?? local.model.variant.list();
    const supported = values.filter((value): value is OmpThinkingLevel =>
      (OMP_THINKING_LEVELS as readonly string[]).includes(value),
    );
    return supported.length > 0
      ? [...new Set(supported)]
      : (["off"] satisfies OmpThinkingLevel[]);
  });
  const thinkingCurrent = createMemo(() => {
    const options = thinkingOptions();
    const value = runtime()?.thinking.current ?? local.model.variant.current();
    if (value && options.includes(value as OmpThinkingLevel))
      return value as OmpThinkingLevel;
    const configured =
      ompSettings.state()?.snapshot.values.defaultThinkingLevel;
    if (
      typeof configured === "string" &&
      options.includes(configured as OmpThinkingLevel)
    )
      return configured as OmpThinkingLevel;
    return options[0] ?? "off";
  });

  createEffect(() => {
    const current = runtime()?.thinking.current;
    if (!current || local.model.variant.current() === current) return;
    if (local.model.variant.list().includes(current))
      local.model.variant.set(current);
  });

  const updateRuntime = async (
    kind: "thinking" | "approval",
    patch: Partial<{
      thinkingLevel: OmpThinkingLevel;
      approvalMode: OmpApprovalMode;
    }>,
  ) => {
    const sessionID = input.sessionID();
    if (!sessionID || savingRuntime()) return;
    setSavingRuntime(kind);
    try {
      mutateRuntime(
        await ompApi.request<OmpComposerRuntime>(
          `/api/omp/session/${encodeURIComponent(sessionID)}/runtime`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        ),
      );
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingRuntime(undefined);
    }
  };

  return (): PromptInputControls => ({
    agents: {
      available: sync().data.agent ?? [],
      options: (local.agent.list() ?? []).map((agent) => agent.name),
      current: local.agent.current()?.name ?? "",
      loading: agentsQuery.isLoading,
      visible: false,
      select: local.agent.set,
    },
    model: {
      selection: input.model ?? local.model,
      paid: providers.paid().length > 0,
      loading: providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    session: {
      id: input.sessionID(),
      tabs: layout.tabs(input.sessionKey),
      reviewPanel: view.reviewPanel,
    },
    omp: {
      visible: capabilities()?.settingsRead === true,
      thinking: {
        options: thinkingOptions(),
        current: thinkingCurrent(),
        loading: runtime.loading || savingRuntime() === "thinking",
        select: (value) => {
          local.model.variant.set(value);
          if (input.sessionID())
            void updateRuntime("thinking", { thinkingLevel: value });
        },
      },
      approval: {
        current: (() => {
          const value =
            runtime()?.approvalMode ??
            ompSettings.state()?.snapshot.values["tools.approvalMode"];
          return typeof value === "string" &&
            (OMP_APPROVAL_MODES as readonly string[]).includes(value)
            ? (value as OmpApprovalMode)
            : "yolo";
        })(),
        loading:
          runtime.loading ||
          savingRuntime() === "approval" ||
          ompSettings.saving() === "tools.approvalMode",
        select: (value) => {
          if (input.sessionID())
            void updateRuntime("approval", { approvalMode: value });
          else void ompSettings.update("tools.approvalMode", value);
        },
      },
    },
  });
}

export function createPromptProjectControls() {
  const navigate = useNavigate();
  const layout = useLayout();
  const server = useServer();
  const serverSDK = useServerSDK();
  const sdk = useSDK();
  const tabs = useTabs();
  const global = useGlobal();
  const pickDirectory = useDirectoryPicker();
  const [search] = useSearchParams<{ draftId?: string }>();
  const projectServer = () => serverSDK().server;
  const projectServerCtx = createMemo(() =>
    global.ensureServerCtx(projectServer()),
  );
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId
        ? projectServerCtx().projects.list()
        : layout.projects.list();
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) };
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }));
    });
  });
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey
      ? server.list.find((conn) => ServerConnection.key(conn) === serverKey)
      : projectServer();
    if (search.draftId) {
      if (!conn) return;
      const target = global.ensureServerCtx(conn);
      target.projects.open(worktree);
      target.projects.touch(worktree);
      tabs.updateDraft(search.draftId, {
        server: ServerConnection.key(conn),
        directory: worktree,
      });
      return;
    }

    if (!serverKey) {
      layout.projects.open(worktree);
      server.projects.touch(worktree);
      navigate(`/${base64Encode(worktree)}/session`);
      return;
    }

    if (!conn) return;
    const target = global.ensureServerCtx(conn);
    target.projects.open(worktree);
    target.projects.touch(worktree);
    server.setActive(ServerConnection.key(conn));
    navigate(`/${base64Encode(worktree)}/session`);
  };

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey
      ? server.list.find((conn) => ServerConnection.key(conn) === serverKey)
      : projectServer();
    if (!conn) return;
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result;
        if (directory) selectProject(directory, serverKey);
      },
    });
  };

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server:
      server.list.length > 1
        ? ServerConnection.key(projectServer())
        : undefined,
    select: selectProject,
    add: addProject,
  }));
}
