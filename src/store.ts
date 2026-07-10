import type {
  IsoTimestamp,
  RunCounter,
  RunHistoryEntry,
  Schedule,
  ScheduleStatus,
} from "./domain.js";
import type {
  ExpiredExecutionClaim,
  LocalRunExecution,
} from "./localRunExecution.js";

export type ActiveRunReservationResult =
  | {
      reserved: true;
      run: RunHistoryEntry;
    }
  | {
      reserved: false;
      occupyingRun: RunHistoryEntry;
    };

export interface ScheduleRunStateUpdate {
  scheduleId: string;
  expectedRevision: number;
  expectedState: {
    status: ScheduleStatus;
    enabled: boolean;
    runCounter: RunCounter;
    nextRunAt: IsoTimestamp | null;
    lastRunAt: IsoTimestamp | null;
    updatedAt: IsoTimestamp;
  };
  status: ScheduleStatus;
  enabled: boolean;
  runCounter: RunCounter;
  nextRunAt: IsoTimestamp | null;
  lastRunAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}

export type RunResultCommit =
  | { committed: true; applied: boolean }
  | { committed: false };

export interface ScheduleStore {
  saveSchedule(schedule: Schedule): Promise<void>;
  getSchedule(id: string): Promise<Schedule | undefined>;
  listSchedules(): Promise<Schedule[]>;
  listDueSchedules(now: IsoTimestamp): Promise<Schedule[]>;
  deleteSchedule(id: string): Promise<void>;
  saveRunHistory(entry: RunHistoryEntry): Promise<void>;
  commitRunResult(
    entry: RunHistoryEntry,
    scheduleUpdate: ScheduleRunStateUpdate,
  ): Promise<RunResultCommit>;
  reserveActiveRun(entry: RunHistoryEntry): Promise<ActiveRunReservationResult>;
  getRunHistoryEntry(id: string): Promise<RunHistoryEntry | undefined>;
  listRunHistory(scheduleId: string): Promise<RunHistoryEntry[]>;
  listActiveRuns(): Promise<RunHistoryEntry[]>;
  getPendingDeferredRun(
    scheduleId: string,
  ): Promise<RunHistoryEntry | undefined>;
  saveLocalRunExecution(execution: LocalRunExecution): Promise<void>;
  getLocalRunExecution(runId: string): Promise<LocalRunExecution | undefined>;
  deleteLocalRunExecution(runId: string): Promise<void>;
  heartbeatLocalRunExecution(
    runId: string,
    ownerId: string,
    heartbeatAt: IsoTimestamp,
    leaseExpiresAt: IsoTimestamp,
  ): Promise<boolean>;
  claimExpiredExecution(claim: ExpiredExecutionClaim): Promise<boolean>;
  requestLocalRunCancellation(
    runId: string,
    ownerId: string,
    requestedAt: IsoTimestamp,
  ): Promise<boolean>;
}

export function cloneStoreValue<T>(value: T): T {
  return structuredClone(value);
}
