import { createDefaultCopilotLocalHarness } from "./copilotCliClient.js";
import type { CopilotInteractiveExecutor } from "./copilotCliClient.js";
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
import { SqliteScheduleStore } from "./sqliteScheduleStore.js";
import {
  SQLITE_LOCAL_STORE_FILENAME,
  prepareVsCodeLocalScheduling,
  sqliteLocalStorePath,
  type VsCodeGlobalStorageContextLike,
  type VsCodeInstalledExtensionContextLike,
  type PrepareVsCodeLocalSchedulingOptions,
} from "./vscodeLocalScheduling.js";
import type {
  VsCodeSchedulerServices,
  VsCodeWindowLike,
} from "./vscodeContracts.js";

export * from "./vscodeContracts.js";

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

export const ENABLE_LOCAL_SCHEDULING_ACTION = "Enable Local Scheduling";

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
