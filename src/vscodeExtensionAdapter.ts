import { randomBytes } from "node:crypto";

import { createDefaultCopilotLocalHarness } from "./copilotCliClient.js";
import type { CopilotInteractiveExecutor } from "./copilotCliClient.js";
import type {
  ApprovalMode,
  CreateDraftScheduleInput,
  HarnessMode,
  RunCadence,
  RunHistoryEntry,
  RunHistoryDetailView,
  RunCapInput,
  ScheduleDetailActionKind,
  ScheduleDetailAction,
  ScheduleHarnessModeAvailability,
  ScheduleDetailPreviousRun,
  ScheduleDetailView,
  ScheduleSummary,
  TargetContext,
  UpdateScheduleInput,
  WorkspaceTargetContext,
} from "./domain.js";
import { EditorControlSurface } from "./editorControlSurface.js";
import {
  LocalSchedulingSetup,
  type WakeupProvider,
  type WakeupTriggerRequest,
} from "./localSchedulingSetup.js";
import type {
  LocalSchedulingSetupResult,
  WakeupTriggerIntent,
} from "./localSchedulingSetup.js";
import { ScheduleLifecycle, SystemClock } from "./scheduleLifecycle.js";
import type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";
import {
  isScheduleModelAvailable,
  preferredScheduleModel,
  unavailableScheduleModelMessage,
} from "./scheduleModelCatalog.js";
import { SqliteScheduleStore } from "./sqliteScheduleStore.js";
import type {
  NaturalLanguageScheduleActivationProposal,
  NaturalLanguageScheduleCreationInput,
  NaturalLanguageScheduleCreationResult,
} from "./vscodeNaturalLanguageScheduleCreation.js";
import { VsCodeNaturalLanguageScheduleCreationFlow } from "./vscodeNaturalLanguageScheduleCreation.js";
import {
  SQLITE_LOCAL_STORE_FILENAME,
  prepareVsCodeLocalScheduling,
  sqliteLocalStorePath,
  type VsCodeGlobalStorageContextLike,
  type VsCodeInstalledExtensionContextLike,
  type PrepareVsCodeLocalSchedulingOptions,
} from "./vscodeLocalScheduling.js";

export type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";
export {
  VsCodeTaskCopilotInteractiveExecutor,
  type VsCodeCopilotTaskFactory,
  type VsCodeTaskExecutionLike,
  type VsCodeTaskProcessEndEventLike,
  type VsCodeTasksLike,
} from "./vscodeCopilotTaskExecutor.js";
export {
  CREATE_SCHEDULE_CHAT_PARTICIPANT_ID,
  CREATE_SCHEDULE_CHAT_SLASH_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_COMMAND,
  NEW_SCHEDULE_COMMAND,
  OPEN_SCHEDULE_COMMAND,
  RUN_HISTORY_DETAIL_VIEW_TYPE,
  SCHEDULE_DETAIL_VIEW_TYPE,
  SCHEDULE_LIST_VIEW_ID,
  ScheduleTreeDataProvider,
  SqliteDataVersionMonitor,
  buildNewDraftScheduleInput,
  createVsCodeScheduleModelCatalog,
  currentWorkspaceTargetContext,
  registerVsCodeScheduleCommands,
  scheduleTreeItemForSummary,
  type ScheduleTreeNode,
} from "./vscodeScheduleController.js";
import {
  parseScheduleDetailWebviewMessage,
  isLocalSchedulingWebviewAction,
  updateScheduleInputFromWebviewFields,
  type LocalSchedulingWebviewAction,
  type ScheduleDetailFormFields,
} from "./vscodeScheduleDetailMessages.js";
import {
  cadenceLabel,
  renderRunHistoryDetailHtml,
  renderScheduleDetailWebviewHtml,
  scheduleDetailTitle,
  targetContextLabel,
  type ScheduleDetailRenderState,
} from "./vscodeScheduleRenderers.js";
import {
  VsCodeSchedulePanelHost,
  type SchedulePanelLike,
} from "./vscodeSchedulePanelHost.js";
export {
  renderRunHistoryDetailHtml,
  renderScheduleDetailWebviewHtml,
} from "./vscodeScheduleRenderers.js";
export {
  SQLITE_LOCAL_STORE_FILENAME,
  deployPackagedWorker,
  localSchedulingWakeupRequestForVsCode,
  prepareVsCodeLocalScheduling,
  resolveNodeRuntimeExecutable,
  sqliteLocalStorePath,
  type DeployedWorker,
  type ResolveNodeRuntimeExecutableOptions,
  type PrepareVsCodeLocalSchedulingOptions,
  type VsCodeGlobalStorageContextLike,
  type VsCodeInstalledExtensionContextLike,
} from "./vscodeLocalScheduling.js";
import type {
  VsCodeCopilotTaskFactory,
  VsCodeTaskExecutionLike,
  VsCodeTaskProcessEndEventLike,
  VsCodeTasksLike,
} from "./vscodeCopilotTaskExecutor.js";

export const ENABLE_LOCAL_SCHEDULING_ACTION = "Enable Local Scheduling";

export interface VsCodeDisposableLike {
  dispose(): unknown;
}

export interface VsCodeEventLike<T> {
  (listener: (event: T) => unknown): VsCodeDisposableLike;
}

export interface VsCodeEventEmitterLike<T> extends VsCodeDisposableLike {
  event: VsCodeEventLike<T>;
  fire(event: T): void;
}

export interface VsCodeEventEmitterFactory {
  createEventEmitter<T>(): VsCodeEventEmitterLike<T>;
}

export interface VsCodeExtensionContextLike
  extends VsCodeGlobalStorageContextLike {
  subscriptions: VsCodeDisposableLike[];
}

export interface VsCodeWorkspaceFolderLike {
  name: string;
  uri: {
    toString(): string;
  };
}

export interface VsCodeWorkspaceLike {
  workspaceFolders?: readonly VsCodeWorkspaceFolderLike[];
}

export interface VsCodeCommandsLike {
  registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown,
  ): VsCodeDisposableLike;
}

export interface VsCodeLanguageModelToolInvocationOptionsLike {
  input: unknown;
}

export interface VsCodeLanguageModelToolLike {
  invoke(
    options: VsCodeLanguageModelToolInvocationOptionsLike,
    token?: unknown,
  ): Promise<unknown>;
}

export interface VsCodeLanguageModelChatLike {
  id: string;
  vendor?: string;
  family?: string;
  version?: string;
  name?: string;
  displayName?: string;
  maxInputTokens?: number;
}

export interface VsCodeLanguageModelLike {
  registerTool(
    name: string,
    tool: VsCodeLanguageModelToolLike,
  ): VsCodeDisposableLike;
  selectChatModels?(
    selector?: Record<string, unknown>,
  ): Promise<readonly VsCodeLanguageModelChatLike[]>;
  onDidChangeChatModels?: VsCodeEventLike<unknown>;
}

export interface VsCodeLanguageModelToolResultFactory {
  createTextPart(value: string): unknown;
  createToolResult(parts: unknown[]): unknown;
}

export interface VsCodeChatRequestLike {
  prompt: string;
  command?: string;
}

export interface VsCodeChatResponseStreamLike {
  markdown?(message: string): unknown;
  progress?(message: string): unknown;
}

export interface VsCodeChatParticipantLike extends VsCodeDisposableLike {}

export interface VsCodeChatLike {
  createChatParticipant(
    id: string,
    handler: (
      request: VsCodeChatRequestLike,
      context: unknown,
      stream: VsCodeChatResponseStreamLike,
      token: unknown,
    ) => unknown,
  ): VsCodeChatParticipantLike;
}

export interface VsCodeQuickPickItemLike {
  label: string;
  description?: string;
  detail?: string;
}

export interface VsCodeQuickPickOptionsLike {
  placeHolder: string;
}

export interface VsCodeWebviewPanelLike {
  title: string;
  webview: VsCodeWebviewLike;
  reveal?(showOptions?: unknown): unknown;
  dispose?(): unknown;
  onDidDispose?(listener: () => unknown): VsCodeDisposableLike;
}

export interface VsCodeWebviewLike {
  html: string;
  onDidReceiveMessage?(
    listener: (message: unknown) => unknown,
  ): VsCodeDisposableLike;
}

export interface VsCodeWindowLike {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: {
      enableScripts: boolean;
      retainContextWhenHidden: boolean;
    },
  ): VsCodeWebviewPanelLike;
  showQuickPick?<T extends VsCodeQuickPickItemLike>(
    items: readonly T[],
    options: VsCodeQuickPickOptionsLike,
  ): Promise<T | undefined>;
  showInputBox?(options: VsCodeInputBoxOptionsLike): Promise<string | undefined>;
  registerTreeDataProvider?<T>(
    viewId: string,
    provider: VsCodeTreeDataProviderLike<T>,
  ): VsCodeDisposableLike;
  showInformationMessage?(message: string, ...items: unknown[]): Promise<unknown>;
  showWarningMessage?(message: string, ...items: unknown[]): Promise<unknown>;
  showErrorMessage?(message: string): Promise<unknown>;
}


export interface VsCodeCommandLike {
  command: string;
  title: string;
  arguments?: unknown[];
}

export interface VsCodeInputBoxOptionsLike {
  prompt: string;
  placeHolder?: string;
}

export interface VsCodeTreeItemLike {
  label: string;
  description?: string;
  tooltip?: string;
  command?: VsCodeCommandLike;
  contextValue?: string;
}

export interface VsCodeTreeDataProviderLike<T> {
  onDidChangeTreeData?: VsCodeEventLike<T | undefined>;
  getChildren(element?: T): Promise<T[]> | T[];
  getTreeItem(element: T): VsCodeTreeItemLike;
}

export interface VsCodeScheduleEditor {
  createDraftSchedule(
    input: CreateDraftScheduleInput,
  ): Promise<ScheduleDetailView>;
  openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView>;
  saveScheduleDetailEdits(
    scheduleId: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleDetailView>;
  activateSchedule(scheduleId: string): Promise<ScheduleDetailView>;
  runScheduleNow(scheduleId: string): Promise<RunHistoryEntry>;
  pauseSchedule(scheduleId: string): Promise<ScheduleDetailView>;
  resumeSchedule(scheduleId: string): Promise<ScheduleDetailView>;
  restartCompletedSchedule(scheduleId: string): Promise<ScheduleDetailView>;
  deleteSchedule(scheduleId: string): Promise<void>;
  listSchedules(): Promise<ScheduleSummary[]>;
  listHarnessModeAvailability(): Promise<ScheduleHarnessModeAvailability[]>;
  listHarnessModels?(
    mode: HarnessMode,
  ): Promise<readonly ScheduleModelOption[]>;
  previewEnableLocalScheduling?(): WakeupTriggerIntent;
  enableLocalScheduling?(): Promise<LocalSchedulingSetupResult>;
  verifyLocalScheduling?(): Promise<LocalSchedulingSetupResult>;
  disableLocalScheduling?(): Promise<LocalSchedulingSetupResult>;
  openRunHistoryDetail?(runId: string): Promise<RunHistoryDetailView>;
  cancelRun?(runId: string): Promise<RunHistoryEntry>;
  openRun?(runId: string): Promise<unknown>;
}

export interface VsCodeSchedulerServices {
  editor: VsCodeScheduleEditor;
  lifecycle?: ScheduleLifecycle;
  localSchedulingSetupAvailability?: {
    available: boolean;
    canManage?: boolean;
    reason?: string;
  };
  dataVersion?: () => number;
  close?(): void;
}

export interface RegisterVsCodeScheduleCommandsOptions {
  context: VsCodeExtensionContextLike;
  commands: VsCodeCommandsLike;
  window: VsCodeWindowLike;
  workspace: VsCodeWorkspaceLike;
  services: VsCodeSchedulerServices;
  viewColumn: unknown;
  eventEmitterFactory?: VsCodeEventEmitterFactory;
  languageModel?: VsCodeLanguageModelLike;
  modelCatalog?: ScheduleModelCatalog;
  languageModelToolResultFactory?: VsCodeLanguageModelToolResultFactory;
  chat?: VsCodeChatLike;
}

export async function confirmEnableLocalScheduling(
  window: VsCodeWindowLike,
  intent: WakeupTriggerIntent,
): Promise<boolean> {
  const selected = await window.showWarningMessage?.(
    "Enable Local Scheduling?",
    {
      modal: true,
      detail: [
        "One per-user OS wakeup trigger will be installed.",
        `Platform: ${intent.platform}`,
        `Trigger: ${intent.triggerId}`,
        `Interval: every ${intent.intervalMinutes} minutes`,
        `Worker: ${intent.workerCommand}`,
        ...intent.commands.map((command) => `Command: ${command.shellCommand}`),
        ...intent.files.flatMap((file) => [
          `File: ${file.path}`,
          `Contents:\n${file.contents}`,
        ]),
      ].join("\n"),
    },
    ENABLE_LOCAL_SCHEDULING_ACTION,
  );
  return selected === ENABLE_LOCAL_SCHEDULING_ACTION;
}

export interface CreateDefaultVsCodeSchedulerServicesOptions
  extends PrepareVsCodeLocalSchedulingOptions {
  window: VsCodeWindowLike;
  interactiveExecutor?: CopilotInteractiveExecutor;
}

export function createDefaultVsCodeSchedulerServices(
  context: VsCodeInstalledExtensionContextLike,
  options: CreateDefaultVsCodeSchedulerServicesOptions,
): VsCodeSchedulerServices {
  const prepared = prepareVsCodeLocalScheduling(context, options);
  if (!prepared.available) {
    return createUnavailableLocalSchedulingServices(
      context,
      prepared.reason,
      options.interactiveExecutor,
      prepared.management
        ? { ...prepared.management, window: options.window }
        : undefined,
    );
  }
  const store = new SqliteScheduleStore({
    databasePath: sqliteLocalStorePath(context),
  });
  const localSchedulingSetup = new LocalSchedulingSetup({
    store,
    provider: prepared.provider,
    request: prepared.request,
    clock: new SystemClock(),
  });
  const lifecycle = new ScheduleLifecycle({
    store,
    harnesses: [
      createDefaultCopilotLocalHarness(
        options.interactiveExecutor
          ? { interactiveExecutor: options.interactiveExecutor }
          : {},
      ),
    ],
    localSchedulingSetup,
  });

  return {
    editor: new EditorControlSurface(lifecycle, {
      localSchedulingSetup,
      confirmEnableLocalScheduling: (intent) =>
        confirmEnableLocalScheduling(options.window, intent),
    }),
    lifecycle,
    localSchedulingSetupAvailability: { available: true },
    dataVersion: () => store.dataVersion(),
    close: () => store.close(),
  };
}

function createUnavailableLocalSchedulingServices(
  context: VsCodeInstalledExtensionContextLike,
  reason: string,
  interactiveExecutor?: CopilotInteractiveExecutor,
  management?: {
    provider: WakeupProvider;
    request: WakeupTriggerRequest;
    window: VsCodeWindowLike;
  },
): VsCodeSchedulerServices {
  const store = new SqliteScheduleStore({
    databasePath: sqliteLocalStorePath(context),
  });
  const localSchedulingSetup = management
    ? new LocalSchedulingSetup({
        store,
        provider: management.provider,
        request: management.request,
        clock: new SystemClock(),
      })
    : undefined;
  const lifecycle = new ScheduleLifecycle({
    store,
    harnesses: [
      createDefaultCopilotLocalHarness(
        interactiveExecutor ? { interactiveExecutor } : {},
      ),
    ],
    localSchedulingSetup:
      localSchedulingSetup ?? {
        isLocalSchedulingEnabled: async () =>
          (await store.getLocalSchedulingSetup()).enabled,
        getLocalSchedulingSetupState: async () =>
          store.getLocalSchedulingSetup(),
      },
  });
  return {
    editor: new EditorControlSurface(
      lifecycle,
      localSchedulingSetup
        ? {
            localSchedulingSetup,
            enableLocalSchedulingUnavailableReason: reason,
            confirmEnableLocalScheduling: (intent) =>
              confirmEnableLocalScheduling(management!.window, intent),
          }
        : {},
    ),
    lifecycle,
    localSchedulingSetupAvailability: {
      available: false,
      canManage: localSchedulingSetup !== undefined,
      reason,
    },
    dataVersion: () => store.dataVersion(),
    close: () => store.close(),
  };
}
