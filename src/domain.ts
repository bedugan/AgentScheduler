export type IsoTimestamp = string;

export type ApprovalMode =
  | "default-approvals"
  | "bypass-approvals"
  | "autopilot";

export type HarnessMode = "local-copilot" | "cloud-copilot";

export type ScheduleStatus = "draft" | "active" | "paused" | "completed";

export type RunTrigger = "draft-manual" | "manual" | "automatic";

export type RunStatus = "completed" | "failed" | "blocked";

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
  approvalMode: ApprovalMode;
  runCap?: RunCapInput;
}

export interface CreateActiveScheduleInput {
  runInstructions: string;
  cadence: RunCadence;
  targetContext: TargetContext;
  harnessMode: HarnessMode;
  model: string;
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
  targetContext: TargetContext | null;
  externalRunId: string | null;
  summary: string | null;
  error: string | null;
}

export interface ScheduleSummary {
  id: string;
  status: ScheduleStatus;
  enabled: boolean;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  runCounter: RunCounter;
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  approvalMode: ApprovalMode;
}

export interface ScheduleDetailView {
  schedule: Schedule;
  previousRuns: RunHistoryEntry[];
  runCounter: RunCounter;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
}

export interface DueWorkScanResult {
  startedRunIds: string[];
}
