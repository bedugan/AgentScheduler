import type {
  HarnessMode,
  IsoTimestamp,
  ResolvedHarnessPolicy,
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
  status: Exclude<RunStatus, "blocked">;
  completedAt: IsoTimestamp | null;
  summary: string | null;
}

export interface AgentHarness {
  readonly mode: HarnessMode;
  preflight(request: HarnessPreflightRequest): Promise<HarnessPreflightResult>;
  start(request: HarnessStartRequest): Promise<HarnessStartResult>;
}
