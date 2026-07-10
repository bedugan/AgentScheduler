import { randomBytes } from "node:crypto";

import type {
  RunCadence,
  RunHistoryDetailView,
  ScheduleDetailAction,
  ScheduleDetailPreviousRun,
  ScheduleDetailView,
  TargetContext,
} from "./domain.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import { isScheduleModelAvailable } from "./scheduleModelCatalog.js";

export interface ScheduleDetailRenderState {
  errorMessage?: string;
  refreshedAt?: string;
  modelOptions?: readonly ScheduleModelOption[];
  modelCatalogAvailable?: boolean;
  localSchedulingSetupAvailability?: {
    available: boolean;
    canManage?: boolean;
    reason?: string;
  };
}

export interface ScheduleDetailLiveState {
  title: string;
  overviewHtml: string;
  actionsHtml: string;
  localSchedulingHtml: string;
  previousRunsHtml: string;
}

export function renderScheduleDetailLiveState(
  view: ScheduleDetailView,
  _state: ScheduleDetailRenderState = {},
): ScheduleDetailLiveState {
  return {
    title: scheduleDetailTitle(view),
    overviewHtml: renderOverviewRows(view, _state),
    actionsHtml: Object.values(view.actions).map(renderAction).join("\n"),
    localSchedulingHtml: renderLocalSchedulingContent(view, _state),
    previousRunsHtml: renderPreviousRuns(view.previousRuns),
  };
}
export function renderScheduleDetailWebviewHtml(
  view: ScheduleDetailView,
  state: ScheduleDetailRenderState = {},
): string {
  const scriptNonce = randomBytes(16).toString("base64");
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
    <span class="muted" id="live-refreshed-at">Last refreshed ${escapeHtml(state.refreshedAt ?? "when opened")}</span>
    <button type="button" data-action="refresh">Refresh</button>
  </header>

  ${state.errorMessage ? renderInlineError(state.errorMessage) : ""}

  <section aria-labelledby="overview-heading">
    <h2 id="overview-heading">Overview</h2>
    <dl class="grid" id="live-overview">
      ${renderOverviewRows(view, state)}
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
        ${renderInput(
          "agent-profile",
          "Copilot Agent Profile",
          "agentProfile",
          view.overview.agentProfile ?? "",
          "text",
          "",
          "Optional Copilot CLI agent id, for example explore or a custom .agent.md profile.",
        )}
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
    <div class="actions" id="live-actions">
      ${Object.values(view.actions).map(renderAction).join("\n")}
    </div>
  </section>

  <section aria-labelledby="local-scheduling-heading">
    <h2 id="local-scheduling-heading">Local Scheduling</h2>
    <div id="live-local-scheduling">${renderLocalSchedulingContent(view, state)}</div>
  </section>

  <section aria-labelledby="previous-runs-heading">
    <h2 id="previous-runs-heading">Previous Runs</h2>
    <div id="live-previous-runs">${renderPreviousRuns(view.previousRuns)}</div>
  </section>
  ${renderScheduleDetailScript(scriptNonce)}
</body>
</html>`;
}

function renderOverviewRows(view: ScheduleDetailView, state: ScheduleDetailRenderState): string {
  const rows: Array<[string, string]> = [
    ["Status", view.overview.status], ["Enabled", view.overview.enabled ? "Yes" : "No"],
    ["Target Context", targetContextLabel(view.overview.targetContext)], ["Cadence", cadenceSummaryLabel(view.overview.cadence)],
    ["Harness Mode", harnessModeOverviewLabel(view)], ["Model", modelOverviewLabel(view.overview.model, state.modelOptions)],
    ["Copilot Agent", view.overview.agentProfile ?? "Default"], ["Approval Mode", view.overview.approvalMode],
    ["Approval Surface", approvalSurfaceLabel(view)], ["Run Counter", view.overview.runCounter.label],
    ["Next Run", nextRunDisplayLabel(view)], ["Last Run", view.overview.lastRunAt ?? "Never"],
    ["Harness Availability", view.harnessAvailability.message],
  ];
  return rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("\n");
}

function renderLocalSchedulingContent(view: ScheduleDetailView, state: ScheduleDetailRenderState): string {
  return `<p><strong>${view.localScheduling.enabled ? "Enabled" : "Disabled"}</strong></p>
    <p>${escapeHtml(view.localScheduling.message)}</p>
    ${state.localSchedulingSetupAvailability?.available === false && state.localSchedulingSetupAvailability.reason ? `<p class="field-note">${escapeHtml(state.localSchedulingSetupAvailability.reason)}</p>` : ""}
    <div class="actions">${renderLocalSchedulingActions(view.localScheduling.enabled, state.localSchedulingSetupAvailability)}</div>`;
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

  form.addEventListener("focusin", () => {
    vscode.postMessage({
      type: "form-interaction",
      scheduleId: form.dataset.scheduleId,
      active: true,
    });
  });
  form.addEventListener("focusout", (event) => {
    if (event.relatedTarget && form.contains(event.relatedTarget)) {
      return;
    }
    vscode.postMessage({
      type: "form-interaction",
      scheduleId: form.dataset.scheduleId,
      active: false,
    });
  });

  let dirtyReported = false;
  form.addEventListener("input", () => {
    if (!dirtyReported) {
      dirtyReported = true;
      vscode.postMessage({
        type: "form-dirty",
        scheduleId: form.dataset.scheduleId,
      });
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = {
      runInstructions: valueFor("runInstructions"),
      cadenceExpression: valueFor("cadenceExpression"),
      targetContextUri: valueFor("targetContextUri"),
      targetContextLabel: valueFor("targetContextLabel"),
      harnessMode: valueFor("harnessMode"),
      agentProfile: valueFor("agentProfile"),
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

  const inFlightActions = new Set();
  const bindActionButtons = () => document.querySelectorAll(
    'button[data-action]:not([data-action="save"])',
  ).forEach((button) => {
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
          agentProfile: valueFor("agentProfile"),
          model: valueFor("model"),
          approvalMode: valueFor("approvalMode"),
          runCapMaxRuns: valueFor("runCapMaxRuns"),
        };
      }

      vscode.postMessage(message);
    });
  });
  const bindRunHistoryButtons = () => document.querySelectorAll("button[data-run-history-id]").forEach((button) => {
    button.addEventListener("click", () => {
      vscode.postMessage({
        type: "open-run-history",
        runId: button.dataset.runHistoryId,
      });
    });
  });
  bindActionButtons();
  bindRunHistoryButtons();
  if (typeof window !== "undefined") window.addEventListener("message", (event) => {
    if (event.data?.type !== "schedule-live-state") return;
    const state = event.data.state;
    const replacements = [["live-overview", state.overviewHtml], ["live-actions", state.actionsHtml], ["live-local-scheduling", state.localSchedulingHtml], ["live-previous-runs", state.previousRunsHtml]];
    replacements.forEach(([id, html]) => { const node = document.getElementById(id); if (node && typeof html === "string") node.innerHTML = html; });
    if (typeof state.title === "string") document.title = state.title;
    const refreshed = document.getElementById("live-refreshed-at");
    if (refreshed && typeof event.data.refreshedAt === "string") refreshed.textContent = "Last refreshed " + event.data.refreshedAt;
    bindActionButtons();
    bindRunHistoryButtons();
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
          <td><button type="button" data-run-history-id="${escapeHtml(run.id)}">Open</button></td>
          <td>${escapeHtml(run.outcome.description)}</td>
        </tr>`;
}

export function renderRunHistoryDetailHtml(
  detail: RunHistoryDetailView,
): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';"></head><body>
    <h1>Run History Detail</h1>
    <p>Last refreshed ${escapeHtml(new Date().toISOString())}</p>
    <div id="live-run-history">${renderRunHistoryLiveHtml(detail)}</div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-run-action]");
        if (button) vscode.postMessage({ action: button.dataset.runAction });
      });
      window.addEventListener("message", (event) => {
        if (event.data?.type === "run-history-live-state") {
          const node = document.getElementById("live-run-history");
          if (node) node.innerHTML = event.data.html;
        }
      });
    </script>
  </body></html>`;
}

export function renderRunHistoryLiveHtml(detail: RunHistoryDetailView): string {
  const cancel = detail.actions.cancel;
  const open = detail.actions.open;
  const button = (action: "cancel" | "open" | "refresh", label: string, enabled: boolean, reason?: string) =>
    `<button type="button" data-run-action="${action}"${enabled ? "" : " disabled"}${reason ? ` title="${escapeHtml(reason)}"` : ""}>${escapeHtml(label)}</button>`;
  return `<dl>
      <dt>Status</dt><dd>${escapeHtml(detail.run.status)}</dd>
      <dt>Instructions</dt><dd>${escapeHtml(detail.resolvedRunInstructions)}</dd>
      <dt>Approval Mode</dt><dd>${escapeHtml(detail.approvalMode)}</dd>
      <dt>Selected Model</dt><dd>${escapeHtml(detail.selectedModel)}</dd>
      <dt>Copilot Agent</dt><dd>${escapeHtml(detail.selectedAgentProfile ?? "Default")}</dd>
      <dt>Executed Model</dt><dd>${escapeHtml(detail.executedModel ?? "Unknown")}</dd>
      <dt>Started</dt><dd>${escapeHtml(detail.run.startedAt)}</dd>
      <dt>Completed</dt><dd>${escapeHtml(detail.run.completedAt ?? "Active")}</dd>
      <dt>Execution Identity</dt><dd>${escapeHtml(detail.execution?.identity ?? "Unavailable")}</dd>
      <dt>Policy</dt><dd><pre>${escapeHtml(JSON.stringify(detail.resolvedHarnessPolicy, null, 2))}</pre></dd>
      <dt>Outcome</dt><dd>${escapeHtml(detail.outcome.description)}</dd>
    </dl>
    <div>${button("refresh", "Refresh", true)} ${button("open", open.label, open.enabled, open.disabledReason)} ${button("cancel", cancel.label, cancel.enabled, cancel.disabledReason)}</div>`;
}

export function scheduleDetailTitle(view: ScheduleDetailView): string {
  const label = view.overview.targetContext?.label;
  if (label && label.trim().length > 0) {
    return `${label} Schedule`;
  }

  return view.overview.status === "draft" ? "Draft Schedule" : "Schedule Detail";
}

export function targetContextLabel(targetContext: TargetContext | null): string {
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

export function cadenceLabel(cadence: RunCadence | null): string {
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

function approvalSurfaceLabel(view: ScheduleDetailView): string {
  if (
    view.overview.harnessMode === "local-copilot" &&
    view.overview.approvalMode === "default-approvals"
  ) {
    return "VS Code Task terminal (managed Copilot CLI fallback)";
  }
  return "No interactive approval surface required by the selected policy";
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
