import type { IsoTimestamp, RunHistoryEntry, Schedule } from "./domain.js";

export interface ScheduleStore {
  saveSchedule(schedule: Schedule): Promise<void>;
  getSchedule(id: string): Promise<Schedule | undefined>;
  listSchedules(): Promise<Schedule[]>;
  listDueSchedules(now: IsoTimestamp): Promise<Schedule[]>;
  saveRunHistory(entry: RunHistoryEntry): Promise<void>;
  listRunHistory(scheduleId: string): Promise<RunHistoryEntry[]>;
}

export function cloneStoreValue<T>(value: T): T {
  return structuredClone(value);
}
