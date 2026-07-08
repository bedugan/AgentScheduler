import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createDefaultCopilotLocalHarness } from "./copilotCliClient.js";
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
import { ScheduleLifecycle } from "./scheduleLifecycle.js";
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
}

export interface VsCodeSchedulerServices {
  editor: VsCodeScheduleEditor;
  lifecycle?: ScheduleLifecycle;
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
    };

export function sqliteLocalStorePath(
  context: VsCodeGlobalStorageContextLike,
): string {
  return join(context.globalStorageUri.fsPath, SQLITE_LOCAL_STORE_FILENAME);
}

export function createDefaultVsCodeSchedulerServices(
  context: VsCodeGlobalStorageContextLike,
): VsCodeSchedulerServices {
  const store = new SqliteScheduleStore({
    databasePath: sqliteLocalStorePath(context),
  });
  const lifecycle = new ScheduleLifecycle({
    store,
    harnesses: [createDefaultCopilotLocalHarness()],
    localSchedulingSetup: {
      isLocalSchedulingEnabled: async () =>
        (await store.getLocalSchedulingSetup()).enabled,
      getLocalSchedulingSetupState: async () =>
        store.getLocalSchedulingSetup(),
    },
  });

  return {
    editor: new EditorControlSurface(lifecycle),
    lifecycle,
    close: () => store.close(),
  };
}

export function buildNewDraftScheduleInput(
  workspace: VsCodeWorkspaceLike,
  defaultModel = "gpt-5",
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
    defaultModel: "gpt-5",
    ...(modelCatalog ? { modelCatalog } : {}),
    confirmActivation: (proposal) =>
      confirmNaturalLanguageScheduleActivation(options.window, proposal),
  });
}

export function registerVsCodeScheduleCommands(
  options: RegisterVsCodeScheduleCommandsOptions,
): VsCodeDisposableLike[] {
  const modelCatalog =
    options.modelCatalog ?? createVsCodeScheduleModelCatalog(options.languageModel);
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
  </section>

  <section aria-labelledby="previous-runs-heading">
    <h2 id="previous-runs-heading">Previous Runs</h2>
    ${renderPreviousRuns(view.previousRuns)}
  </section>
  ${renderScheduleDetailScript(scriptNonce)}
</body>
</html>`;
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
        ? "No VS Code chat models were reported; enter a model id manually."
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
      : "Saved model is unavailable or legacy in this VS Code environment.",
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
    vscode.postMessage({
      type: "save",
      scheduleId: form.dataset.scheduleId,
      fields: {
        runInstructions: valueFor("runInstructions"),
        cadenceExpression: valueFor("cadenceExpression"),
        targetContextUri: valueFor("targetContextUri"),
        targetContextLabel: valueFor("targetContextLabel"),
        harnessMode: valueFor("harnessMode"),
        model: valueFor("model"),
        approvalMode: valueFor("approvalMode"),
        runCapMaxRuns: valueFor("runCapMaxRuns"),
      },
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

      vscode.postMessage({
        type: action,
        scheduleId: form.dataset.scheduleId,
      });
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
    };
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
        "gpt-5";
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
    const modelOptions = await this.listScheduleModelOptions();
    panel.webview.html = renderScheduleDetailWebviewHtml(detail, {
      ...state,
      modelOptions,
      modelCatalogAvailable: this.modelCatalog !== undefined,
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
          : await this.runScheduleDetailAction(message.scheduleId, message.type);
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

  private async runScheduleDetailAction(
    scheduleId: string,
    action: ScheduleDetailActionKind,
  ): Promise<ScheduleDetailView> {
    switch (action) {
      case "activate":
        await this.requireSelectedModelAvailable(scheduleId);
        return this.editor.activateSchedule(scheduleId);
      case "run-now":
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

  private async listScheduleModelOptions(): Promise<readonly ScheduleModelOption[]> {
    return this.modelCatalog ? this.modelCatalog.listScheduleModels() : [];
  }

  private async requireSelectedModelAvailable(scheduleId: string): Promise<void> {
    const modelOptions = await this.listScheduleModelOptions();
    if (modelOptions.length === 0) {
      return;
    }

    const detail = await this.editor.openScheduleDetail(scheduleId);
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
