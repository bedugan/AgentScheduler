import type {
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  HarnessMode,
  RunHistoryDetailView,
  RunHistoryEntry,
  ScheduleDetailView,
  ScheduleHarnessModeAvailability,
  ScheduleSummary,
  UpdateScheduleInput,
} from "./domain.js";
import type {
  LocalSchedulingSetupResult,
  WakeupTriggerIntent,
} from "./localSchedulingSetup.js";
import type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";
import type { VsCodeGlobalStorageContextLike } from "./vscodeLocalScheduling.js";

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
  createActiveSchedule(
    input: CreateActiveScheduleInput,
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
