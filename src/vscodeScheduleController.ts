import type {
  ApprovalMode,
  CreateDraftScheduleInput,
  HarnessMode,
  RunCadence,
  RunHistoryEntry,
  RunCapInput,
  ScheduleDetailActionKind,
  ScheduleDetailView,
  ScheduleHarnessModeAvailability,
  ScheduleSummary,
  TargetContext,
  WorkspaceTargetContext,
} from "./domain.js";
import type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";
import {
  isScheduleModelAvailable,
  preferredScheduleModel,
  unavailableScheduleModelMessage,
} from "./scheduleModelCatalog.js";
import type {
  NaturalLanguageScheduleActivationProposal,
  NaturalLanguageScheduleCreationInput,
  NaturalLanguageScheduleCreationResult,
} from "./vscodeNaturalLanguageScheduleCreation.js";
import { VsCodeNaturalLanguageScheduleCreationFlow } from "./vscodeNaturalLanguageScheduleCreation.js";
import {
  isLocalSchedulingWebviewAction,
  parseScheduleDetailWebviewMessage,
  updateScheduleInputFromWebviewFields,
  type LocalSchedulingWebviewAction,
  type ScheduleDetailFormFields,
} from "./vscodeScheduleDetailMessages.js";
import {
  cadenceLabel,
  renderRunHistoryDetailHtml,
  renderRunHistoryLiveHtml,
  renderScheduleDetailWebviewHtml,
  renderScheduleDetailLiveState,
  scheduleDetailTitle,
  targetContextLabel,
  type ScheduleDetailRenderState,
} from "./vscodeScheduleRenderers.js";
import {
  VsCodeSchedulePanelHost,
  type SchedulePanelLike,
} from "./vscodeSchedulePanelHost.js";
import type {
  RegisterVsCodeScheduleCommandsOptions,
  VsCodeChatRequestLike,
  VsCodeChatResponseStreamLike,
  VsCodeDisposableLike,
  VsCodeEventEmitterFactory,
  VsCodeEventEmitterLike,
  VsCodeEventLike,
  VsCodeExtensionContextLike,
  VsCodeLanguageModelChatLike,
  VsCodeLanguageModelLike,
  VsCodeLanguageModelToolResultFactory,
  VsCodeScheduleEditor,
  VsCodeSchedulerServices,
  VsCodeTreeDataProviderLike,
  VsCodeTreeItemLike,
  VsCodeWindowLike,
  VsCodeWorkspaceLike,
} from "./vscodeContracts.js";

export const CREATE_SCHEDULE_COMMAND = "agentScheduler.createSchedule";
export const CREATE_SCHEDULE_TOOL_NAME = "agentScheduler_createSchedule";
export const CREATE_SCHEDULE_CHAT_PARTICIPANT_ID = "agentScheduler.schedule";
export const CREATE_SCHEDULE_CHAT_SLASH_COMMAND = "createSchedule";
export const NEW_SCHEDULE_COMMAND = "agentScheduler.newSchedule";
export const OPEN_SCHEDULE_COMMAND = "agentScheduler.openSchedule";
export const DELETE_SCHEDULE_COMMAND = "agentScheduler.deleteSchedule";
export const SCHEDULE_LIST_VIEW_ID = "agentScheduler.scheduleList";
export const SCHEDULE_DETAIL_VIEW_TYPE = "agentScheduler.scheduleDetail";
export const RUN_HISTORY_DETAIL_VIEW_TYPE = "agentScheduler.runHistoryDetail";

const DEFAULT_HOURLY_CADENCE = {
  type: "cron",
  expression: "0 * * * *",
} as const satisfies RunCadence;

interface ScheduleQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  scheduleId: string;
}

export type ScheduleTreeNode =
  | { kind: "schedule"; schedule: ScheduleSummary }
  | { kind: "empty" };

export class SqliteDataVersionMonitor {
  private observedVersion: number;
  private refreshInFlight: Promise<void> | undefined;
  private dirty = false;
  private disposed = false;

  constructor(
    private readonly readVersion: () => number,
    private readonly onChange: () => unknown | Promise<unknown>,
  ) {
    this.observedVersion = readVersion();
  }

  async poll(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const nextVersion = this.readVersion();
    if (nextVersion === this.observedVersion) {
      return false;
    }
    this.observedVersion = nextVersion;
    if (this.refreshInFlight) {
      this.dirty = true;
      return true;
    }
    this.refreshInFlight = this.refreshUntilClean();
    await this.refreshInFlight;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.dirty = false;
  }

  private async refreshUntilClean(): Promise<void> {
    try {
      do {
        this.dirty = false;
        if (this.disposed) {
          return;
        }
        await this.onChange();
      } while (this.dirty && !this.disposed);
    } finally {
      this.refreshInFlight = undefined;
    }
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
): VsCodeNaturalLanguageScheduleCreationFlow {
  const currentWorkspace = currentWorkspaceTargetContext(options.workspace);
  return new VsCodeNaturalLanguageScheduleCreationFlow({
    editor: options.services.editor,
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
  const dataVersionMonitor = options.services.dataVersion
    ? new SqliteDataVersionMonitor(options.services.dataVersion, () => {
        return controller.refreshExternalState();
      })
    : undefined;
  const dataVersionInterval = dataVersionMonitor
    ? setInterval(() => {
        try {
          void dataVersionMonitor.poll().catch(() => {});
        } catch {
          // The extension may be disposing the SQLite connection.
        }
      }, 1_000)
    : undefined;
  dataVersionInterval?.unref();
  const disposables = [
    ...(dataVersionInterval
      ? [{
          dispose: () => {
            clearInterval(dataVersionInterval);
            dataVersionMonitor?.dispose();
          },
        }]
      : []),
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
  disposables.push(
    options.commands.registerCommand(CREATE_SCHEDULE_COMMAND, (input) =>
      controller.executeScheduleCreationSlashCommand(input),
    ),
  );
  if (options.languageModel) {
    disposables.push(
      options.languageModel.registerTool(CREATE_SCHEDULE_TOOL_NAME, {
        invoke: (toolInvocation) =>
          controller.invokeScheduleCreationTool(toolInvocation.input),
      }),
    );
  }
  if (options.chat) {
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
  scheduleCreationFlow: VsCodeNaturalLanguageScheduleCreationFlow;
}

class VsCodeScheduleCommandController {
  private readonly context: VsCodeExtensionContextLike;
  private readonly window: VsCodeWindowLike;
  private readonly workspace: VsCodeWorkspaceLike;
  private readonly editor: VsCodeScheduleEditor;
  private readonly viewColumn: unknown;
  private readonly modelCatalog: ScheduleModelCatalog | undefined;
  private readonly scheduleTreeProvider: ScheduleTreeDataProvider | undefined;
  private readonly scheduleCreationFlow: VsCodeNaturalLanguageScheduleCreationFlow;
  private readonly languageModelToolResultFactory:
    | VsCodeLanguageModelToolResultFactory
    | undefined;
  private readonly localSchedulingSetupAvailability:
    | VsCodeSchedulerServices["localSchedulingSetupAvailability"];
  private readonly panelHost: VsCodeSchedulePanelHost;

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
    this.panelHost = new VsCodeSchedulePanelHost({
      subscriptions: this.context.subscriptions,
      createPanel: (...args) => this.window.createWebviewPanel(...args),
      viewColumn: this.viewColumn,
      scheduleViewType: SCHEDULE_DETAIL_VIEW_TYPE,
      runHistoryViewType: RUN_HISTORY_DETAIL_VIEW_TYPE,
      scheduleTitle: scheduleDetailTitle,
      renderSchedule: async (detail, state = {}) => {
        const modelOptions = await this.listScheduleModelOptions(
          detail.schedule.harnessMode,
        );
        return renderScheduleDetailWebviewHtml(detail, {
          ...state,
          refreshedAt: new Date().toISOString(),
          modelOptions,
          modelCatalogAvailable: this.modelCatalog !== undefined,
          ...(this.localSchedulingSetupAvailability && {
            localSchedulingSetupAvailability:
              this.localSchedulingSetupAvailability,
          }),
        });
      },
      renderScheduleLive: async (detail) => {
        const modelOptions = await this.listScheduleModelOptions(
          detail.schedule.harnessMode,
        );
        return renderScheduleDetailLiveState(detail, { modelOptions });
      },
      renderRunHistory: renderRunHistoryDetailHtml,
      renderRunHistoryLive: renderRunHistoryLiveHtml,
      loadSchedule: (id) => this.editor.openScheduleDetail(id),
      loadRunHistory: (id) => {
        if (!this.editor.openRunHistoryDetail) {
          throw new Error("Run History Detail is not configured.");
        }
        return this.editor.openRunHistoryDetail(id);
      },
      onScheduleMessage: (panel, message) =>
        this.handleScheduleDetailWebviewMessage(panel, message),
      onRunHistoryMessage: (panel, runId, message) =>
        this.handleRunHistoryMessage(panel, runId, message),
      showError: (message) => this.window.showErrorMessage?.(message),
    });
    const modelRefreshSubscription = this.modelCatalog?.onDidChangeScheduleModels?.(
      () => {
        void this.panelHost.refreshSchedules();
      },
    );
    if (modelRefreshSubscription) {
      this.context.subscriptions.push(modelRefreshSubscription);
    }
    const stateRefreshSubscription = options.services.onDidChangeState?.(() => {
      void this.refreshVisibleState();
    });
    if (stateRefreshSubscription) {
      this.context.subscriptions.push(stateRefreshSubscription);
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
      await this.panelHost.openSchedule(detail);
      this.refreshScheduleTree();
      return detail;
    });
  }

  async refreshExternalState(): Promise<void> {
    this.refreshScheduleTree();
    await this.panelHost.refreshVisible();
  }

  async refreshVisibleState(): Promise<void> {
    await this.panelHost.refreshVisible();
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
      await this.panelHost.openSchedule(detail);
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

  private async handleScheduleDetailWebviewMessage(
    panel: SchedulePanelLike,
    rawMessage: unknown,
  ): Promise<void> {
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      (rawMessage as { type?: unknown }).type === "form-interaction" &&
      typeof (rawMessage as { active?: unknown }).active === "boolean"
    ) {
      this.panelHost.setScheduleInteraction(
        panel,
        (rawMessage as { active: boolean }).active,
      );
      return;
    }
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      (rawMessage as { type?: unknown }).type === "form-dirty"
    ) {
      this.panelHost.markScheduleDirty(panel);
      return;
    }
    if (
      typeof rawMessage === "object" &&
      rawMessage !== null &&
      (rawMessage as { type?: unknown }).type === "open-run-history" &&
      typeof (rawMessage as { runId?: unknown }).runId === "string"
    ) {
      await this.panelHost.openRunHistory(
        (rawMessage as { runId: string }).runId,
      );
      return;
    }
    const message = parseScheduleDetailWebviewMessage(rawMessage);
    if (!message) {
      return;
    }

    try {
      if (message.type === "refresh") {
        await this.panelHost.refreshSchedulePanel(panel, message.scheduleId);
        return;
      }

      if (isLocalSchedulingWebviewAction(message.type)) {
        await this.runLocalSchedulingAction(message.type);
        await this.panelHost.refreshSchedules();
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
      await this.panelHost.renderSchedule(panel, detail);
      this.refreshScheduleTree();
    } catch (error) {
      await this.panelHost.renderError(
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

  private async handleRunHistoryMessage(
    panel: SchedulePanelLike,
    runId: string,
    message: unknown,
  ): Promise<void> {
    if (
      typeof message !== "object" ||
      message === null ||
      typeof (message as { action?: unknown }).action !== "string"
    ) {
      return;
    }
    const action = (message as { action: string }).action;
    if (action === "cancel" && this.editor.cancelRun) {
      await this.editor.cancelRun(runId);
    } else if (action === "open" && this.editor.openRun) {
      await this.editor.openRun(runId);
    }
    await this.panelHost.refreshRunHistoryPanel(panel, runId);
    this.refreshScheduleTree();
    await this.panelHost.refreshSchedules();
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
    const input = naturalLanguageScheduleCreationInputFrom(rawInput);
    const result =
      source === "language-model-tool"
        ? await this.scheduleCreationFlow.invokeLanguageModelTool(input)
        : source === "chat-participant"
          ? await this.scheduleCreationFlow.handleChatParticipantRequest(input)
          : await this.scheduleCreationFlow.executeSlashCommand(input);
    const detail = await this.editor.openScheduleDetail(result.schedule.id);
    await this.panelHost.openSchedule(detail);
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

  private async confirmAndDeleteSchedule(scheduleId: string): Promise<void> {
    const confirmed = await this.confirmScheduleDeletion(scheduleId);
    if (!confirmed) {
      return;
    }

    await this.editor.deleteSchedule(scheduleId);
    this.panelHost.disposeSchedule(scheduleId);
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
