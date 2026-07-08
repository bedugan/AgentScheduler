import { join } from "node:path";

import type {
  CreateDraftScheduleInput,
  RunCadence,
  ScheduleDetailAction,
  ScheduleDetailPreviousRun,
  ScheduleDetailView,
  ScheduleSummary,
  TargetContext,
  WorkspaceTargetContext,
} from "./domain.js";
import { EditorControlSurface } from "./editorControlSurface.js";
import { ScheduleLifecycle } from "./scheduleLifecycle.js";
import { SqliteScheduleStore } from "./sqliteScheduleStore.js";

export const NEW_SCHEDULE_COMMAND = "agentScheduler.newSchedule";
export const OPEN_SCHEDULE_COMMAND = "agentScheduler.openSchedule";
export const SCHEDULE_DETAIL_VIEW_TYPE = "agentScheduler.scheduleDetail";
export const SQLITE_LOCAL_STORE_FILENAME = "agent-scheduler.sqlite";

const DEFAULT_HOURLY_CADENCE = {
  type: "cron",
  expression: "0 * * * *",
} as const satisfies RunCadence;

export interface VsCodeDisposableLike {
  dispose(): unknown;
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
  webview: {
    html: string;
  };
  reveal?(): unknown;
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
  showInformationMessage?(message: string): Promise<unknown>;
  showErrorMessage?(message: string): Promise<unknown>;
}

export interface VsCodeScheduleEditor {
  createDraftSchedule(
    input: CreateDraftScheduleInput,
  ): Promise<ScheduleDetailView>;
  openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView>;
  listSchedules(): Promise<ScheduleSummary[]>;
}

export interface VsCodeSchedulerServices {
  editor: VsCodeScheduleEditor;
  close?(): void;
}

export interface RegisterVsCodeScheduleCommandsOptions {
  context: VsCodeExtensionContextLike;
  commands: VsCodeCommandsLike;
  window: VsCodeWindowLike;
  workspace: VsCodeWorkspaceLike;
  services: VsCodeSchedulerServices;
  viewColumn: unknown;
}

interface ScheduleQuickPickItem extends VsCodeQuickPickItemLike {
  scheduleId: string;
}

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
    harnesses: [],
    localSchedulingSetup: {
      isLocalSchedulingEnabled: async () =>
        (await store.getLocalSchedulingSetup()).enabled,
      getLocalSchedulingSetupState: async () =>
        store.getLocalSchedulingSetup(),
    },
  });

  return {
    editor: new EditorControlSurface(lifecycle),
    close: () => store.close(),
  };
}

export function buildNewDraftScheduleInput(
  workspace: VsCodeWorkspaceLike,
): CreateDraftScheduleInput {
  return {
    runInstructions: "",
    cadence: DEFAULT_HOURLY_CADENCE,
    targetContext: currentWorkspaceTargetContext(workspace),
    harnessMode: "local-copilot",
    model: "gpt-5",
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

export function registerVsCodeScheduleCommands(
  options: RegisterVsCodeScheduleCommandsOptions,
): VsCodeDisposableLike[] {
  const controller = new VsCodeScheduleCommandController(options);
  const disposables = [
    options.commands.registerCommand(NEW_SCHEDULE_COMMAND, () =>
      controller.createNewSchedule(),
    ),
    options.commands.registerCommand(OPEN_SCHEDULE_COMMAND, (scheduleId) =>
      controller.openSchedule(scheduleId),
    ),
  ];

  options.context.subscriptions.push(...disposables);
  return disposables;
}

export function renderScheduleDetailWebviewHtml(
  view: ScheduleDetailView,
): string {
  const overviewRows: Array<[string, string]> = [
    ["Status", view.overview.status],
    ["Enabled", view.overview.enabled ? "Yes" : "No"],
    ["Target Context", targetContextLabel(view.overview.targetContext)],
    ["Cadence", cadenceLabel(view.overview.cadence)],
    ["Harness Mode", view.overview.harnessMode ?? "Not selected"],
    ["Model", view.overview.model],
    ["Approval Mode", view.overview.approvalMode],
    ["Run Counter", view.overview.runCounter.label],
    ["Next Run", view.overview.nextRunAt ?? "Not scheduled"],
    ["Last Run", view.overview.lastRunAt ?? "Never"],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
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

    textarea, input {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }

    textarea {
      min-height: 96px;
      resize: vertical;
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

  <section aria-labelledby="fields-heading">
    <h2 id="fields-heading">Editable Fields</h2>
    <div class="grid">
      <div class="field">
        <label for="run-instructions">Run Instructions</label>
        <textarea id="run-instructions" name="runInstructions">${escapeHtml(
          view.runInstructions.value,
        )}</textarea>
      </div>
      ${renderInput("cadence", "Cadence", cadenceInputValue(view.overview.cadence))}
      ${renderInput(
        "target-context",
        "Target Context",
        targetContextInputValue(view.overview.targetContext),
      )}
      ${renderInput("harness-mode", "Harness Mode", view.overview.harnessMode ?? "")}
      ${renderInput("model", "Model", view.overview.model)}
      ${renderInput("approval-mode", "Approval Mode", view.overview.approvalMode)}
    </div>
  </section>

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
</body>
</html>`;
}

function renderInput(id: string, label: string, value: string): string {
  return `<div class="field">
        <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
        <input id="${escapeHtml(id)}" name="${escapeHtml(id)}" value="${escapeHtml(value)}">
      </div>`;
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
          <td>${escapeHtml(run.outcome.description)}</td>
        </tr>`;
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

function cadenceLabel(cadence: RunCadence | null): string {
  return cadence ? `cron: ${cadence.expression}` : "No cadence selected";
}

function cadenceInputValue(cadence: RunCadence | null): string {
  return cadence?.expression ?? "";
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

class VsCodeScheduleCommandController {
  private readonly context: VsCodeExtensionContextLike;
  private readonly window: VsCodeWindowLike;
  private readonly workspace: VsCodeWorkspaceLike;
  private readonly editor: VsCodeScheduleEditor;
  private readonly viewColumn: unknown;

  constructor(options: RegisterVsCodeScheduleCommandsOptions) {
    this.context = options.context;
    this.window = options.window;
    this.workspace = options.workspace;
    this.editor = options.services.editor;
    this.viewColumn = options.viewColumn;
  }

  async createNewSchedule(): Promise<ScheduleDetailView> {
    return this.runCommand(async () => {
      const detail = await this.editor.createDraftSchedule(
        buildNewDraftScheduleInput(this.workspace),
      );
      this.openScheduleDetailPanel(detail);
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
      this.openScheduleDetailPanel(detail);
      return detail;
    });
  }

  private openScheduleDetailPanel(detail: ScheduleDetailView): void {
    const panel = this.window.createWebviewPanel(
      SCHEDULE_DETAIL_VIEW_TYPE,
      scheduleDetailTitle(detail),
      this.viewColumn,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
      },
    );
    panel.webview.html = renderScheduleDetailWebviewHtml(detail);
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

  private async runCommand<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      await this.window.showErrorMessage?.(
        `AgentScheduler: ${
          error instanceof Error ? error.message : "Command failed."
        }`,
      );
      throw error;
    }
  }
}
