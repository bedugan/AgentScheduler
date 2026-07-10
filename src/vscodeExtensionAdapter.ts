import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, posix, win32 } from "node:path";

import { createDefaultCopilotLocalHarness } from "./copilotCliClient.js";
import type { CopilotInteractiveExecutor } from "./copilotCliClient.js";
import type {
  ApprovalMode,
  CreateDraftScheduleInput,
  HarnessMode,
  RunCadence,
  RunHistoryEntry,
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
  MacOsLaunchdWakeupProvider,
  WindowsTaskSchedulerWakeupProvider,
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

export type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";

export const CREATE_SCHEDULE_COMMAND = "agentScheduler.createSchedule";
export const CREATE_SCHEDULE_TOOL_NAME = "agentScheduler_createSchedule";
export const CREATE_SCHEDULE_CHAT_PARTICIPANT_ID = "agentScheduler.schedule";
export const CREATE_SCHEDULE_CHAT_SLASH_COMMAND = "createSchedule";
export const NEW_SCHEDULE_COMMAND = "agentScheduler.newSchedule";
export const OPEN_SCHEDULE_COMMAND = "agentScheduler.openSchedule";
export const DELETE_SCHEDULE_COMMAND = "agentScheduler.deleteSchedule";
export const SCHEDULE_LIST_VIEW_ID = "agentScheduler.scheduleList";
export const SCHEDULE_DETAIL_VIEW_TYPE = "agentScheduler.scheduleDetail";
export const SQLITE_LOCAL_STORE_FILENAME = "agent-scheduler.sqlite";
export const ENABLE_LOCAL_SCHEDULING_ACTION = "Enable Local Scheduling";

const DEFAULT_HOURLY_CADENCE = {
  type: "cron",
  expression: "0 * * * *",
} as const satisfies RunCadence;

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

export interface VsCodeGlobalStorageContextLike {
  globalStorageUri: {
    fsPath: string;
  };
}

export interface VsCodeInstalledExtensionContextLike
  extends VsCodeGlobalStorageContextLike {
  extensionUri: { fsPath: string };
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

export interface VsCodeTaskExecutionLike {}

export interface VsCodeTaskProcessEndEventLike {
  execution: VsCodeTaskExecutionLike;
  exitCode: number | undefined;
}

export interface VsCodeTasksLike {
  executeTask(task: unknown): Promise<VsCodeTaskExecutionLike>;
  onDidEndTaskProcess(
    listener: (event: VsCodeTaskProcessEndEventLike) => unknown,
  ): VsCodeDisposableLike;
}

export interface VsCodeCopilotTaskFactory {
  createCopilotTask(
    name: string,
    command: string,
    args: readonly string[],
  ): unknown;
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
}

export interface VsCodeSchedulerServices {
  editor: VsCodeScheduleEditor;
  lifecycle?: ScheduleLifecycle;
  localSchedulingSetupAvailability?: {
    available: boolean;
    canManage?: boolean;
    reason?: string;
  };
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

interface ScheduleQuickPickItem extends VsCodeQuickPickItemLike {
  scheduleId: string;
}

export type ScheduleTreeNode =
  | {
      kind: "schedule";
      schedule: ScheduleSummary;
    }
  | {
      kind: "empty";
    };

interface ScheduleDetailRenderState {
  errorMessage?: string;
  modelOptions?: readonly ScheduleModelOption[];
  modelCatalogAvailable?: boolean;
  localSchedulingSetupAvailability?: {
    available: boolean;
    canManage?: boolean;
    reason?: string;
  };
}

interface ScheduleDetailFormFields {
  runInstructions?: unknown;
  cadenceExpression?: unknown;
  targetContextUri?: unknown;
  targetContextLabel?: unknown;
  harnessMode?: unknown;
  model?: unknown;
  approvalMode?: unknown;
  runCapMaxRuns?: unknown;
}

type ScheduleDetailWebviewMessage =
  | {
      type: "save";
      scheduleId: string;
      fields: ScheduleDetailFormFields;
    }
  | {
      type: ScheduleDetailActionKind;
      scheduleId: string;
      fields?: ScheduleDetailFormFields;
    }
  | {
      type: LocalSchedulingWebviewAction;
      scheduleId: string;
    };

type LocalSchedulingWebviewAction =
  | "enable-local-scheduling"
  | "verify-local-scheduling"
  | "disable-local-scheduling";

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

export function sqliteLocalStorePath(
  context: VsCodeGlobalStorageContextLike,
): string {
  return join(context.globalStorageUri.fsPath, SQLITE_LOCAL_STORE_FILENAME);
}

export interface ResolveNodeRuntimeExecutableOptions {
  configuredPath?: string;
  processExecutable?: string;
  searchPath?: string;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  probeRuntime?: (path: string) => boolean;
  workerPath?: string;
  workerPlatform?: "windows" | "macos";
  userId?: number;
}

export function resolveNodeRuntimeExecutable(
  options: ResolveNodeRuntimeExecutableOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const probeRuntime =
    options.probeRuntime ??
    ((candidate: string) => probeNodeRuntime(candidate, options));
  const pathApi = platform === "win32" ? win32 : posix;
  const candidates = [
    options.configuredPath,
    options.processExecutable ?? process.execPath,
    ...(options.searchPath ?? process.env.PATH ?? "")
      .split(platform === "win32" ? ";" : ":")
      .filter(Boolean)
      .map((directory) =>
        pathApi.join(directory, platform === "win32" ? "node.exe" : "node"),
      ),
  ];

  for (const candidate of candidates) {
    if (!candidate || !pathApi.isAbsolute(candidate) || !fileExists(candidate)) {
      continue;
    }
    const executableName = pathApi.basename(candidate).toLowerCase();
    if (
      (executableName === "node" || executableName === "node.exe") &&
      probeRuntime(candidate)
    ) {
      return candidate;
    }
  }

  throw new Error(
    "Local Scheduling requires an absolute Node.js executable. Configure AGENT_SCHEDULER_NODE_PATH or install node on PATH; the VS Code Electron executable cannot run the worker.",
  );
}

function probeNodeRuntime(
  candidate: string,
  options: ResolveNodeRuntimeExecutableOptions,
): boolean {
  const capabilityProbe = spawnSync(
    candidate,
    [
      "-e",
      "const major=Number(process.versions.node.split('.')[0]);require('node:sqlite');if(major<26)process.exit(1)",
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (capabilityProbe.status !== 0 || !options.workerPath) {
    return capabilityProbe.status === 0 && options.workerPath === undefined;
  }

  const platform = options.workerPlatform ?? "windows";
  const args = [
    options.workerPath,
    "local-scheduling",
    "install",
    "--dry-run",
    "--platform",
    platform,
    "--store",
    join(dirname(options.workerPath), "probe.sqlite"),
    "--node",
    candidate,
    "--worker",
    options.workerPath,
  ];
  if (platform === "macos") {
    args.push("--user-id", String(options.userId ?? 0));
  }
  const workerModuleUrl = pathToFileURL(options.workerPath).href;
  const probeScript = `import { runWorkerCli } from ${JSON.stringify(workerModuleUrl)}; process.exitCode = await runWorkerCli(${JSON.stringify(args.slice(1))}, { stdout: process.stdout, stderr: process.stderr });`;
  const workerProbe = spawnSync(candidate, ["--input-type=module", "-e", probeScript], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return workerProbe.status === 0 && /"dryRun":true/.test(workerProbe.stdout);
}

export interface DeployedWorker {
  workerPath: string;
  fingerprint: string;
}

export function deployPackagedWorker(
  context: VsCodeInstalledExtensionContextLike,
): DeployedWorker {
  const sourceDirectory = join(context.extensionUri.fsPath, "dist", "src");
  const manifest = workerManifestFor(sourceDirectory);
  const fingerprint = manifest.fingerprint;
  const targetDirectory = join(
    context.globalStorageUri.fsPath,
    "worker",
    fingerprint,
  );
  if (!validWorkerDeployment(targetDirectory, manifest)) {
    const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
    const temporaryDirectory = `${targetDirectory}.tmp.${suffix}`;
    const corruptDirectory = `${targetDirectory}.corrupt.${suffix}`;
    let movedCorruptDeployment = false;
    try {
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      cpSync(sourceDirectory, temporaryDirectory, { recursive: true });
      writeFileSync(
        join(temporaryDirectory, "deployment.json"),
        `${JSON.stringify(manifest)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (!validWorkerDeployment(temporaryDirectory, manifest)) {
        throw new Error("Deployed Worker failed manifest verification.");
      }
      if (existsSync(targetDirectory)) {
        renameSync(targetDirectory, corruptDirectory);
        movedCorruptDeployment = true;
      }
      renameSync(temporaryDirectory, targetDirectory);
      rmSync(corruptDirectory, { recursive: true, force: true });
      movedCorruptDeployment = false;
    } catch (error) {
      if (movedCorruptDeployment && !existsSync(targetDirectory)) {
        renameSync(corruptDirectory, targetDirectory);
      }
      throw error;
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return {
    workerPath: join(targetDirectory, "workerCli.js"),
    fingerprint,
  };
}

interface WorkerDeploymentManifest {
  fingerprint: string;
  files: Record<string, string>;
}

function workerManifestFor(directory: string): WorkerDeploymentManifest {
  const files: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        visit(path);
      } else if (name !== "deployment.json") {
        const relativePath = path.slice(directory.length + 1).replaceAll("\\", "/");
        files[relativePath] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  visit(directory);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return { fingerprint, files };
}

function validWorkerDeployment(
  directory: string,
  expected: WorkerDeploymentManifest,
): boolean {
  try {
    const recorded = JSON.parse(
      readFileSync(join(directory, "deployment.json"), "utf8"),
    ) as WorkerDeploymentManifest;
    const actual = workerManifestFor(directory);
    return (
      recorded.fingerprint === expected.fingerprint &&
      JSON.stringify(recorded.files) === JSON.stringify(expected.files) &&
      actual.fingerprint === expected.fingerprint &&
      JSON.stringify(actual.files) === JSON.stringify(expected.files)
    );
  } catch {
    return false;
  }
}

export function localSchedulingWakeupRequestForVsCode(
  context: VsCodeInstalledExtensionContextLike,
  options: {
    nodeExecutable: string;
    platform: NodeJS.Platform;
    userId?: number;
    homeDirectory?: string;
    workerPath?: string;
  },
): WakeupTriggerRequest {
  const triggerId =
    options.platform === "darwin"
      ? "com.bedugan.AgentScheduler.local-wakeup"
      : "AgentSchedulerLocalWakeup";
  const workerPath =
    options.workerPath ??
    join(context.extensionUri.fsPath, "dist", "src", "workerCli.js");
  const request: WakeupTriggerRequest = {
    triggerId,
    workerExecutable: options.nodeExecutable,
    workerArguments: [
      workerPath,
      "scan-due-work",
      "--store",
      sqliteLocalStorePath(context),
    ],
    intervalMinutes: 5,
  };
  if (options.platform === "darwin") {
    request.launchdPlistPath = join(
      options.homeDirectory ?? homedir(),
      "Library",
      "LaunchAgents",
      `${triggerId}.plist`,
    );
    if (options.userId === undefined) {
      throw new Error("Local Scheduling requires a macOS user id for launchd.");
    }
    request.userId = options.userId;
  }
  return request;
}

export interface CreateDefaultVsCodeSchedulerServicesOptions {
  window: VsCodeWindowLike;
  interactiveExecutor?: CopilotInteractiveExecutor;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  userId?: number;
  provider?: WakeupProvider;
  homeDirectory?: string;
  runtimeProbe?: (path: string) => boolean;
}

export function createDefaultVsCodeSchedulerServices(
  context: VsCodeInstalledExtensionContextLike,
  options: CreateDefaultVsCodeSchedulerServicesOptions,
): VsCodeSchedulerServices {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    return createUnavailableLocalSchedulingServices(
      context,
      `Local Scheduling is not supported on ${platform}. Schedule editing and Manual Run Now remain available.`,
      options.interactiveExecutor,
    );
  }
  const deployedWorker = deployPackagedWorker(context);
  const provider =
    options.provider ??
    (platform === "win32"
      ? new WindowsTaskSchedulerWakeupProvider()
      : new MacOsLaunchdWakeupProvider());
  const userId =
    platform === "darwin" ? options.userId ?? process.getuid?.() : undefined;
  const configuredNodeExecutable =
    options.nodeExecutable ?? process.env.AGENT_SCHEDULER_NODE_PATH;
  let nodeExecutable: string;
  try {
    nodeExecutable = resolveNodeRuntimeExecutable({
      ...(configuredNodeExecutable && {
        configuredPath: configuredNodeExecutable,
      }),
      processExecutable: process.execPath,
      ...(process.env.PATH && { searchPath: process.env.PATH }),
      platform,
      ...(options.runtimeProbe && { probeRuntime: options.runtimeProbe }),
      workerPath: deployedWorker.workerPath,
      workerPlatform: platform === "win32" ? "windows" : "macos",
      ...(options.userId !== undefined && { userId: options.userId }),
    });
  } catch (error) {
    const managementRequest = localSchedulingWakeupRequestForVsCode(context, {
      nodeExecutable: configuredNodeExecutable ?? process.execPath,
      platform,
      ...(userId !== undefined && { userId }),
      ...(options.homeDirectory && { homeDirectory: options.homeDirectory }),
      workerPath: deployedWorker.workerPath,
    });
    return createUnavailableLocalSchedulingServices(
      context,
      `${errorMessageFor(error)} Schedule editing and Manual Run Now remain available.`,
      options.interactiveExecutor,
      {
        provider,
        request: managementRequest,
        window: options.window,
      },
    );
  }
  const request = localSchedulingWakeupRequestForVsCode(context, {
    nodeExecutable,
    platform,
    ...(userId !== undefined && { userId }),
    ...(options.homeDirectory && { homeDirectory: options.homeDirectory }),
    workerPath: deployedWorker.workerPath,
  });
  const store = new SqliteScheduleStore({
    databasePath: sqliteLocalStorePath(context),
  });
  const localSchedulingSetup = new LocalSchedulingSetup({
    store,
    provider,
    request,
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
    close: () => store.close(),
  };
}

export class VsCodeTaskCopilotInteractiveExecutor
  implements CopilotInteractiveExecutor
{
  constructor(
    private readonly tasks: VsCodeTasksLike,
    private readonly taskFactory: VsCodeCopilotTaskFactory,
  ) {}

  async run(
    command: string,
    args: readonly string[],
    request: Parameters<CopilotInteractiveExecutor["run"]>[2],
  ) {
    const name = `AgentScheduler: ${request.schedule.id}`;
    const task = this.taskFactory.createCopilotTask(name, command, args);
    let execution: VsCodeTaskExecutionLike | undefined;
    const earlyEvents: VsCodeTaskProcessEndEventLike[] = [];
    let resolveCompletion:
      | ((result: Awaited<ReturnType<CopilotInteractiveExecutor["run"]>>) => void)
      | undefined;
    const completion = new Promise<
      Awaited<ReturnType<CopilotInteractiveExecutor["run"]>>
    >((resolve) => {
      resolveCompletion = resolve;
    });
    const complete = (event: VsCodeTaskProcessEndEventLike): void => {
      subscription.dispose();
      const completed = event.exitCode === 0;
      resolveCompletion?.({
        externalRunId: `vscode-task:${request.schedule.id}:${request.requestedAt}`,
        status: completed ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        summary: completed
          ? "Interactive Copilot task completed in the VS Code terminal."
          : `Interactive Copilot task exited with code ${event.exitCode ?? "unknown"}.`,
        executedModel: null,
      });
    };
    const subscription = this.tasks.onDidEndTaskProcess((event) => {
      if (!execution) {
        earlyEvents.push(event);
        return;
      }
      if (event.execution === execution) {
        complete(event);
      }
    });

    try {
      execution = await this.tasks.executeTask(task);
    } catch (error) {
      subscription.dispose();
      throw error;
    }

    const earlyCompletion = earlyEvents.find(
      (event) => event.execution === execution,
    );
    if (earlyCompletion) {
      complete(earlyCompletion);
    }
    return completion;
  }
}

export function buildNewDraftScheduleInput(
  workspace: VsCodeWorkspaceLike,
  defaultModel = "auto",
  defaultHarnessMode: HarnessMode | null = "local-copilot",
): CreateDraftScheduleInput {
  return {
    runInstructions: "",
    cadence: DEFAULT_HOURLY_CADENCE,
    targetContext: currentWorkspaceTargetContext(workspace),
    harnessMode: defaultHarnessMode,
    model: defaultModel,
    approvalMode: "default-approvals",
  };
}

export function currentWorkspaceTargetContext(
  workspace: VsCodeWorkspaceLike,
): WorkspaceTargetContext | null {
  const folder = workspace.workspaceFolders?.[0];
  if (!folder) {
    return null;
  }

  const targetContext: WorkspaceTargetContext = {
    type: "workspace",
    uri: folder.uri.toString(),
  };
  if (folder.name.trim().length > 0) {
    targetContext.label = folder.name;
  }

  return targetContext;
}

export function createVsCodeScheduleModelCatalog(
  languageModel: VsCodeLanguageModelLike | undefined,
): ScheduleModelCatalog | undefined {
  if (!languageModel?.selectChatModels) {
    return undefined;
  }

  return {
    listScheduleModels: async () => {
      try {
        const chatModels = await languageModel.selectChatModels?.();
        return normalizeScheduleModelOptions(chatModels ?? []);
      } catch {
        return [];
      }
    },
    ...(languageModel.onDidChangeChatModels && {
      onDidChangeScheduleModels: (listener: () => unknown) =>
        languageModel.onDidChangeChatModels?.(() => listener()) ?? {
          dispose: () => {},
        },
    }),
  };
}

function normalizeScheduleModelOptions(
  models: readonly VsCodeLanguageModelChatLike[],
): ScheduleModelOption[] {
  const uniqueModels = new Map<string, ScheduleModelOption>();
  for (const model of models) {
    if (model.id.trim().length === 0 || uniqueModels.has(model.id)) {
      continue;
    }

    uniqueModels.set(model.id, scheduleModelOptionFor(model));
  }

  return [...uniqueModels.values()].sort((left, right) => {
    const leftRank = isCopilotScheduleModel(left) ? 0 : 1;
    const rightRank = isCopilotScheduleModel(right) ? 0 : 1;
    return (
      leftRank - rightRank || left.displayName.localeCompare(right.displayName)
    );
  });
}

function scheduleModelOptionFor(
  model: VsCodeLanguageModelChatLike,
): ScheduleModelOption {
  return {
    id: model.id,
    displayName: model.displayName ?? model.name ?? model.id,
    ...(model.vendor ? { vendor: model.vendor } : {}),
    ...(model.family ? { family: model.family } : {}),
    ...(model.version ? { version: model.version } : {}),
    ...(typeof model.maxInputTokens === "number"
      ? { maxInputTokens: model.maxInputTokens }
      : {}),
  };
}

function isCopilotScheduleModel(model: ScheduleModelOption): boolean {
  return [model.vendor, model.family, model.displayName, model.id].some((value) =>
    /\bcopilot\b|github\.copilot/i.test(value ?? ""),
  );
}

function createScheduleCreationFlow(
  options: RegisterVsCodeScheduleCommandsOptions,
  modelCatalog: ScheduleModelCatalog | undefined,
): VsCodeNaturalLanguageScheduleCreationFlow | undefined {
  if (!options.services.lifecycle) {
    return undefined;
  }

  const currentWorkspace = currentWorkspaceTargetContext(options.workspace);
  return new VsCodeNaturalLanguageScheduleCreationFlow({
    lifecycle: options.services.lifecycle,
    ...(currentWorkspace ? { currentWorkspace } : {}),
    defaultModel: "auto",
    ...(modelCatalog ? { modelCatalog } : {}),
    confirmActivation: (proposal) =>
      confirmNaturalLanguageScheduleActivation(options.window, proposal),
  });
}

export function registerVsCodeScheduleCommands(
  options: RegisterVsCodeScheduleCommandsOptions,
): VsCodeDisposableLike[] {
  const vsCodeModelCatalog = createVsCodeScheduleModelCatalog(
    options.languageModel,
  );
  const modelCatalog = options.modelCatalog ??
    (options.services.editor.listHarnessModels
      ? {
          listScheduleModels: async () => {
            const models = await options.services.editor.listHarnessModels?.(
              "local-copilot",
            );
            return models && models.length > 0
              ? models
              : (await vsCodeModelCatalog?.listScheduleModels()) ?? [];
          },
          ...(vsCodeModelCatalog?.onDidChangeScheduleModels && {
            onDidChangeScheduleModels:
              vsCodeModelCatalog.onDidChangeScheduleModels,
          }),
        }
      : vsCodeModelCatalog);
  const scheduleTreeProvider =
    options.eventEmitterFactory && options.window.registerTreeDataProvider
      ? new ScheduleTreeDataProvider(
          options.services.editor,
          options.eventEmitterFactory,
        )
      : undefined;
  const scheduleCreationFlow = createScheduleCreationFlow(options, modelCatalog);
  const controller = new VsCodeScheduleCommandController({
    ...options,
    ...(modelCatalog ? { modelCatalog } : {}),
    scheduleTreeProvider,
    scheduleCreationFlow,
  });
  const disposables = [
    options.commands.registerCommand(NEW_SCHEDULE_COMMAND, () =>
      controller.createNewSchedule(),
    ),
    options.commands.registerCommand(OPEN_SCHEDULE_COMMAND, (scheduleId) =>
      controller.openSchedule(scheduleId),
    ),
    options.commands.registerCommand(DELETE_SCHEDULE_COMMAND, (target) =>
      controller.deleteSchedule(target),
    ),
  ];
  if (scheduleCreationFlow) {
    disposables.push(
      options.commands.registerCommand(CREATE_SCHEDULE_COMMAND, (input) =>
        controller.executeScheduleCreationSlashCommand(input),
      ),
    );
  }
  if (scheduleCreationFlow && options.languageModel) {
    disposables.push(
      options.languageModel.registerTool(CREATE_SCHEDULE_TOOL_NAME, {
        invoke: (toolInvocation) =>
          controller.invokeScheduleCreationTool(toolInvocation.input),
      }),
    );
  }
  if (scheduleCreationFlow && options.chat) {
    disposables.push(
      options.chat.createChatParticipant(
        CREATE_SCHEDULE_CHAT_PARTICIPANT_ID,
        (request, _context, stream) =>
          controller.handleScheduleCreationChatRequest(request, stream),
      ),
    );
  }
  if (scheduleTreeProvider && options.window.registerTreeDataProvider) {
    disposables.push(
      options.window.registerTreeDataProvider(
        SCHEDULE_LIST_VIEW_ID,
        scheduleTreeProvider,
      ),
      scheduleTreeProvider,
    );
  }

  options.context.subscriptions.push(...disposables);
  return disposables;
}

export function renderScheduleDetailWebviewHtml(
  view: ScheduleDetailView,
  state: ScheduleDetailRenderState = {},
): string {
  const scriptNonce = randomBytes(16).toString("base64");
  const overviewRows: Array<[string, string]> = [
    ["Status", view.overview.status],
    ["Enabled", view.overview.enabled ? "Yes" : "No"],
    ["Target Context", targetContextLabel(view.overview.targetContext)],
    ["Cadence", cadenceSummaryLabel(view.overview.cadence)],
    ["Harness Mode", harnessModeOverviewLabel(view)],
    ["Model", modelOverviewLabel(view.overview.model, state.modelOptions)],
    ["Approval Mode", view.overview.approvalMode],
    ["Run Counter", view.overview.runCounter.label],
    ["Next Run", nextRunDisplayLabel(view)],
    ["Last Run", view.overview.lastRunAt ?? "Never"],
    ["Harness Availability", view.harnessAvailability.message],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <title>${escapeHtml(scheduleDetailTitle(view))}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    body {
      margin: 0;
      padding: 20px;
    }

    h1, h2 {
      margin: 0;
      font-weight: 600;
      letter-spacing: 0;
    }

    h1 {
      font-size: 20px;
    }

    h2 {
      font-size: 14px;
      margin-bottom: 10px;
    }

    section {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 16px 0;
    }

    .header {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px 12px;
      padding-bottom: 16px;
    }

    .muted {
      color: var(--vscode-descriptionForeground);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 10px 18px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    label, dt {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    textarea, input, select {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }

    select {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border-color: var(--vscode-dropdown-border);
    }

    textarea {
      min-height: 96px;
      resize: vertical;
    }

    .form-actions {
      margin-top: 12px;
    }

    .inline-error {
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 8px 10px;
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-errorBackground);
    }

    .field-note {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.4;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 6px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
    }

    button[disabled] {
      color: var(--vscode-disabledForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px 6px;
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
    }
  </style>
</head>
<body>
  <header class="header">
    <h1>${escapeHtml(scheduleDetailTitle(view))}</h1>
    <span class="muted">${escapeHtml(view.schedule.id)}</span>
  </header>

  ${state.errorMessage ? renderInlineError(state.errorMessage) : ""}

  <section aria-labelledby="overview-heading">
    <h2 id="overview-heading">Overview</h2>
    <dl class="grid">
      ${overviewRows
        .map(
          ([label, value]) => `<div>
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>`,
        )
        .join("\n")}
    </dl>
  </section>

  <form id="schedule-detail-form" data-schedule-id="${escapeHtml(view.schedule.id)}">
    <section aria-labelledby="fields-heading">
      <h2 id="fields-heading">Editable Fields</h2>
      <div class="grid">
        <div class="field">
          <label for="run-instructions">Run Instructions</label>
          <textarea id="run-instructions" name="runInstructions">${escapeHtml(
            view.runInstructions.value,
          )}</textarea>
        </div>
        ${renderInput(
          "cadence-expression",
          "Cron Expression",
          "cadenceExpression",
          cadenceInputValue(view.overview.cadence),
        )}
        ${renderInput(
          "target-context-uri",
          "Target Context URI",
          "targetContextUri",
          targetContextInputValue(view.overview.targetContext),
        )}
        ${renderInput(
          "target-context-label",
          "Target Context Label",
          "targetContextLabel",
          targetContextLabelInputValue(view.overview.targetContext),
        )}
        ${renderHarnessModeField(view)}
        ${renderModelField(view.overview.model, state)}
        ${renderSelect("approval-mode", "Approval Mode", "approvalMode", [
          [
            "default-approvals",
            "Default Approvals",
            view.overview.approvalMode === "default-approvals",
          ],
          [
            "bypass-approvals",
            "Bypass Approvals",
            view.overview.approvalMode === "bypass-approvals",
          ],
          [
            "autopilot",
            "Autopilot",
            view.overview.approvalMode === "autopilot",
          ],
        ])}
        ${renderInput(
          "run-cap-max-runs",
          "Maximum Run Count",
          "runCapMaxRuns",
          runCapInputValue(view.runCounter),
          "number",
          ' min="1"',
        )}
      </div>
      <div class="form-actions">
        <button type="submit" data-action="save">Save Changes</button>
      </div>
    </section>
  </form>

  <section aria-labelledby="actions-heading">
    <h2 id="actions-heading">Actions</h2>
    <div class="actions">
      ${Object.values(view.actions).map(renderAction).join("\n")}
    </div>
  </section>

  <section aria-labelledby="local-scheduling-heading">
    <h2 id="local-scheduling-heading">Local Scheduling</h2>
    <p><strong>${view.localScheduling.enabled ? "Enabled" : "Disabled"}</strong></p>
    <p>${escapeHtml(view.localScheduling.message)}</p>
    ${state.localSchedulingSetupAvailability?.available === false && state.localSchedulingSetupAvailability.reason ? `<p class="field-note">${escapeHtml(state.localSchedulingSetupAvailability.reason)}</p>` : ""}
    <div class="actions">
      ${renderLocalSchedulingActions(view.localScheduling.enabled, state.localSchedulingSetupAvailability)}
    </div>
  </section>

  <section aria-labelledby="previous-runs-heading">
    <h2 id="previous-runs-heading">Previous Runs</h2>
    ${renderPreviousRuns(view.previousRuns)}
  </section>
  ${renderScheduleDetailScript(scriptNonce)}
</body>
</html>`;
}

function renderLocalSchedulingActions(
  enabled: boolean,
  availability: ScheduleDetailRenderState["localSchedulingSetupAvailability"],
): string {
  if (availability?.available === false) {
    const reason = availability.reason
      ? ` title="${escapeHtml(availability.reason)}"`
      : "";
    if (enabled && availability.canManage) {
      return [
        '<button type="button" data-action="verify-local-scheduling">Verify Local Scheduling</button>',
        '<button type="button" data-action="disable-local-scheduling">Disable Local Scheduling</button>',
      ].join("\n");
    }
    return `<button type="button" data-action="enable-local-scheduling" disabled${reason}>Enable Local Scheduling</button>`;
  }
  return enabled
    ? [
        '<button type="button" data-action="verify-local-scheduling">Verify Local Scheduling</button>',
        '<button type="button" data-action="disable-local-scheduling">Disable Local Scheduling</button>',
      ].join("\n")
    : '<button type="button" data-action="enable-local-scheduling">Enable Local Scheduling</button>';
}

function renderInlineError(message: string): string {
  return `<div role="alert" class="inline-error">${escapeHtml(message)}</div>`;
}

function renderInput(
  id: string,
  label: string,
  name: string,
  value: string,
  type = "text",
  attributes = "",
  note?: string,
): string {
  return `<div class="field">
        <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
        <input id="${escapeHtml(id)}" name="${escapeHtml(
          name,
        )}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"${attributes}>
        ${note ? renderFieldNote(note) : ""}
      </div>`;
}

function renderSelect(
  id: string,
  label: string,
  name: string,
  options: Array<[string, string, boolean]>,
  note?: string,
): string {
  return `<div class="field">
        <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
        <select id="${escapeHtml(id)}" name="${escapeHtml(name)}">
          ${options
            .map(
              ([value, optionLabel, selected]) =>
                `<option value="${escapeHtml(value)}"${
                  selected ? " selected" : ""
                }>${escapeHtml(optionLabel)}</option>`,
            )
            .join("\n")}
        </select>
        ${note ? renderFieldNote(note) : ""}
      </div>`;
}

function renderFieldNote(note: string): string {
  return `<p class="field-note">${escapeHtml(note)}</p>`;
}

function renderHarnessModeField(view: ScheduleDetailView): string {
  const selectedMode = view.overview.harnessMode;
  const availableModes = view.harnessAvailability.modes.filter(
    (mode) => mode.available,
  );
  const unavailableSetupReason = view.harnessAvailability.modes.find(
    (mode) =>
      !mode.available &&
      mode.reason &&
      !/no .* harness is registered/i.test(mode.reason),
  )?.reason;
  const selectedAvailable = availableModes.some(
    (mode) => mode.mode === selectedMode,
  );
  const options: Array<[string, string, boolean]> = [
    ["", "Not selected", selectedMode === null],
  ];

  if (selectedMode && !selectedAvailable) {
    options.push([
      selectedMode,
      `${harnessModeLabel(view.harnessAvailability.selected)} (unavailable)`,
      true,
    ]);
  }

  options.push(
    ...availableModes.map(
      (mode): [string, string, boolean] => [
        mode.mode,
        mode.label,
        mode.mode === selectedMode,
      ],
    ),
  );

  return renderSelect(
    "harness-mode",
    "Harness Mode",
    "harnessMode",
    options,
    view.harnessAvailability.selected?.available === false
      ? view.harnessAvailability.selected.reason
      : availableModes.length === 0
        ? (unavailableSetupReason ??
          "No Copilot harness modes are available in this VS Code environment.")
        : undefined,
  );
}

function renderModelField(
  model: string,
  state: ScheduleDetailRenderState,
): string {
  const modelOptions = state.modelOptions ?? [];
  if (modelOptions.length === 0) {
    return renderInput(
      "model",
      "Model",
      "model",
      model,
      "text",
      "",
      state.modelCatalogAvailable
        ? "The selected harness reported no model choices; enter a model id manually."
        : undefined,
    );
  }

  const modelAvailable = isScheduleModelAvailable(model, modelOptions);
  const options: Array<[string, string, boolean]> = modelAvailable
    ? []
    : [[model, `${model} (unavailable or legacy)`, true]];
  options.push(
    ...modelOptions.map(
      (option): [string, string, boolean] => [
        option.id,
        modelOptionLabel(option),
        option.id === model,
      ],
    ),
  );

  return renderSelect(
    "model",
    "Model",
    "model",
    options,
    modelAvailable
      ? undefined
      : "Saved model is unavailable or legacy for the selected harness.",
  );
}

function renderScheduleDetailScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">
(() => {
  const vscode = acquireVsCodeApi();
  const form = document.querySelector("#schedule-detail-form");
  if (!form) {
    return;
  }

  const valueFor = (name) => {
    const field = form.elements.namedItem(name);
    return field && "value" in field ? field.value : "";
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = {
      runInstructions: valueFor("runInstructions"),
      cadenceExpression: valueFor("cadenceExpression"),
      targetContextUri: valueFor("targetContextUri"),
      targetContextLabel: valueFor("targetContextLabel"),
      harnessMode: valueFor("harnessMode"),
      model: valueFor("model"),
      approvalMode: valueFor("approvalMode"),
      runCapMaxRuns: valueFor("runCapMaxRuns"),
    };
    vscode.postMessage({
      type: "save",
      scheduleId: form.dataset.scheduleId,
      fields,
    });
  });

  const actionButtons = document.querySelectorAll(
    'button[data-action]:not([data-action="save"])',
  );
  const inFlightActions = new Set();
  actionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (!action || button.hasAttribute("disabled") || inFlightActions.has(action)) {
        return;
      }

      if (action === "run-now") {
        inFlightActions.add(action);
        button.disabled = true;
        button.dataset.state = "busy";
        button.setAttribute("aria-busy", "true");
        button.setAttribute("aria-live", "polite");
        button.textContent = "Starting...";
      }

      const message = {
        type: action,
        scheduleId: form.dataset.scheduleId,
      };
      if (action === "run-now") {
        message.fields = {
          runInstructions: valueFor("runInstructions"),
          cadenceExpression: valueFor("cadenceExpression"),
          targetContextUri: valueFor("targetContextUri"),
          targetContextLabel: valueFor("targetContextLabel"),
          harnessMode: valueFor("harnessMode"),
          model: valueFor("model"),
          approvalMode: valueFor("approvalMode"),
          runCapMaxRuns: valueFor("runCapMaxRuns"),
        };
      }

      vscode.postMessage(message);
    });
  });
})();
</script>`;
}

function renderAction(action: ScheduleDetailAction): string {
  const disabled = action.enabled ? "" : " disabled";
  const reason = action.disabledReason ? ` title="${escapeHtml(action.disabledReason)}"` : "";
  const state = action.enabled ? "enabled" : "disabled";

  return `<button type="button" data-action="${escapeHtml(
    action.kind,
  )}" data-state="${state}"${disabled}${reason}>${escapeHtml(
    action.label,
  )}</button>`;
}

function renderPreviousRuns(previousRuns: ScheduleDetailPreviousRun[]): string {
  if (previousRuns.length === 0) {
    return '<p class="muted">No previous runs.</p>';
  }

  return `<table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Trigger</th>
          <th>Started</th>
          <th>Completed</th>
          <th>Executed Model</th>
          <th>Details</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        ${previousRuns.map(renderPreviousRun).join("\n")}
      </tbody>
    </table>`;
}

function renderPreviousRun(run: ScheduleDetailPreviousRun): string {
  return `<tr data-run-id="${escapeHtml(run.id)}">
          <td>${escapeHtml(run.status)}</td>
          <td>${escapeHtml(run.trigger)}</td>
          <td>${escapeHtml(run.startedAt)}</td>
          <td>${escapeHtml(run.completedAt ?? "Active")}</td>
          <td>${escapeHtml(run.executedModel ?? "Unknown")}</td>
          <td>${escapeHtml(previousRunDetail(run))}</td>
          <td>${escapeHtml(run.outcome.description)}</td>
        </tr>`;
}

function previousRunDetail(run: ScheduleDetailPreviousRun): string {
  return run.error ?? run.summary ?? "";
}

function scheduleDetailTitle(view: ScheduleDetailView): string {
  const label = view.overview.targetContext?.label;
  if (label && label.trim().length > 0) {
    return `${label} Schedule`;
  }

  return view.overview.status === "draft" ? "Draft Schedule" : "Schedule Detail";
}

function targetContextLabel(targetContext: TargetContext | null): string {
  if (!targetContext) {
    return "No workspace selected";
  }

  return targetContext.label
    ? `${targetContext.label} (${targetContext.uri})`
    : targetContext.uri;
}

function targetContextInputValue(targetContext: TargetContext | null): string {
  return targetContext?.uri ?? "";
}

function targetContextLabelInputValue(targetContext: TargetContext | null): string {
  return targetContext?.label ?? "";
}

function nextRunDisplayLabel(view: ScheduleDetailView): string {
  if (
    view.overview.status === "active" &&
    view.overview.cadence &&
    view.localScheduling.automaticRuns === "inactive"
  ) {
    return "Automatic runs inactive until Local Scheduling is enabled";
  }

  return view.overview.nextRunAt ?? "Not scheduled";
}

function cadenceLabel(cadence: RunCadence | null): string {
  return cadenceSummaryLabel(cadence);
}

function cadenceSummaryLabel(cadence: RunCadence | null): string {
  if (!cadence) {
    return "No cadence selected";
  }

  if (cadence.type === "cron" && cadence.expression === "0 * * * *") {
    return "Every hour";
  }

  if (cadence.type === "cron") {
    const everyMinutes = /^\*\/([1-9]\d?) \* \* \* \*$/.exec(
      cadence.expression,
    );
    if (everyMinutes?.[1]) {
      return `Every ${everyMinutes[1]} minutes`;
    }

    if (cadence.expression === "0 9 * * *") {
      return "Every day at 09:00";
    }

    if (cadence.expression === "0 9 * * 1") {
      return "Every week on Monday at 09:00";
    }

    return `custom cron: ${cadence.expression}`;
  }

  return "No cadence selected";
}

function harnessModeOverviewLabel(view: ScheduleDetailView): string {
  const selected = view.harnessAvailability.selected;
  if (!selected) {
    return "Not selected";
  }

  return selected.available ? selected.label : `${selected.label} (unavailable)`;
}

function harnessModeLabel(
  availability: ScheduleDetailView["harnessAvailability"]["selected"],
): string {
  return availability?.label ?? "Selected harness mode";
}

function modelOverviewLabel(
  model: string,
  modelOptions: readonly ScheduleModelOption[] | undefined,
): string {
  if (!modelOptions || modelOptions.length === 0) {
    return model;
  }

  const option = modelOptions.find((candidate) => candidate.id === model);
  return option ? modelOptionLabel(option) : `${model} (unavailable or legacy)`;
}

function modelOptionLabel(option: ScheduleModelOption): string {
  const metadata = [option.vendor, option.family, option.version]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
  const tokens =
    typeof option.maxInputTokens === "number"
      ? `${option.maxInputTokens} input tokens`
      : "";
  const detail = [metadata, tokens].filter((value) => value.length > 0).join(", ");

  if (detail.length > 0) {
    return `${option.displayName} (${detail})`;
  }

  return option.displayName === option.id
    ? option.id
    : `${option.displayName} (${option.id})`;
}

function cadenceInputValue(cadence: RunCadence | null): string {
  return cadence?.expression ?? "";
}

function runCapInputValue(runCounter: ScheduleDetailView["runCounter"]): string {
  return runCounter.limit === null ? "" : String(runCounter.limit);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function quickPickItemForSchedule(
  schedule: ScheduleSummary,
): ScheduleQuickPickItem {
  return {
    label: schedule.runInstructions.trim() || "Untitled Schedule",
    description: `${schedule.status} / ${schedule.model}`,
    detail: schedule.targetContext?.uri ?? schedule.id,
    scheduleId: schedule.id,
  };
}

function scheduleIdFromDeleteTarget(target: unknown): string | undefined {
  if (typeof target === "string" && target.trim().length > 0) {
    return target;
  }
  if (isRecord(target) && target.kind === "schedule") {
    const schedule = target.schedule;
    if (isRecord(schedule) && typeof schedule.id === "string") {
      return schedule.id;
    }
  }

  return undefined;
}

export function scheduleTreeItemForSummary(
  schedule: ScheduleSummary,
): VsCodeTreeItemLike {
  return {
    label: conciseInstructionLabel(schedule.runInstructions),
    description: `${schedule.status} / ${scheduleTreeNextRunText(schedule)}`,
    tooltip: scheduleTreeTooltip(schedule),
    command: {
      command: OPEN_SCHEDULE_COMMAND,
      title: "Open Schedule",
      arguments: [schedule.id],
    },
    contextValue: "agentScheduler.schedule",
  };
}

function emptyScheduleTreeItem(): VsCodeTreeItemLike {
  return {
    label: "No schedules yet",
    description: "Create a Draft Schedule",
    tooltip: "Run AgentScheduler: New Schedule to create a Draft Schedule.",
    command: {
      command: NEW_SCHEDULE_COMMAND,
      title: "New Schedule",
    },
    contextValue: "agentScheduler.emptyScheduleList",
  };
}

function conciseInstructionLabel(runInstructions: string): string {
  const firstLine = runInstructions.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "Untitled Schedule";
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function scheduleTreeTooltip(schedule: ScheduleSummary): string {
  return [
    conciseInstructionLabel(schedule.runInstructions),
    `Status: ${schedule.status}`,
    `Next run: ${scheduleTreeNextRunValue(schedule)}`,
  ].join("\n");
}

function scheduleTreeNextRunText(schedule: ScheduleSummary): string {
  return scheduleTreeAutomaticRunsInactive(schedule)
    ? "automatic runs inactive until Local Scheduling is enabled"
    : `next: ${schedule.nextRunAt ?? "not scheduled"}`;
}

function scheduleTreeNextRunValue(schedule: ScheduleSummary): string {
  return scheduleTreeAutomaticRunsInactive(schedule)
    ? "Automatic runs inactive until Local Scheduling is enabled"
    : schedule.nextRunAt ?? "not scheduled";
}

function scheduleTreeAutomaticRunsInactive(schedule: ScheduleSummary): boolean {
  return (
    schedule.status === "active" &&
    schedule.cadence !== null &&
    schedule.automaticRuns === "inactive"
  );
}

const CREATE_ACTIVE_SCHEDULE_ACTION = "Create Active Schedule";
const DELETE_SCHEDULE_ACTION = "Delete Schedule";

async function confirmNaturalLanguageScheduleActivation(
  window: VsCodeWindowLike,
  proposal: NaturalLanguageScheduleActivationProposal,
): Promise<boolean> {
  const selected = await window.showInformationMessage?.(
    "Create active AgentScheduler schedule?",
    {
      modal: true,
      detail: naturalLanguageActivationConfirmationDetail(proposal),
    },
    CREATE_ACTIVE_SCHEDULE_ACTION,
  );
  return selected === CREATE_ACTIVE_SCHEDULE_ACTION;
}

function naturalLanguageActivationConfirmationDetail(
  proposal: NaturalLanguageScheduleActivationProposal,
): string {
  const runCap =
    proposal.runCap && proposal.runCap.maxRuns > 0
      ? String(proposal.runCap.maxRuns)
      : "No limit";
  return [
    `Instructions: ${proposal.runInstructions}`,
    `Cadence: ${cadenceLabel(proposal.cadence)}`,
    `Target: ${targetContextLabel(proposal.targetContext)}`,
    `Harness: ${proposal.harnessMode}`,
    `Model: ${proposal.model}`,
    `Approvals: ${proposal.approvalMode}`,
    `Run cap: ${runCap}`,
  ].join("\n");
}

function naturalLanguageCreationSummary(
  result: NaturalLanguageScheduleCreationResult,
): string {
  const headline =
    result.outcome === "activated"
      ? "Created active schedule."
      : "Created draft schedule.";
  const notes =
    result.validationMessages.length > 0
      ? `\n\nReview notes:\n${result.validationMessages
          .map((message) => `- ${message}`)
          .join("\n")}`
      : "";
  return `${headline} Opened Schedule Detail for review.${notes}`;
}

function naturalLanguageScheduleCreationInputFrom(
  rawInput: unknown,
): NaturalLanguageScheduleCreationInput {
  if (typeof rawInput === "string") {
    const naturalLanguageRequest = rawInput.trim();
    if (naturalLanguageRequest.length === 0) {
      throw new Error("Natural-language schedule request is required.");
    }
    return { naturalLanguageRequest };
  }

  if (!isRecord(rawInput)) {
    throw new Error("Natural-language schedule creation input must be an object.");
  }

  const naturalLanguageRequest = stringProperty(
    rawInput,
    "naturalLanguageRequest",
  )?.trim();
  if (!naturalLanguageRequest) {
    throw new Error("Natural-language schedule request is required.");
  }

  const input: NaturalLanguageScheduleCreationInput = {
    naturalLanguageRequest,
  };
  const runInstructions = stringProperty(rawInput, "runInstructions")?.trim();
  if (runInstructions) {
    input.runInstructions = runInstructions;
  }
  const cadence = cadenceProperty(rawInput, "cadence");
  if (cadence) {
    input.cadence = cadence;
  }
  const targetContext = targetContextProperty(rawInput, "targetContext");
  if (targetContext) {
    input.targetContext = targetContext;
  }
  const harnessMode = harnessModeProperty(rawInput, "harnessMode");
  if (harnessMode) {
    input.harnessMode = harnessMode;
  }
  const model = stringProperty(rawInput, "model")?.trim();
  if (model) {
    input.model = model;
  }
  const approvalMode = approvalModeProperty(rawInput, "approvalMode");
  if (approvalMode) {
    input.approvalMode = approvalMode;
  }
  const runCap = runCapProperty(rawInput, "runCap");
  if (runCap) {
    input.runCap = runCap;
  }
  const riskWarnings = stringArrayProperty(rawInput, "riskWarnings");
  if (riskWarnings.length > 0) {
    input.riskWarnings = riskWarnings;
  }

  return input;
}

function stringProperty(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function cadenceProperty(
  record: Record<string, unknown>,
  key: string,
): RunCadence | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const type = value["type"];
  const expression = value["expression"];
  return type === "cron" && typeof expression === "string"
    ? { type: "cron", expression }
    : undefined;
}

function targetContextProperty(
  record: Record<string, unknown>,
  key: string,
): WorkspaceTargetContext | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const type = value["type"];
  const uri = value["uri"];
  const label = value["label"];
  if (type !== "workspace" || typeof uri !== "string") {
    return undefined;
  }

  return {
    type: "workspace",
    uri,
    ...(typeof label === "string" && label.trim().length > 0
      ? { label }
      : {}),
  };
}

function harnessModeProperty(
  record: Record<string, unknown>,
  key: string,
): HarnessMode | undefined {
  const value = record[key];
  return value === "local-copilot" || value === "cloud-copilot"
    ? value
    : undefined;
}

function approvalModeProperty(
  record: Record<string, unknown>,
  key: string,
): ApprovalMode | undefined {
  const value = record[key];
  return value === "default-approvals" ||
    value === "bypass-approvals" ||
    value === "autopilot"
    ? value
    : undefined;
}

function runCapProperty(
  record: Record<string, unknown>,
  key: string,
): RunCapInput | undefined {
  const value = record[key];
  if (!isRecord(value) || !Number.isInteger(value["maxRuns"])) {
    return undefined;
  }
  const maxRuns = value["maxRuns"];
  return typeof maxRuns === "number" && maxRuns > 0 ? { maxRuns } : undefined;
}

function stringArrayProperty(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function updateScheduleInputFromWebviewFields(
  fields: ScheduleDetailFormFields,
): UpdateScheduleInput {
  const cadenceExpression = stringField(fields, "cadenceExpression").trim();
  const targetContextUri = stringField(fields, "targetContextUri").trim();
  const targetContextLabel = stringField(fields, "targetContextLabel").trim();
  const harnessMode = stringField(fields, "harnessMode").trim();
  const approvalMode = stringField(fields, "approvalMode").trim();
  const runCapMaxRuns = stringField(fields, "runCapMaxRuns").trim();

  return {
    runInstructions: stringField(fields, "runInstructions"),
    cadence:
      cadenceExpression.length > 0
        ? { type: "cron", expression: cadenceExpression }
        : null,
    targetContext:
      targetContextUri.length > 0
        ? {
            type: "workspace",
            uri: targetContextUri,
            ...(targetContextLabel.length > 0 && { label: targetContextLabel }),
          }
        : null,
    harnessMode: parseHarnessMode(harnessMode),
    model: stringField(fields, "model").trim(),
    approvalMode: parseApprovalMode(approvalMode),
    runCap:
      runCapMaxRuns.length > 0
        ? { maxRuns: parsePositiveInteger(runCapMaxRuns, "Maximum Run Count") }
        : null,
  };
}

function parseScheduleDetailWebviewMessage(
  message: unknown,
): ScheduleDetailWebviewMessage | undefined {
  if (!isRecord(message) || typeof message.scheduleId !== "string") {
    return undefined;
  }

  if (isScheduleDetailActionKind(message.type)) {
    return {
      type: message.type,
      scheduleId: message.scheduleId,
      ...(isRecord(message.fields) ? { fields: message.fields } : {}),
    };
  }

  if (isLocalSchedulingWebviewAction(message.type)) {
    return { type: message.type, scheduleId: message.scheduleId };
  }

  if (message.type === "save" && isRecord(message.fields)) {
    return {
      type: "save",
      scheduleId: message.scheduleId,
      fields: message.fields,
    };
  }

  return undefined;
}

function isLocalSchedulingWebviewAction(
  value: unknown,
): value is LocalSchedulingWebviewAction {
  return (
    value === "enable-local-scheduling" ||
    value === "verify-local-scheduling" ||
    value === "disable-local-scheduling"
  );
}

function isScheduleDetailActionKind(
  value: unknown,
): value is ScheduleDetailActionKind {
  return (
    value === "activate" ||
    value === "run-now" ||
    value === "pause" ||
    value === "resume" ||
    value === "restart" ||
    value === "delete"
  );
}

function parseHarnessMode(value: string): HarnessMode | null {
  if (value.length === 0) {
    return null;
  }
  if (value === "local-copilot" || value === "cloud-copilot") {
    return value;
  }
  throw new Error(`Unsupported Harness Mode '${value}'.`);
}

function parseApprovalMode(value: string): ApprovalMode {
  if (
    value === "default-approvals" ||
    value === "bypass-approvals" ||
    value === "autopilot"
  ) {
    return value;
  }
  throw new Error(`Unsupported Approval Mode '${value}'.`);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function stringField(
  fields: ScheduleDetailFormFields,
  key: keyof ScheduleDetailFormFields,
): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed.";
}

export class ScheduleTreeDataProvider
  implements VsCodeTreeDataProviderLike<ScheduleTreeNode>
{
  readonly onDidChangeTreeData: VsCodeEventLike<ScheduleTreeNode | undefined>;

  private readonly changeEmitter: VsCodeEventEmitterLike<
    ScheduleTreeNode | undefined
  >;

  constructor(
    private readonly editor: VsCodeScheduleEditor,
    eventEmitterFactory: VsCodeEventEmitterFactory,
  ) {
    this.changeEmitter =
      eventEmitterFactory.createEventEmitter<ScheduleTreeNode | undefined>();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  async getChildren(element?: ScheduleTreeNode): Promise<ScheduleTreeNode[]> {
    if (element) {
      return [];
    }

    const schedules = await this.editor.listSchedules();
    return schedules.length > 0
      ? schedules.map((schedule) => ({ kind: "schedule", schedule }))
      : [{ kind: "empty" }];
  }

  getTreeItem(element: ScheduleTreeNode): VsCodeTreeItemLike {
    return element.kind === "schedule"
      ? scheduleTreeItemForSummary(element.schedule)
      : emptyScheduleTreeItem();
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

interface VsCodeScheduleCommandControllerOptions
  extends RegisterVsCodeScheduleCommandsOptions {
  scheduleTreeProvider: ScheduleTreeDataProvider | undefined;
  scheduleCreationFlow: VsCodeNaturalLanguageScheduleCreationFlow | undefined;
}

class VsCodeScheduleCommandController {
  private readonly context: VsCodeExtensionContextLike;
  private readonly window: VsCodeWindowLike;
  private readonly workspace: VsCodeWorkspaceLike;
  private readonly editor: VsCodeScheduleEditor;
  private readonly viewColumn: unknown;
  private readonly modelCatalog: ScheduleModelCatalog | undefined;
  private readonly scheduleTreeProvider: ScheduleTreeDataProvider | undefined;
  private readonly scheduleCreationFlow:
    | VsCodeNaturalLanguageScheduleCreationFlow
    | undefined;
  private readonly languageModelToolResultFactory:
    | VsCodeLanguageModelToolResultFactory
    | undefined;
  private readonly localSchedulingSetupAvailability:
    | VsCodeSchedulerServices["localSchedulingSetupAvailability"];
  private readonly scheduleDetailPanels = new Map<string, VsCodeWebviewPanelLike>();

  constructor(options: VsCodeScheduleCommandControllerOptions) {
    this.context = options.context;
    this.window = options.window;
    this.workspace = options.workspace;
    this.editor = options.services.editor;
    this.viewColumn = options.viewColumn;
    this.modelCatalog = options.modelCatalog;
    this.scheduleTreeProvider = options.scheduleTreeProvider;
    this.scheduleCreationFlow = options.scheduleCreationFlow;
    this.languageModelToolResultFactory = options.languageModelToolResultFactory;
    this.localSchedulingSetupAvailability =
      options.services.localSchedulingSetupAvailability;
    const modelRefreshSubscription = this.modelCatalog?.onDidChangeScheduleModels?.(
      () => {
        void this.refreshOpenScheduleDetailPanels();
      },
    );
    if (modelRefreshSubscription) {
      this.context.subscriptions.push(modelRefreshSubscription);
    }
  }

  async createNewSchedule(): Promise<ScheduleDetailView> {
    return this.runCommand(async () => {
      const defaultModel =
        preferredScheduleModel(await this.listScheduleModelOptions())?.id ??
        "auto";
      const defaultHarnessMode =
        (await this.editor.listHarnessModeAvailability()).find(
          (mode) => mode.available,
        )?.mode ?? null;
      const detail = await this.editor.createDraftSchedule(
        buildNewDraftScheduleInput(
          this.workspace,
          defaultModel,
          defaultHarnessMode,
        ),
      );
      await this.openScheduleDetailPanel(detail);
      this.refreshScheduleTree();
      return detail;
    });
  }

  async openSchedule(scheduleId: unknown): Promise<ScheduleDetailView | undefined> {
    return this.runCommand(async () => {
      const selectedScheduleId =
        typeof scheduleId === "string" && scheduleId.trim().length > 0
          ? scheduleId
          : await this.pickScheduleId();
      if (!selectedScheduleId) {
        return undefined;
      }

      const detail = await this.editor.openScheduleDetail(selectedScheduleId);
      await this.openScheduleDetailPanel(detail);
      return detail;
    });
  }

  async deleteSchedule(target: unknown): Promise<void> {
    return this.runCommand(async () => {
      const scheduleId = scheduleIdFromDeleteTarget(target);
      if (!scheduleId) {
        throw new Error("Schedule id is required to delete a schedule.");
      }

      await this.confirmAndDeleteSchedule(scheduleId);
    });
  }

  async invokeScheduleCreationTool(input: unknown): Promise<unknown> {
    const result = await this.createScheduleFromNaturalLanguage(
      input,
      "language-model-tool",
    );
    return this.languageModelToolResultFactory
      ? this.languageModelToolResultFactory.createToolResult([
          this.languageModelToolResultFactory.createTextPart(
            naturalLanguageCreationSummary(result),
          ),
        ])
      : result;
  }

  async handleScheduleCreationChatRequest(
    request: VsCodeChatRequestLike,
    stream: VsCodeChatResponseStreamLike,
  ): Promise<NaturalLanguageScheduleCreationResult> {
    const source =
      request.command === CREATE_SCHEDULE_CHAT_SLASH_COMMAND ||
      request.command === CREATE_SCHEDULE_COMMAND
        ? "slash-command"
        : "chat-participant";
    const result = await this.createScheduleFromNaturalLanguage(
      { naturalLanguageRequest: request.prompt },
      source,
    );
    stream.markdown?.(naturalLanguageCreationSummary(result));
    return result;
  }

  async executeScheduleCreationSlashCommand(
    input: unknown,
  ): Promise<NaturalLanguageScheduleCreationResult | undefined> {
    return this.runCommand(async () => {
      const resolvedInput = await this.resolveSlashCommandCreationInput(input);
      return resolvedInput
        ? this.createScheduleFromNaturalLanguage(resolvedInput, "slash-command")
        : undefined;
    });
  }

  private async openScheduleDetailPanel(detail: ScheduleDetailView): Promise<void> {
    const existingPanel = this.scheduleDetailPanels.get(detail.schedule.id);
    if (existingPanel) {
      existingPanel.reveal?.(this.viewColumn);
      await this.renderScheduleDetailPanel(existingPanel, detail);
      return;
    }

    const panel = this.window.createWebviewPanel(
      SCHEDULE_DETAIL_VIEW_TYPE,
      scheduleDetailTitle(detail),
      this.viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.scheduleDetailPanels.set(detail.schedule.id, panel);
    await this.renderScheduleDetailPanel(panel, detail);
    const disposeSubscription = panel.onDidDispose?.(() => {
      this.scheduleDetailPanels.delete(detail.schedule.id);
    });
    if (disposeSubscription) {
      this.context.subscriptions.push(disposeSubscription);
    }
    const messageSubscription = panel.webview.onDidReceiveMessage?.((message) =>
      this.handleScheduleDetailWebviewMessage(panel, message),
    );
    if (messageSubscription) {
      this.context.subscriptions.push(messageSubscription);
    }
  }

  private async pickScheduleId(): Promise<string | undefined> {
    const schedules = await this.editor.listSchedules();
    if (schedules.length === 0) {
      await this.window.showInformationMessage?.(
        "AgentScheduler has no schedules to open.",
      );
      return undefined;
    }
    if (!this.window.showQuickPick) {
      throw new Error("Schedule selection UI is not configured.");
    }

    const picked = await this.window.showQuickPick(
      schedules.map(quickPickItemForSchedule),
      { placeHolder: "Open AgentScheduler schedule" },
    );
    return picked?.scheduleId;
  }

  private async renderScheduleDetailPanel(
    panel: VsCodeWebviewPanelLike,
    detail: ScheduleDetailView,
    state: ScheduleDetailRenderState = {},
  ): Promise<void> {
    panel.title = scheduleDetailTitle(detail);
    const modelOptions = await this.listScheduleModelOptions(
      detail.schedule.harnessMode,
    );
    panel.webview.html = renderScheduleDetailWebviewHtml(detail, {
      ...state,
      modelOptions,
      modelCatalogAvailable: this.modelCatalog !== undefined,
      ...(this.localSchedulingSetupAvailability && {
        localSchedulingSetupAvailability:
          this.localSchedulingSetupAvailability,
      }),
    });
  }

  private async handleScheduleDetailWebviewMessage(
    panel: VsCodeWebviewPanelLike,
    rawMessage: unknown,
  ): Promise<void> {
    const message = parseScheduleDetailWebviewMessage(rawMessage);
    if (!message) {
      return;
    }

    try {
      if (isLocalSchedulingWebviewAction(message.type)) {
        await this.runLocalSchedulingAction(message.type);
        await this.refreshOpenScheduleDetailPanels();
        this.refreshScheduleTree();
        return;
      }

      if (message.type === "delete") {
        await this.confirmAndDeleteSchedule(message.scheduleId);
        return;
      }

      const detail =
        message.type === "save"
          ? await this.editor.saveScheduleDetailEdits(
              message.scheduleId,
              updateScheduleInputFromWebviewFields(message.fields),
            )
          : await this.runScheduleDetailAction(
              message.scheduleId,
              message.type as ScheduleDetailActionKind,
              "fields" in message ? message.fields : undefined,
            );
      await this.renderScheduleDetailPanel(panel, detail);
      this.refreshScheduleTree();
    } catch (error) {
      await this.renderScheduleDetailError(
        panel,
        message.scheduleId,
        errorMessageFor(error),
      );
    }
  }

  private async runLocalSchedulingAction(
    action: LocalSchedulingWebviewAction,
  ): Promise<void> {
    switch (action) {
      case "enable-local-scheduling":
        if (!this.editor.enableLocalScheduling) {
          throw new Error("Local scheduling setup is not configured.");
        }
        const enableResult = await this.editor.enableLocalScheduling();
        if (enableResult.applied === false) {
          throw new Error("The Local Scheduling trigger was not installed.");
        }
        await this.window.showInformationMessage?.(
          "AgentScheduler Local Scheduling is enabled.",
        );
        return;
      case "verify-local-scheduling":
        if (!this.editor.verifyLocalScheduling) {
          throw new Error("Local scheduling verification is not configured.");
        }
        const verifyResult = await this.editor.verifyLocalScheduling();
        if (verifyResult.applied === false) {
          throw new Error("The Local Scheduling trigger could not be verified.");
        }
        await this.window.showInformationMessage?.(
          "AgentScheduler Local Scheduling trigger was verified.",
        );
        return;
      case "disable-local-scheduling":
        if (!this.editor.disableLocalScheduling) {
          throw new Error("Local scheduling removal is not configured.");
        }
        const disableResult = await this.editor.disableLocalScheduling();
        if (disableResult.applied === false) {
          throw new Error("The Local Scheduling trigger was not removed.");
        }
        await this.window.showInformationMessage?.(
          "AgentScheduler Local Scheduling is disabled.",
        );
        return;
    }
  }

  private async runScheduleDetailAction(
    scheduleId: string,
    action: ScheduleDetailActionKind,
    fields?: ScheduleDetailFormFields,
  ): Promise<ScheduleDetailView> {
    switch (action) {
      case "activate":
        await this.requireSelectedModelAvailable(scheduleId);
        return this.editor.activateSchedule(scheduleId);
      case "run-now":
        if (fields) {
          await this.editor.saveScheduleDetailEdits(
            scheduleId,
            updateScheduleInputFromWebviewFields(fields),
          );
        }
        await this.requireSelectedModelAvailable(scheduleId);
        await this.editor.runScheduleNow(scheduleId);
        return this.editor.openScheduleDetail(scheduleId);
      case "pause":
        return this.editor.pauseSchedule(scheduleId);
      case "resume":
        return this.editor.resumeSchedule(scheduleId);
      case "restart":
        return this.editor.restartCompletedSchedule(scheduleId);
      case "delete":
        throw new Error("Delete is handled through the confirmation flow.");
    }
  }

  private refreshScheduleTree(): void {
    this.scheduleTreeProvider?.refresh();
  }

  private async createScheduleFromNaturalLanguage(
    rawInput: unknown,
    source: "language-model-tool" | "chat-participant" | "slash-command",
  ): Promise<NaturalLanguageScheduleCreationResult> {
    if (!this.scheduleCreationFlow) {
      throw new Error("Natural-language schedule creation is not configured.");
    }

    const input = naturalLanguageScheduleCreationInputFrom(rawInput);
    const result =
      source === "language-model-tool"
        ? await this.scheduleCreationFlow.invokeLanguageModelTool(input)
        : source === "chat-participant"
          ? await this.scheduleCreationFlow.handleChatParticipantRequest(input)
          : await this.scheduleCreationFlow.executeSlashCommand(input);
    const detail = await this.editor.openScheduleDetail(result.schedule.id);
    await this.openScheduleDetailPanel(detail);
    this.refreshScheduleTree();
    return result;
  }

  private async resolveSlashCommandCreationInput(
    input: unknown,
  ): Promise<unknown | undefined> {
    if (input !== undefined) {
      return input;
    }
    if (!this.window.showInputBox) {
      throw new Error("Natural-language schedule creation input is required.");
    }

    const naturalLanguageRequest = await this.window.showInputBox({
      prompt: "Describe the AgentScheduler schedule to create.",
      placeHolder: "Run every hour to review open bug branches",
    });
    return naturalLanguageRequest && naturalLanguageRequest.trim().length > 0
      ? naturalLanguageRequest
      : undefined;
  }

  private async renderScheduleDetailError(
    panel: VsCodeWebviewPanelLike,
    scheduleId: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      const detail = await this.editor.openScheduleDetail(scheduleId);
      await this.renderScheduleDetailPanel(panel, detail, { errorMessage });
    } catch {
      await this.window.showErrorMessage?.(`AgentScheduler: ${errorMessage}`);
    }
  }

  private async confirmAndDeleteSchedule(scheduleId: string): Promise<void> {
    const confirmed = await this.confirmScheduleDeletion(scheduleId);
    if (!confirmed) {
      return;
    }

    await this.editor.deleteSchedule(scheduleId);
    this.scheduleDetailPanels.get(scheduleId)?.dispose?.();
    this.scheduleDetailPanels.delete(scheduleId);
    this.refreshScheduleTree();
  }

  private async confirmScheduleDeletion(scheduleId: string): Promise<boolean> {
    const detail = await this.editor.openScheduleDetail(scheduleId);
    const selected = await this.window.showWarningMessage?.(
      "Delete AgentScheduler schedule?",
      {
        modal: true,
        detail: [
          "This permanently removes the schedule and its local run history.",
          "Future automatic runs for this schedule will stop. The shared Local Scheduling wakeup trigger is not removed.",
          `Schedule: ${scheduleDetailTitle(detail)} (${scheduleId})`,
        ].join("\n"),
      },
      DELETE_SCHEDULE_ACTION,
    );
    return selected === DELETE_SCHEDULE_ACTION;
  }

  private async listScheduleModelOptions(
    mode: HarnessMode | null = "local-copilot",
  ): Promise<readonly ScheduleModelOption[]> {
    if (mode && this.editor.listHarnessModels) {
      const harnessModels = await this.editor.listHarnessModels(mode);
      if (harnessModels.length > 0) {
        return harnessModels;
      }
    }
    return this.modelCatalog ? this.modelCatalog.listScheduleModels() : [];
  }

  private async requireSelectedModelAvailable(scheduleId: string): Promise<void> {
    const detail = await this.editor.openScheduleDetail(scheduleId);
    const modelOptions = await this.listScheduleModelOptions(
      detail.schedule.harnessMode,
    );
    if (modelOptions.length === 0) {
      return;
    }

    if (!isScheduleModelAvailable(detail.schedule.model, modelOptions)) {
      throw new Error(unavailableScheduleModelMessage(detail.schedule.model));
    }
  }

  private async refreshOpenScheduleDetailPanels(): Promise<void> {
    await Promise.all(
      [...this.scheduleDetailPanels.entries()].map(async ([scheduleId, panel]) => {
        try {
          const detail = await this.editor.openScheduleDetail(scheduleId);
          await this.renderScheduleDetailPanel(panel, detail);
        } catch {
          this.scheduleDetailPanels.delete(scheduleId);
        }
      }),
    );
  }

  private async runCommand<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      await this.window.showErrorMessage?.(
        `AgentScheduler: ${errorMessageFor(error)}`,
      );
      throw error;
    }
  }
}
