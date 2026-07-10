import type { LocalRunExecution } from "./localRunExecution.js";

export type IsoTimestamp = string;

export type ApprovalMode =
  | "default-approvals"
  | "bypass-approvals"
  | "autopilot";

export type HarnessMode = "local-copilot" | "cloud-copilot";

export const HARNESS_MODE_LABELS = {
  "local-copilot": "Local Copilot Mode",
  "cloud-copilot": "Cloud Copilot Mode",
} as const satisfies Record<HarnessMode, string>;

export const SUPPORTED_HARNESS_MODES = [
  "local-copilot",
  "cloud-copilot",
] as const satisfies readonly HarnessMode[];

export type ScheduleStatus = "draft" | "active" | "paused" | "completed";

export type RunTrigger = "draft-manual" | "manual" | "automatic";

export type RunStatus =
  | "running"
  | "approval-waiting"
  | "completed"
  | "failed"
  | "canceled"
  | "blocked"
  | "deferred";

export type ActiveRunStatus = Extract<
  RunStatus,
  "running" | "approval-waiting"
>;

export interface CronCadence {
  type: "cron";
  expression: string;
}

export type RunCadence = CronCadence;

export interface WorkspaceTargetContext {
  type: "workspace";
  uri: string;
  label?: string;
}

export type TargetContext = WorkspaceTargetContext;

export interface RunCounter {
  completed: number;
  limit: number | null;
}

export interface RunCapInput {
  maxRuns: number;
}

export interface CreateDraftScheduleInput {
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
  runCap?: RunCapInput;
}

export interface CreateActiveScheduleInput {
  runInstructions: string;
  cadence: RunCadence;
  targetContext: TargetContext;
  harnessMode: HarnessMode;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
  runCap?: RunCapInput;
}

export interface Schedule {
  id: string;
  revision: number;
  status: ScheduleStatus;
  enabled: boolean;
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
  runCounter: RunCounter;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type ResolvedHarnessPolicy = Record<string, unknown>;

export interface RunHistoryEntry {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  runInstructionsSnapshot: string;
  approvalModeSnapshot: ApprovalMode;
  resolvedHarnessPolicy: ResolvedHarnessPolicy;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  executedModel: string | null;
  targetContext: TargetContext | null;
  externalRunId: string | null;
  summary: string | null;
  error: string | null;
}

export interface ScheduleDetailRunCounterView extends RunCounter {
  label: string;
}

export interface ScheduleDetailRunInstructionsView {
  value: string;
  editable: true;
  scheduleRevision: number;
}

export interface ScheduleDetailOverview {
  status: ScheduleStatus;
  enabled: boolean;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  targetContext: TargetContext | null;
  cadence: RunCadence | null;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
  runCounter: ScheduleDetailRunCounterView;
}

export interface ScheduleHarnessModeAvailability {
  mode: HarnessMode;
  label: string;
  available: boolean;
  reason?: string;
  manualRunReady?: boolean;
  manualRunReason?: string;
  unattendedRunReady?: boolean;
  unattendedRunReason?: string;
  readinessNote?: string;
}

export interface ScheduleDetailHarnessAvailabilityState {
  modes: ScheduleHarnessModeAvailability[];
  selected: ScheduleHarnessModeAvailability | null;
  message: string;
}

export type ScheduleDetailActionKind =
  | "activate"
  | "run-now"
  | "pause"
  | "resume"
  | "restart"
  | "delete";

export interface ScheduleDetailAction {
  kind: ScheduleDetailActionKind;
  label: string;
  enabled: boolean;
  disabledReason?: string;
}

export interface ScheduleDetailActions {
  activate: ScheduleDetailAction;
  runNow: ScheduleDetailAction;
  pause: ScheduleDetailAction;
  resume: ScheduleDetailAction;
  restart: ScheduleDetailAction;
  delete: ScheduleDetailAction;
}

export interface ScheduleDetailHistoryLink {
  runId: string;
  view: "run-history-detail";
}

export interface RunOutcomeView {
  status: RunStatus;
  completedAt: IsoTimestamp | null;
  summary: string | null;
  error: string | null;
  description: string;
}

export interface ScheduleDetailPreviousRun extends RunHistoryEntry {
  outcome: RunOutcomeView;
  historyDetailLink: ScheduleDetailHistoryLink;
}

export interface ScheduleDetailNotificationState {
  runOutcomes: "quiet-in-app";
  desktopNotifications: "off";
}

export interface ScheduleDetailLocalSchedulingState {
  enabled: boolean;
  automaticRuns: "active" | "inactive";
  message: string;
}

export interface ResolveActiveRunInput {
  status: Extract<RunStatus, "completed" | "failed">;
  completedAt?: IsoTimestamp;
  summary?: string | null;
  error?: string | null;
}

export interface ScheduleSummary {
  id: string;
  status: ScheduleStatus;
  enabled: boolean;
  automaticRuns?: "active" | "inactive";
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  runCounter: RunCounter;
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
}

export interface ScheduleDetailView {
  schedule: Schedule;
  runInstructions: ScheduleDetailRunInstructionsView;
  overview: ScheduleDetailOverview;
  actions: ScheduleDetailActions;
  previousRuns: ScheduleDetailPreviousRun[];
  runCounter: RunCounter;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  notificationState: ScheduleDetailNotificationState;
  localScheduling: ScheduleDetailLocalSchedulingState;
  harnessAvailability: ScheduleDetailHarnessAvailabilityState;
}

export interface RunHistoryDetailView {
  run: RunHistoryEntry;
  scheduleId: string;
  scheduleRevision: number;
  resolvedRunInstructions: string;
  approvalMode: ApprovalMode;
  selectedModel: string;
  selectedAgentProfile?: string;
  executedModel: string | null;
  resolvedHarnessPolicy: ResolvedHarnessPolicy;
  outcome: RunOutcomeView;
  execution: LocalRunExecution | null;
  actions: {
    cancel: {
      kind: "cancel";
      label: string;
      enabled: boolean;
      disabledReason?: string;
    };
    open: {
      kind: "open";
      label: string;
      enabled: boolean;
      disabledReason?: string;
    };
  };
}

export interface UpdateScheduleInput {
  runInstructions?: string;
  cadence?: RunCadence | null;
  targetContext?: TargetContext | null;
  harnessMode?: HarnessMode | null;
  model?: string;
  agentProfile?: string;
  approvalMode?: ApprovalMode;
  runCap?: RunCapInput | null;
}

export interface DueWorkScanDiagnostics {
  scannedAt: IsoTimestamp;
  localScheduling: {
    enabled: boolean;
    message: string;
  };
  wakeupProvider: {
    configured: boolean;
    platform: "windows" | "macos" | null;
    triggerId: string | null;
    status: "installed" | "not-installed" | "unknown";
  };
  dueScheduleCount: number;
  outcomes: {
    started: number;
    completed: number;
    blocked: number;
    deferred: number;
    approvalWaiting: number;
    failed: number;
  };
}

export interface DueWorkScanResult {
  startedRunIds: string[];
  diagnostics: DueWorkScanDiagnostics;
}

export const SCHEDULE_EXPORT_SCHEMA_VERSION = 1;

export interface ScheduleExportEntry {
  sourceScheduleId: string;
  revision: number;
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  agentProfile?: string;
  approvalMode: ApprovalMode;
  runCap: RunCapInput | null;
}

export interface ScheduleExportFile {
  schemaVersion: typeof SCHEDULE_EXPORT_SCHEMA_VERSION;
  exportedAt: IsoTimestamp;
  schedules: ScheduleExportEntry[];
}

export interface ExportSchedulesInput {
  scheduleIds?: readonly string[];
}

export type ScheduleImportWarningCode =
  | "missing-workspace"
  | "unavailable-harness-mode"
  | "stale-policy-setting"
  | "activation-blocker";

export interface ScheduleImportWarning {
  sourceScheduleId: string;
  code: ScheduleImportWarningCode;
  message: string;
}

export interface ScheduleImportResult {
  schedules: Schedule[];
  warnings: ScheduleImportWarning[];
}

export interface ImportSchedulesOptions {
  isWorkspaceAvailable?: (uri: string) => boolean | Promise<boolean>;
}

export function isActiveRunStatus(
  status: RunStatus,
): status is ActiveRunStatus {
  return status === "running" || status === "approval-waiting";
}

export function isStartedRunStatus(status: RunStatus): boolean {
  return status !== "blocked" && status !== "deferred";
}
