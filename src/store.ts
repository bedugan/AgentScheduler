import type { IsoTimestamp, RunHistoryEntry, Schedule } from "./domain.js";

export interface ScheduleStore {
  saveSchedule(schedule: Schedule): Promise<void>;
  getSchedule(id: string): Promise<Schedule | undefined>;
  listSchedules(): Promise<Schedule[]>;
  listDueSchedules(now: IsoTimestamp): Promise<Schedule[]>;
  saveRunHistory(entry: RunHistoryEntry): Promise<void>;
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
