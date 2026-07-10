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
  HarnessExecutionObserver,
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
  type RunResultCommit,
  type ScheduleOperationalTransition,
  type ScheduleStore,
} from "./store.js";
import {
  RECOVERY_CLAIM_LEASE_MS,
  type ExpiredExecutionClaim,
  type LocalRunExecution,
} from "./localRunExecution.js";

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
  private readonly localRunExecutions = new Map<string, LocalRunExecution>();

  async createSchedule(schedule: Schedule): Promise<boolean> {
    if (this.schedules.has(schedule.id)) {
      return false;
    }
    this.schedules.set(schedule.id, cloneStoreValue(schedule));
    return true;
  }

  async compareAndSaveSchedule(
    expected: Schedule,
    schedule: Schedule,
  ): Promise<boolean> {
    if (
      schedule.id !== expected.id ||
      schedule.createdAt !== expected.createdAt
    ) {
      return false;
    }
    const current = this.schedules.get(expected.id);
    if (!current || !sameScheduleState(current, expected)) {
      return false;
    }
    this.schedules.set(schedule.id, cloneStoreValue(schedule));
    return true;
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

  async deleteScheduleIfIdle(
    id: string,
  ): Promise<"deleted" | "active-run" | "not-found"> {
    if (!this.schedules.has(id)) {
      return "not-found";
    }
    const hasActiveRun = (this.runHistory.get(id) ?? []).some(
      (run) => isActiveRunStatus(run.status) && run.completedAt === null,
    );
    if (hasActiveRun) {
      return "active-run";
    }
    for (const run of this.runHistory.get(id) ?? []) {
      this.localRunExecutions.delete(run.id);
    }
    this.schedules.delete(id);
    this.runHistory.delete(id);
    return "deleted";
  }

  async saveLocalRunExecution(execution: LocalRunExecution): Promise<void> {
    this.localRunExecutions.set(execution.runId, cloneStoreValue(execution));
  }

  async getLocalRunExecution(
    runId: string,
  ): Promise<LocalRunExecution | undefined> {
    const execution = this.localRunExecutions.get(runId);
    return execution ? cloneStoreValue(execution) : undefined;
  }

  async deleteLocalRunExecution(runId: string): Promise<void> {
    this.localRunExecutions.delete(runId);
  }

  async heartbeatLocalRunExecution(
    runId: string,
    ownerId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const execution = this.localRunExecutions.get(runId);
    const run = await this.getRunHistoryEntry(runId);
    if (
      !execution ||
      execution.ownerId !== ownerId ||
      execution.recoveryClaimedAt ||
      !run ||
      !isActiveRunStatus(run.status) ||
      run.completedAt !== null
    ) {
      return false;
    }
    this.localRunExecutions.set(runId, {
      ...execution,
      heartbeatAt,
      leaseExpiresAt,
    });
    return true;
  }

  async claimExpiredExecution(claim: ExpiredExecutionClaim): Promise<boolean> {
    const run = await this.getRunHistoryEntry(claim.runId);
    if (!run || !isActiveRunStatus(run.status) || run.completedAt !== null) {
      return false;
    }
    const execution = this.localRunExecutions.get(claim.runId);
    if (!execution) {
      if (
        claim.observedHeartbeatAt !== null ||
        claim.observedLeaseExpiresAt !== null
      ) {
        return false;
      }
      this.localRunExecutions.set(claim.runId, {
        runId: claim.runId,
        identity: `legacy:${claim.runId}`,
        ownerId: "reconciler",
        startedAt: run.startedAt,
        heartbeatAt: claim.claimedAt,
        leaseExpiresAt: claim.claimedAt,
        capabilities: { cancel: false, open: false, heartbeat: false },
        handle: null,
        recoveryClaimedAt: claim.claimedAt,
        cancellationRequestedAt: null,
      });
      return true;
    }
    if (
      (execution.recoveryClaimedAt &&
        new Date(execution.recoveryClaimedAt).getTime() +
          RECOVERY_CLAIM_LEASE_MS >
          new Date(claim.claimedAt).getTime()) ||
      execution.heartbeatAt !== claim.observedHeartbeatAt ||
      execution.leaseExpiresAt !== claim.observedLeaseExpiresAt ||
      execution.leaseExpiresAt > claim.claimedAt
    ) {
      return false;
    }
    this.localRunExecutions.set(claim.runId, {
      ...execution,
      recoveryClaimedAt: claim.claimedAt,
    });
    return true;
  }

  async requestLocalRunCancellation(
    runId: string,
    ownerId: string,
    requestedAt: string,
  ): Promise<boolean> {
    const execution = this.localRunExecutions.get(runId);
    const run = await this.getRunHistoryEntry(runId);
    if (
      !execution ||
      execution.ownerId !== ownerId ||
      execution.cancellationRequestedAt ||
      !execution.capabilities.cancel ||
      !run ||
      !isActiveRunStatus(run.status) ||
      run.completedAt !== null
    ) {
      return false;
    }
    this.localRunExecutions.set(runId, {
      ...execution,
      cancellationRequestedAt: requestedAt,
    });
    return true;
  }

  async saveRunHistory(entry: RunHistoryEntry): Promise<void> {
    this.upsertRunHistory(entry);
  }

  private upsertRunHistory(entry: RunHistoryEntry): void {
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

  async commitRunResult(
    entry: RunHistoryEntry,
    transition: ScheduleOperationalTransition,
  ): Promise<RunResultCommit> {
    const existingRun = (this.runHistory.get(entry.scheduleId) ?? []).find(
      (candidate) => candidate.id === entry.id,
    );
    if (
      !isActiveRunStatus(entry.status) &&
      existingRun &&
      !isActiveRunStatus(existingRun.status)
    ) {
      return { committed: true, applied: false };
    }

    const schedule = this.schedules.get(transition.scheduleId);
    if (
      !schedule ||
      schedule.revision !== transition.expectedRevision ||
      schedule.status !== transition.expectedState.status ||
      schedule.enabled !== transition.expectedState.enabled ||
      JSON.stringify(schedule.runCounter) !==
        JSON.stringify(transition.expectedState.runCounter) ||
      schedule.nextRunAt !== transition.expectedState.nextRunAt ||
      schedule.lastRunAt !== transition.expectedState.lastRunAt ||
      schedule.updatedAt !== transition.expectedState.updatedAt
    ) {
      return { committed: false };
    }

    this.schedules.set(schedule.id, cloneStoreValue({
      ...schedule,
      status: transition.status,
      enabled: transition.enabled,
      runCounter: transition.runCounter,
      nextRunAt: transition.nextRunAt,
      lastRunAt: transition.lastRunAt,
      updatedAt: transition.updatedAt,
    }));
    this.upsertRunHistory(entry);
    return { committed: true, applied: true };
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

  async start(
    request: HarnessStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult> {
    this.startRequests.push(cloneStoreValue(request));
    const result = this.startResult
      ? typeof this.startResult === "function"
        ? cloneStoreValue(this.startResult(request))
        : cloneStoreValue(this.startResult)
      : {
          externalRunId: `fake-run-${this.startRequests.length}`,
          status: "completed" as const,
          completedAt: request.requestedAt,
          summary: "Fake harness completed the draft run.",
        };
    if (observer) {
      await observer.started({
        identity: result.externalRunId,
        capabilities: { cancel: true, open: false, heartbeat: false },
      });
    }
    return result;
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

function sameScheduleState(left: Schedule, right: Schedule): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.status === right.status &&
    left.enabled === right.enabled &&
    JSON.stringify(left.runCounter) === JSON.stringify(right.runCounter) &&
    left.nextRunAt === right.nextRunAt &&
    left.lastRunAt === right.lastRunAt &&
    left.updatedAt === right.updatedAt
  );
}
