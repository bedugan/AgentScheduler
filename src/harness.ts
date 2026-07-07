import type {
  HarnessMode,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  RunHistoryEntry,
  RunStatus,
  RunTrigger,
  Schedule,
} from "./domain.js";

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
}

export interface HarnessStartResult {
  externalRunId: string;
  status: Extract<
    RunStatus,
    "running" | "approval-waiting" | "completed" | "failed"
  >;
  completedAt: IsoTimestamp | null;
  summary: string | null;
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
}

export type HarnessStatusResult = HarnessRunUpdate;

export interface HarnessCancelRequest {
  schedule: Schedule;
  run: RunHistoryEntry;
  externalRunId: string;
  requestedAt: IsoTimestamp;
}

export interface HarnessCancelResult {
  status: Extract<RunStatus, "completed" | "failed" | "canceled">;
  completedAt: IsoTimestamp | null;
  summary: string | null;
  error: string | null;
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
  preflight(request: HarnessPreflightRequest): Promise<HarnessPreflightResult>;
  start(request: HarnessStartRequest): Promise<HarnessStartResult>;
  status(request: HarnessStatusRequest): Promise<HarnessStatusResult>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
  open(request: HarnessOpenRequest): Promise<HarnessOpenResult>;
}
