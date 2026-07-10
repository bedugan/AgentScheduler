import type {
  ApprovalMode,
  HarnessMode,
  ScheduleDetailActionKind,
  UpdateScheduleInput,
} from "./domain.js";

export interface ScheduleDetailFormFields {
  runInstructions?: unknown;
  cadenceExpression?: unknown;
  targetContextUri?: unknown;
  targetContextLabel?: unknown;
  harnessMode?: unknown;
  model?: unknown;
  agentProfile?: unknown;
  approvalMode?: unknown;
  runCapMaxRuns?: unknown;
}

export type LocalSchedulingWebviewAction =
  | "enable-local-scheduling"
  | "verify-local-scheduling"
  | "disable-local-scheduling";

export type ScheduleDetailWebviewMessage =
  | { type: "save"; scheduleId: string; fields: ScheduleDetailFormFields }
  | { type: "refresh"; scheduleId: string }
  | { type: ScheduleDetailActionKind; scheduleId: string; fields?: ScheduleDetailFormFields }
  | { type: LocalSchedulingWebviewAction; scheduleId: string };

export function updateScheduleInputFromWebviewFields(
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
    agentProfile: stringField(fields, "agentProfile").trim(),
    approvalMode: parseApprovalMode(approvalMode),
    runCap:
      runCapMaxRuns.length > 0
        ? { maxRuns: parsePositiveInteger(runCapMaxRuns, "Maximum Run Count") }
        : null,
  };
}

export function parseScheduleDetailWebviewMessage(
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

  if (message.type === "refresh") {
    return { type: "refresh", scheduleId: message.scheduleId };
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

export function isLocalSchedulingWebviewAction(
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
