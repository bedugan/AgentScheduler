import type { Clock, IdGenerator } from "./scheduleLifecycle.js";
import type {
  HarnessMode,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  RunHistoryEntry,
  Schedule,
} from "./domain.js";
import type {
  AgentHarness,
  HarnessPreflightRequest,
  HarnessPreflightResult,
  HarnessStartRequest,
  HarnessStartResult,
} from "./harness.js";
import { cloneStoreValue, type ScheduleStore } from "./store.js";

export class FakeClock implements Clock {
  private current: Date;

  constructor(initialInstant: IsoTimestamp) {
    this.current = new Date(initialInstant);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(nextInstant: IsoTimestamp): void {
    this.current = new Date(nextInstant);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private next = 1;

  nextId(prefix: string): string {
    const id = `${prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, Schedule>();
  private readonly runHistory = new Map<string, RunHistoryEntry[]>();

  async saveSchedule(schedule: Schedule): Promise<void> {
    this.schedules.set(schedule.id, cloneStoreValue(schedule));
  }

  async getSchedule(id: string): Promise<Schedule | undefined> {
    const schedule = this.schedules.get(id);
    return schedule ? cloneStoreValue(schedule) : undefined;
  }

  async listSchedules(): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .map((schedule) => cloneStoreValue(schedule))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listDueSchedules(now: IsoTimestamp): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter(
        (schedule) =>
          schedule.enabled &&
          schedule.status === "active" &&
          schedule.nextRunAt !== null &&
          schedule.nextRunAt <= now,
      )
      .map((schedule) => cloneStoreValue(schedule));
  }

  async saveRunHistory(entry: RunHistoryEntry): Promise<void> {
    const entries = this.runHistory.get(entry.scheduleId) ?? [];
    entries.push(cloneStoreValue(entry));
    this.runHistory.set(entry.scheduleId, entries);
  }

  async listRunHistory(scheduleId: string): Promise<RunHistoryEntry[]> {
    return (this.runHistory.get(scheduleId) ?? [])
      .map((entry) => cloneStoreValue(entry))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
}

export class FakeHarness implements AgentHarness {
  readonly mode: HarnessMode;
  readonly preflightRequests: HarnessPreflightRequest[] = [];
  readonly startRequests: HarnessStartRequest[] = [];
  private readonly policyOverride: ResolvedHarnessPolicy | null;

  constructor(options: {
    mode: HarnessMode;
    resolvedPolicy?: ResolvedHarnessPolicy;
  }) {
    this.mode = options.mode;
    this.policyOverride = options.resolvedPolicy ?? null;
  }

  async preflight(
    request: HarnessPreflightRequest,
  ): Promise<HarnessPreflightResult> {
    this.preflightRequests.push(cloneStoreValue(request));
    return {
      status: "ready",
      resolvedHarnessPolicy:
        this.policyOverride ?? this.defaultPolicy(request.schedule),
    };
  }

  async start(request: HarnessStartRequest): Promise<HarnessStartResult> {
    this.startRequests.push(cloneStoreValue(request));
    return {
      externalRunId: `fake-run-${this.startRequests.length}`,
      status: "completed",
      completedAt: request.requestedAt,
      summary: "Fake harness completed the draft run.",
    };
  }

  private defaultPolicy(schedule: Schedule): ResolvedHarnessPolicy {
    return {
      harnessMode: schedule.harnessMode,
      approvalMode: schedule.approvalMode,
      sandbox: "fake",
    };
  }
}
