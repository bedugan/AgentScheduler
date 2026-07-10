import type { Clock, IdGenerator } from "./scheduleLifecycle.js";
import type {
  HarnessMode,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  RunHistoryEntry,
  Schedule,
  ScheduleHarnessModeAvailability,
} from "./domain.js";
import { isActiveRunStatus } from "./domain.js";
import type {
  AgentHarness,
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessOpenRequest,
  HarnessOpenResult,
  HarnessPreflightRequest,
  HarnessPreflightResult,
  HarnessStartRequest,
  HarnessStartResult,
  HarnessStatusRequest,
  HarnessStatusResult,
} from "./harness.js";
import {
  defaultLocalSchedulingSetupState,
  type LocalSchedulingSetupState,
  type LocalSchedulingSetupStore,
} from "./localSchedulingSetup.js";
import {
  cloneStoreValue,
  type ActiveRunReservationResult,
  type ScheduleStore,
} from "./store.js";

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
          schedule.cadence !== null &&
          schedule.targetContext !== null &&
          schedule.harnessMode !== null &&
          schedule.nextRunAt !== null &&
          schedule.nextRunAt <= now,
      )
      .map((schedule) => cloneStoreValue(schedule));
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
    this.runHistory.delete(id);
  }

  async saveRunHistory(entry: RunHistoryEntry): Promise<void> {
    const entries = this.runHistory.get(entry.scheduleId) ?? [];
    const existingIndex = entries.findIndex(
      (existingEntry) => existingEntry.id === entry.id,
    );
    if (existingIndex === -1) {
      entries.push(cloneStoreValue(entry));
    } else {
      entries[existingIndex] = cloneStoreValue(entry);
    }
    this.runHistory.set(entry.scheduleId, entries);
  }

  async reserveActiveRun(
    entry: RunHistoryEntry,
  ): Promise<ActiveRunReservationResult> {
    const occupyingRun = (await this.listActiveRuns()).find(
      (candidate) =>
        candidate.scheduleId === entry.scheduleId ||
        sameRunSlot(candidate, entry),
    );
    if (occupyingRun) {
      return { reserved: false, occupyingRun };
    }

    await this.saveRunHistory(entry);
    return { reserved: true, run: cloneStoreValue(entry) };
  }

  async getRunHistoryEntry(id: string): Promise<RunHistoryEntry | undefined> {
    for (const entries of this.runHistory.values()) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry) {
        return cloneStoreValue(entry);
      }
    }

    return undefined;
  }

  async listRunHistory(scheduleId: string): Promise<RunHistoryEntry[]> {
    return (this.runHistory.get(scheduleId) ?? [])
      .map((entry) => cloneStoreValue(entry))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async listActiveRuns(): Promise<RunHistoryEntry[]> {
    return [...this.runHistory.values()]
      .flat()
      .filter(
        (entry) => isActiveRunStatus(entry.status) && entry.completedAt === null,
      )
      .map((entry) => cloneStoreValue(entry));
  }

  async getPendingDeferredRun(
    scheduleId: string,
  ): Promise<RunHistoryEntry | undefined> {
    const entry = (this.runHistory.get(scheduleId) ?? []).find(
      (candidate) =>
        candidate.status === "deferred" && candidate.completedAt === null,
    );
    return entry ? cloneStoreValue(entry) : undefined;
  }
}

type FakeHarnessPreflightResult =
  | HarnessPreflightResult
  | ((request: HarnessPreflightRequest) => HarnessPreflightResult);

type FakeHarnessStartResult =
  | HarnessStartResult
  | ((request: HarnessStartRequest) => HarnessStartResult);

export class InMemoryLocalSchedulingSetupStore
  implements LocalSchedulingSetupStore
{
  private state = defaultLocalSchedulingSetupState();

  async getLocalSchedulingSetup(): Promise<LocalSchedulingSetupState> {
    return cloneStoreValue(this.state);
  }

  async saveLocalSchedulingSetup(
    state: LocalSchedulingSetupState,
  ): Promise<void> {
    this.state = cloneStoreValue(state);
  }
}

type FakeHarnessStatusResult =
  | HarnessStatusResult
  | ((request: HarnessStatusRequest) => HarnessStatusResult);

type FakeHarnessCancelResult =
  | HarnessCancelResult
  | ((request: HarnessCancelRequest) => HarnessCancelResult);

type FakeHarnessOpenResult =
  | HarnessOpenResult
  | ((request: HarnessOpenRequest) => HarnessOpenResult);

export class FakeHarness implements AgentHarness {
  readonly mode: HarnessMode;
  readonly preflightRequests: HarnessPreflightRequest[] = [];
  readonly startRequests: HarnessStartRequest[] = [];
  readonly statusRequests: HarnessStatusRequest[] = [];
  readonly cancelRequests: HarnessCancelRequest[] = [];
  readonly openRequests: HarnessOpenRequest[] = [];
  private readonly policyOverride: ResolvedHarnessPolicy | null;
  private readonly preflightResult: FakeHarnessPreflightResult | null;
  private readonly startResult: FakeHarnessStartResult | null;
  private readonly statusResult: FakeHarnessStatusResult | null;
  private readonly cancelResult: FakeHarnessCancelResult | null;
  private readonly openResult: FakeHarnessOpenResult | null;
  private readonly availabilityResult: ScheduleHarnessModeAvailability | null;

  constructor(options: {
    mode: HarnessMode;
    resolvedPolicy?: ResolvedHarnessPolicy;
    preflightResult?: FakeHarnessPreflightResult;
    startResult?: FakeHarnessStartResult;
    statusResult?: FakeHarnessStatusResult;
    cancelResult?: FakeHarnessCancelResult;
    openResult?: FakeHarnessOpenResult;
    availability?: ScheduleHarnessModeAvailability;
  }) {
    this.mode = options.mode;
    this.policyOverride = options.resolvedPolicy ?? null;
    this.preflightResult = options.preflightResult ?? null;
    this.startResult = options.startResult ?? null;
    this.statusResult = options.statusResult ?? null;
    this.cancelResult = options.cancelResult ?? null;
    this.openResult = options.openResult ?? null;
    this.availabilityResult = options.availability ?? null;
  }

  availability(): ScheduleHarnessModeAvailability {
    return (
      this.availabilityResult ?? {
        mode: this.mode,
        label:
          this.mode === "local-copilot"
            ? "Local Copilot Mode"
            : "Cloud Copilot Mode",
        available: true,
      }
    );
  }

  async preflight(
    request: HarnessPreflightRequest,
  ): Promise<HarnessPreflightResult> {
    this.preflightRequests.push(cloneStoreValue(request));
    if (this.preflightResult) {
      return typeof this.preflightResult === "function"
        ? cloneStoreValue(this.preflightResult(request))
        : cloneStoreValue(this.preflightResult);
    }

    return {
      status: "ready",
      resolvedHarnessPolicy:
        this.policyOverride ?? this.defaultPolicy(request.schedule),
    };
  }

  async start(request: HarnessStartRequest): Promise<HarnessStartResult> {
    this.startRequests.push(cloneStoreValue(request));
    if (this.startResult) {
      return typeof this.startResult === "function"
        ? cloneStoreValue(this.startResult(request))
        : cloneStoreValue(this.startResult);
    }

    return {
      externalRunId: `fake-run-${this.startRequests.length}`,
      status: "completed",
      completedAt: request.requestedAt,
      summary: "Fake harness completed the draft run.",
    };
  }

  async status(request: HarnessStatusRequest): Promise<HarnessStatusResult> {
    this.statusRequests.push(cloneStoreValue(request));
    if (this.statusResult) {
      return typeof this.statusResult === "function"
        ? cloneStoreValue(this.statusResult(request))
        : cloneStoreValue(this.statusResult);
    }

    return {
      status: "completed",
      completedAt: request.requestedAt,
      summary: "Fake harness reported the run completed.",
      error: null,
    };
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    this.cancelRequests.push(cloneStoreValue(request));
    if (this.cancelResult) {
      return typeof this.cancelResult === "function"
        ? cloneStoreValue(this.cancelResult(request))
        : cloneStoreValue(this.cancelResult);
    }

    return {
      status: "canceled",
      completedAt: request.requestedAt,
      summary: "Fake harness canceled the run.",
      error: null,
    };
  }

  async open(request: HarnessOpenRequest): Promise<HarnessOpenResult> {
    this.openRequests.push(cloneStoreValue(request));
    if (this.openResult) {
      return typeof this.openResult === "function"
        ? cloneStoreValue(this.openResult(request))
        : cloneStoreValue(this.openResult);
    }

    return {
      status: "opened",
      target: `fake://${this.mode}/${request.externalRunId}/${request.purpose}`,
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

function sameRunSlot(left: RunHistoryEntry, right: RunHistoryEntry): boolean {
  return (
    left.harnessMode !== null &&
    right.harnessMode !== null &&
    left.targetContext !== null &&
    right.targetContext !== null &&
    left.harnessMode === right.harnessMode &&
    left.targetContext.type === right.targetContext.type &&
    left.targetContext.uri === right.targetContext.uri
  );
}
