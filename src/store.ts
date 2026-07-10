import type {
  IsoTimestamp,
  RunCounter,
  RunHistoryEntry,
  Schedule,
  ScheduleStatus,
} from "./domain.js";

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
}

export function cloneStoreValue<T>(value: T): T {
  return structuredClone(value);
}
