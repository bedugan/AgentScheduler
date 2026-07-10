import type {
  HarnessMode,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  RunHistoryEntry,
  RunStatus,
  RunTrigger,
  Schedule,
  ScheduleHarnessModeAvailability,
} from "./domain.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import type { LocalRunExecutionStarted } from "./localRunExecution.js";

export interface HarnessPreflightRequest {
  schedule: Schedule;
  trigger: RunTrigger;
  requestedAt: IsoTimestamp;
  localSchedulingEnabled: boolean;
}

export type HarnessPreflightResult =
  | {
      status: "ready";
      resolvedHarnessPolicy: ResolvedHarnessPolicy;
    }
  | {
      status: "blocked";
      reason: string;
      resolvedHarnessPolicy?: ResolvedHarnessPolicy;
    }
  | {
      status: "requires-approval";
      reason: string;
      resolvedHarnessPolicy: ResolvedHarnessPolicy;
    }
  | {
      status: "deferred";
      reason: string;
      resolvedHarnessPolicy?: ResolvedHarnessPolicy;
    };

export interface HarnessStartRequest {
  schedule: Schedule;
  trigger: RunTrigger;
  requestedAt: IsoTimestamp;
  runInstructions: string;
  resolvedHarnessPolicy: ResolvedHarnessPolicy;
  executionIdentity?: string;
}

export interface HarnessExecutionObserver {
  started(execution: LocalRunExecutionStarted): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface HarnessStartResult {
  externalRunId: string;
  status: Extract<
    RunStatus,
    "running" | "approval-waiting" | "completed" | "failed"
  >;
  completedAt: IsoTimestamp | null;
  summary: string | null;
  executedModel?: string | null;
}

export interface HarnessStatusRequest {
  schedule: Schedule;
  run: RunHistoryEntry;
  externalRunId: string;
  requestedAt: IsoTimestamp;
}

export interface HarnessRunUpdate {
  status: Extract<
    RunStatus,
    "running" | "approval-waiting" | "completed" | "failed" | "canceled"
  >;
  completedAt: IsoTimestamp | null;
  summary: string | null;
  error: string | null;
  executedModel?: string | null;
}

export type HarnessStatusResult = HarnessRunUpdate;

export interface HarnessCancelRequest {
  schedule: Schedule;
  run: RunHistoryEntry;
  externalRunId: string;
  requestedAt: IsoTimestamp;
  executionIdentity?: string;
}

export interface HarnessCancelResult {
  status: Extract<RunStatus, "completed" | "failed" | "canceled">;
  completedAt: IsoTimestamp | null;
  summary: string | null;
  error: string | null;
  executedModel?: string | null;
}

export type HarnessOpenPurpose = "open" | "review";

export interface HarnessOpenRequest {
  schedule: Schedule;
  run: RunHistoryEntry;
  externalRunId: string;
  purpose: HarnessOpenPurpose;
  requestedAt: IsoTimestamp;
}

export type HarnessOpenResult =
  | {
      status: "opened";
      target: string;
    }
  | {
      status: "blocked";
      reason: string;
    };

export interface AgentHarness {
  readonly mode: HarnessMode;
  availability?(schedule?: Schedule): ScheduleHarnessModeAvailability;
  refreshAvailability?(
    schedule?: Schedule,
  ): Promise<ScheduleHarnessModeAvailability>;
  models?(): Promise<readonly ScheduleModelOption[]>;
  preflight(request: HarnessPreflightRequest): Promise<HarnessPreflightResult>;
  start(
    request: HarnessStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult>;
  status(request: HarnessStatusRequest): Promise<HarnessStatusResult>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
  open(request: HarnessOpenRequest): Promise<HarnessOpenResult>;
}
