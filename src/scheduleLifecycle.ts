import { randomUUID } from "node:crypto";

import type {
  CreateDraftScheduleInput,
  DueWorkScanResult,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  RunHistoryEntry,
  RunTrigger,
  Schedule,
  ScheduleDetailView,
} from "./domain.js";
import type { AgentHarness } from "./harness.js";
import type { ScheduleStore } from "./store.js";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(prefix: string): string;
}

export interface ScheduleLifecycleOptions {
  store: ScheduleStore;
  harnesses: AgentHarness[];
  clock?: Clock;
  idGenerator?: IdGenerator;
  localSchedulingEnabled?: boolean;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator implements IdGenerator {
  nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

export class ScheduleLifecycle {
  private readonly store: ScheduleStore;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly localSchedulingEnabled: boolean;
  private readonly harnesses: Map<string, AgentHarness>;

  constructor(options: ScheduleLifecycleOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
    this.localSchedulingEnabled = options.localSchedulingEnabled ?? false;
    this.harnesses = new Map(
      options.harnesses.map((harness) => [harness.mode, harness]),
    );
  }

  async createDraftSchedule(input: CreateDraftScheduleInput): Promise<Schedule> {
    const now = this.nowIso();
    const schedule: Schedule = {
      id: this.idGenerator.nextId("schedule"),
      revision: 1,
      status: "draft",
      enabled: false,
      runInstructions: input.runInstructions,
      cadence: input.cadence,
      targetContext: input.targetContext,
      harnessMode: input.harnessMode,
      model: input.model,
      approvalMode: input.approvalMode,
      runCounter: {
        completed: 0,
        limit: input.runCap?.maxRuns ?? null,
      },
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveSchedule(schedule);
    return schedule;
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.store.listSchedules();
  }

  async openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView> {
    const schedule = await this.requireSchedule(scheduleId);
    const previousRuns = await this.store.listRunHistory(scheduleId);

    return {
      schedule,
      previousRuns,
      runCounter: schedule.runCounter,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
    };
  }

  async scanDueWork(): Promise<DueWorkScanResult> {
    if (!this.localSchedulingEnabled) {
      return { startedRunIds: [] };
    }

    const dueSchedules = await this.store.listDueSchedules(this.nowIso());
    const startedRunIds: string[] = [];

    for (const schedule of dueSchedules) {
      const run = await this.startRun(schedule, "automatic");
      startedRunIds.push(run.id);
    }

    return { startedRunIds };
  }

  async startManualRun(scheduleId: string): Promise<RunHistoryEntry> {
    const schedule = await this.requireSchedule(scheduleId);
    const trigger: RunTrigger =
      schedule.status === "draft" ? "draft-manual" : "manual";

    return this.startRun(schedule, trigger);
  }

  private async startRun(
    schedule: Schedule,
    trigger: RunTrigger,
  ): Promise<RunHistoryEntry> {
    const requestedAt = this.nowIso();
    const harness = this.harnesses.get(schedule.harnessMode);

    if (!harness) {
      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error: `Harness mode '${schedule.harnessMode}' is unavailable.`,
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    const preflight = await harness.preflight({
      schedule,
      trigger,
      requestedAt,
      localSchedulingEnabled: this.localSchedulingEnabled,
    });

    if (preflight.status === "blocked") {
      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy:
          preflight.resolvedHarnessPolicy ?? this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error: preflight.reason,
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    const startResult = await harness.start({
      schedule,
      trigger,
      requestedAt,
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
    });
    const run = this.buildRunHistoryEntry({
      schedule,
      trigger,
      startedAt: requestedAt,
      completedAt: startResult.completedAt,
      status: startResult.status,
      resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
      externalRunId: startResult.externalRunId,
      summary: startResult.summary,
      error: null,
    });

    await this.persistRunResult(schedule, run, trigger);
    return run;
  }

  private buildRunHistoryEntry(input: {
    schedule: Schedule;
    trigger: RunTrigger;
    startedAt: IsoTimestamp;
    completedAt: IsoTimestamp | null;
    status: RunHistoryEntry["status"];
    resolvedHarnessPolicy: ResolvedHarnessPolicy;
    externalRunId: string | null;
    summary: string | null;
    error: string | null;
  }): RunHistoryEntry {
    return {
      id: this.idGenerator.nextId("run"),
      scheduleId: input.schedule.id,
      scheduleRevision: input.schedule.revision,
      trigger: input.trigger,
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      runInstructionsSnapshot: input.schedule.runInstructions,
      approvalModeSnapshot: input.schedule.approvalMode,
      resolvedHarnessPolicy: input.resolvedHarnessPolicy,
      harnessMode: input.schedule.harnessMode,
      model: input.schedule.model,
      targetContext: input.schedule.targetContext,
      externalRunId: input.externalRunId,
      summary: input.summary,
      error: input.error,
    };
  }

  private async persistRunResult(
    schedule: Schedule,
    run: RunHistoryEntry,
    trigger: RunTrigger,
  ): Promise<void> {
    await this.store.saveRunHistory(run);

    const completedAt = run.completedAt ?? run.startedAt;
    const nextRunCounter = { ...schedule.runCounter };

    if (trigger !== "draft-manual" && run.status === "completed") {
      nextRunCounter.completed += 1;
    }

    await this.store.saveSchedule({
      ...schedule,
      runCounter: nextRunCounter,
      lastRunAt: completedAt,
      updatedAt: completedAt,
    });
  }

  private defaultPolicySnapshot(schedule: Schedule): ResolvedHarnessPolicy {
    return {
      harnessMode: schedule.harnessMode,
      approvalMode: schedule.approvalMode,
    };
  }

  private async requireSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.store.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule '${scheduleId}' was not found.`);
    }
    return schedule;
  }

  private nowIso(): IsoTimestamp {
    return this.clock.now().toISOString();
  }
}
