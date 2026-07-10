import { randomUUID } from "node:crypto";

import type {
  DueWorkScanDiagnostics,
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  DueWorkScanResult,
  ExportSchedulesInput,
  HarnessMode,
  ImportSchedulesOptions,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  ResolveActiveRunInput,
  RunHistoryEntry,
  RunHistoryDetailView,
  RunOutcomeView,
  RunTrigger,
  Schedule,
  ScheduleHarnessModeAvailability,
  ScheduleExportFile,
  ScheduleDetailPreviousRun,
  ScheduleDetailView,
  ScheduleImportResult,
  UpdateScheduleInput,
} from "./domain.js";
import {
  HARNESS_MODE_LABELS,
  SUPPORTED_HARNESS_MODES,
  isActiveRunStatus,
  isStartedRunStatus,
} from "./domain.js";
import {
  hasReachedRunCap,
  reduceRecurrenceAfterRun,
} from "./recurrenceReducer.js";
import { ScheduleDefinition } from "./scheduleDefinition.js";
import { ScheduleFile } from "./scheduleFile.js";
import type {
  AgentHarness,
  HarnessCancelResult,
  HarnessOpenPurpose,
  HarnessOpenResult,
  HarnessStartResult,
  HarnessStatusResult,
} from "./harness.js";
import type {
  LocalSchedulingSetupState,
  LocalSchedulingStateSource,
} from "./localSchedulingSetup.js";
import { defaultLocalSchedulingSetupState } from "./localSchedulingSetup.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import {
  LEGACY_ACTIVE_RUN_GRACE_MS,
  NON_HEARTBEATING_RUN_LEASE_MS,
  isExecutionLeaseExpired,
  leaseExpiry,
  type LocalRunExecutionStarted,
} from "./localRunExecution.js";

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
  localSchedulingSetup?: LocalSchedulingStateSource;
  executionOwnerId?: string;
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
  private readonly localSchedulingSetup: LocalSchedulingStateSource | undefined;
  private readonly harnesses: Map<string, AgentHarness>;
  private readonly manualRunReservations = new Set<string>();
  private readonly executionOwnerId: string;
  private readonly scheduleDefinition: ScheduleDefinition;
  private readonly scheduleFile: ScheduleFile;

  constructor(options: ScheduleLifecycleOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
    this.localSchedulingEnabled = options.localSchedulingEnabled ?? false;
    this.localSchedulingSetup = options.localSchedulingSetup;
    this.executionOwnerId = options.executionOwnerId ?? `process:${process.pid}:${randomUUID()}`;
    this.harnesses = new Map(
      options.harnesses.map((harness) => [harness.mode, harness]),
    );
    this.scheduleDefinition = new ScheduleDefinition(
      this.idGenerator,
      (schedule) => this.selectedHarnessUnavailableReason(schedule),
    );
    this.scheduleFile = new ScheduleFile(this.idGenerator, (mode) =>
      this.harnesses.has(mode),
    );
  }

  async createDraftSchedule(input: CreateDraftScheduleInput): Promise<Schedule> {
    return this.createSchedule(input, "draft");
  }

  async createActiveSchedule(input: CreateActiveScheduleInput): Promise<Schedule> {
    return this.createSchedule(input, "active");
  }

  private async createSchedule(
    input: CreateDraftScheduleInput | CreateActiveScheduleInput,
    status: "draft" | "active",
  ): Promise<Schedule> {
    const schedule = this.scheduleDefinition.create(input, status, this.clock.now());
    await this.store.saveSchedule(schedule);
    return schedule;
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.store.listSchedules();
  }

  listHarnessModeAvailability(): ScheduleHarnessModeAvailability[] {
    return SUPPORTED_HARNESS_MODES.map((mode) =>
      this.harnessModeAvailabilityFor(mode),
    );
  }

  async refreshHarnessModeAvailability(
    mode: HarnessMode,
    schedule?: Schedule,
  ): Promise<ScheduleHarnessModeAvailability> {
    const harness = this.harnesses.get(mode);
    if (harness?.refreshAvailability) {
      return harness.refreshAvailability(schedule);
    }
    return this.harnessModeAvailabilityFor(mode);
  }

  async listHarnessModels(mode: HarnessMode): Promise<readonly ScheduleModelOption[]> {
    return (await this.harnesses.get(mode)?.models?.()) ?? [];
  }

  async exportSchedules(
    input: ExportSchedulesInput = {},
  ): Promise<ScheduleExportFile> {
    const schedules = input.scheduleIds
      ? await Promise.all(input.scheduleIds.map((id) => this.requireSchedule(id)))
      : await this.store.listSchedules();

    return this.scheduleFile.export(schedules, this.nowIso());
  }

  async exportSchedulesAsJson(input: ExportSchedulesInput = {}): Promise<string> {
    return `${JSON.stringify(await this.exportSchedules(input), null, 2)}\n`;
  }

  async importSchedules(
    exportFile: unknown,
    options: ImportSchedulesOptions = {},
  ): Promise<ScheduleImportResult> {
    const result = await this.scheduleFile.import(
      exportFile,
      options,
      this.nowIso(),
    );
    for (const schedule of result.schedules) {
      await this.store.saveSchedule(schedule);
    }
    return result;
  }

  async importSchedulesJson(
    json: string,
    options: ImportSchedulesOptions = {},
  ): Promise<ScheduleImportResult> {
    const result = await this.scheduleFile.importJson(
      json,
      options,
      this.nowIso(),
    );
    for (const schedule of result.schedules) {
      await this.store.saveSchedule(schedule);
    }
    return result;
  }

  async activateSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    const activeSchedule = this.scheduleDefinition.transition(
      schedule,
      "activate",
      this.clock.now(),
    );

    await this.store.saveSchedule(activeSchedule);
    return activeSchedule;
  }

  async pauseSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    const pausedSchedule = this.scheduleDefinition.transition(
      schedule,
      "pause",
      this.clock.now(),
    );

    await this.store.saveSchedule(pausedSchedule);
    return pausedSchedule;
  }

  async resumeSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    const resumedSchedule = this.scheduleDefinition.transition(
      schedule,
      "resume",
      this.clock.now(),
    );

    await this.store.saveSchedule(resumedSchedule);
    return resumedSchedule;
  }

  async restartCompletedSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    const restartedSchedule = this.scheduleDefinition.transition(
      schedule,
      "restart",
      this.clock.now(),
    );

    await this.store.saveSchedule(restartedSchedule);
    return restartedSchedule;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.requireSchedule(scheduleId);
    const activeRun = (await this.store.listActiveRuns()).find(
      (run) => run.scheduleId === scheduleId,
    );
    if (activeRun) {
      throw new Error(
        "Schedule cannot be deleted while it has a running or approval-waiting run. Cancel or resolve the active run before deleting the schedule.",
      );
    }

    await this.store.deleteSchedule(scheduleId);
  }

  async updateSchedule(
    scheduleId: string,
    input: UpdateScheduleInput,
  ): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    const nextSchedule = this.scheduleDefinition.update(
      schedule,
      input,
      this.clock.now(),
    );

    await this.store.saveSchedule(nextSchedule);
    return nextSchedule;
  }

  async openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView> {
    const schedule = await this.requireSchedule(scheduleId);
    if (schedule.harnessMode) {
      await this.refreshHarnessModeAvailability(schedule.harnessMode, schedule);
    }
    const previousRuns = await this.store.listRunHistory(scheduleId);
    const localSchedulingEnabled = await this.isLocalSchedulingEnabled();

    return this.scheduleDetailViewFor(
      schedule,
      previousRuns,
      localSchedulingEnabled,
    );
  }

  async openRunHistoryDetail(runId: string): Promise<RunHistoryDetailView> {
    const run = await this.requireRun(runId);
    const execution = await this.store.getLocalRunExecution(run.id);
    const active = isActiveRunStatus(run.status) && run.completedAt === null;
    const cancelReady =
      active &&
      execution?.ownerId === this.executionOwnerId &&
      execution.capabilities.cancel &&
      !execution.cancellationRequestedAt;

    return {
      run,
      scheduleId: run.scheduleId,
      scheduleRevision: run.scheduleRevision,
      resolvedRunInstructions: run.runInstructionsSnapshot,
      approvalMode: run.approvalModeSnapshot,
      selectedModel: run.model,
      executedModel: run.executedModel,
      resolvedHarnessPolicy: run.resolvedHarnessPolicy,
      outcome: this.runOutcomeViewFor(run),
      execution: execution ?? null,
      actions: {
        cancel: {
          kind: "cancel",
          label: "Cancel Run",
          enabled: cancelReady,
          ...(!cancelReady && {
            disabledReason: active
              ? execution
                ? execution.cancellationRequestedAt
                  ? "Cancellation was requested and AgentScheduler is waiting for the execution to exit."
                  : "Cancellation is unsupported from this process or execution type."
                : "Cancellation is unavailable because this active run has no recoverable execution identity."
              : "Only active runs can be canceled.",
          }),
        },
        open: {
          kind: "open",
          label: "Open Run",
          enabled:
            run.externalRunId !== null &&
            execution?.capabilities.open === true,
          ...((run.externalRunId === null ||
            execution?.capabilities.open !== true) && {
            disabledReason:
              run.externalRunId === null
                ? "This run has no external harness identity to open."
                : "Opening this execution is unsupported.",
          }),
        },
      },
    };
  }

  private scheduleDetailViewFor(
    schedule: Schedule,
    previousRuns: RunHistoryEntry[],
    localSchedulingEnabled: boolean,
  ): ScheduleDetailView {
    return {
      schedule,
      runInstructions: {
        value: schedule.runInstructions,
        editable: true,
        scheduleRevision: schedule.revision,
      },
      overview: {
        status: schedule.status,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
        lastRunAt: schedule.lastRunAt,
        targetContext: schedule.targetContext,
        cadence: schedule.cadence,
        harnessMode: schedule.harnessMode,
        model: schedule.model,
        approvalMode: schedule.approvalMode,
        runCounter: this.runCounterViewFor(schedule),
      },
      actions: this.scheduleActionsFor(schedule, previousRuns),
      previousRuns: previousRuns.map((run) => this.previousRunViewFor(run)),
      runCounter: schedule.runCounter,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      notificationState: {
        runOutcomes: "quiet-in-app",
        desktopNotifications: "off",
      },
      localScheduling: this.localSchedulingViewFor(localSchedulingEnabled),
      harnessAvailability: this.harnessAvailabilityViewFor(schedule),
    };
  }

  async scanDueWork(): Promise<DueWorkScanResult> {
    const scannedAt = this.nowIso();
    await this.reconcileAbandonedRuns(scannedAt);
    const localSchedulingState = await this.getLocalSchedulingSetupState();
    if (!localSchedulingState.enabled) {
      return {
        startedRunIds: [],
        diagnostics: this.dueWorkScanDiagnosticsFor({
          scannedAt,
          localSchedulingEnabled: false,
          localSchedulingState,
          dueScheduleCount: 0,
          runs: [],
        }),
      };
    }

    const dueSchedules = await this.store.listDueSchedules(scannedAt);
    const startedRunIds: string[] = [];
    const runs: RunHistoryEntry[] = [];

    for (const schedule of dueSchedules) {
      const run = await this.startRun(schedule, "automatic");
      runs.push(run);
      if (isStartedRunStatus(run.status)) {
        startedRunIds.push(run.id);
      }
    }

    return {
      startedRunIds,
      diagnostics: this.dueWorkScanDiagnosticsFor({
        scannedAt,
        localSchedulingEnabled: true,
        localSchedulingState,
        dueScheduleCount: dueSchedules.length,
        runs,
      }),
    };
  }

  async startManualRun(scheduleId: string): Promise<RunHistoryEntry> {
    const schedule = await this.requireSchedule(scheduleId);
    if (schedule.status !== "draft" && !schedule.enabled) {
      throw new Error(
        "Manual Run Now is only available for draft or enabled schedules.",
      );
    }
    const trigger: RunTrigger =
      schedule.status === "draft" ? "draft-manual" : "manual";

    const reservationKeys = this.manualRunReservationKeysFor(schedule);
    if (this.hasManualRunReservation(reservationKeys)) {
      return this.blockManualRunForReservedSlot(schedule, trigger);
    }

    this.reserveManualRun(reservationKeys);
    try {
      return await this.startRun(schedule, trigger);
    } finally {
      this.releaseManualRunReservation(reservationKeys);
    }
  }

  async resolveActiveRun(
    runId: string,
    input: ResolveActiveRunInput,
  ): Promise<RunHistoryEntry> {
    const run = await this.store.getRunHistoryEntry(runId);
    if (!run) {
      throw new Error(`Run '${runId}' was not found.`);
    }
    if (!isActiveRunStatus(run.status) || run.completedAt !== null) {
      throw new Error("Only active runs can be resolved.");
    }

    const schedule = await this.requireSchedule(run.scheduleId);
    const completedAt = input.completedAt ?? this.nowIso();
    const resolvedRun: RunHistoryEntry = {
      ...run,
      status: input.status,
      completedAt,
      summary: input.summary ?? run.summary,
      error: input.error ?? (input.status === "failed" ? "Run failed." : null),
    };

    await this.persistRunResult(schedule, resolvedRun, run.trigger);
    return resolvedRun;
  }

  async pollRunStatus(runId: string): Promise<RunHistoryEntry> {
    const run = await this.requireRun(runId);
    this.requireHarnessBackedActiveRun(run, "polled for status");
    const { schedule, harness, externalRunId } =
      await this.requireHarnessForRun(run);
    const requestedAt = this.nowIso();
    const statusResult = await harness.status({
      schedule,
      run,
      externalRunId,
      requestedAt,
    });
    const updatedRun = this.applyHarnessRunUpdate(
      run,
      statusResult,
      requestedAt,
    );

    await this.persistRunResult(schedule, updatedRun, run.trigger);
    return updatedRun;
  }

  async cancelRun(runId: string): Promise<RunHistoryEntry> {
    const run = await this.requireRun(runId);
    this.requireHarnessBackedActiveRun(run, "canceled");
    const { schedule, harness, externalRunId } =
      await this.requireHarnessForRun(run);
    const execution = await this.store.getLocalRunExecution(run.id);
    if (
      !execution ||
      execution.ownerId !== this.executionOwnerId ||
      !execution.capabilities.cancel
    ) {
      throw new Error(
        "Cancellation is unsupported from this process or execution type.",
      );
    }
    const requestedAt = this.nowIso();
    if (
      !(await this.store.requestLocalRunCancellation(
        run.id,
        this.executionOwnerId,
        requestedAt,
      ))
    ) {
      throw new Error(
        "Cancellation is already pending or no longer supported for this run.",
      );
    }
    const cancelResult = await harness.cancel({
      schedule,
      run,
      externalRunId,
      requestedAt,
      executionIdentity: execution.identity,
    });
    const canceledRun = this.applyHarnessRunUpdate(
      run,
      cancelResult,
      requestedAt,
    );

    await this.persistRunResult(schedule, canceledRun, run.trigger);
    return canceledRun;
  }

  async openRun(runId: string): Promise<HarnessOpenResult> {
    return this.openHarnessRun(runId, "open");
  }

  async reviewRun(runId: string): Promise<HarnessOpenResult> {
    return this.openHarnessRun(runId, "review");
  }

  private async startRun(
    schedule: Schedule,
    trigger: RunTrigger,
  ): Promise<RunHistoryEntry> {
    const requestedAt = this.nowIso();
    const missingRunRequirements =
      this.scheduleDefinition.missingActivationRequirements(schedule);
    if (missingRunRequirements.length > 0) {
      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error: missingRunRequirements.join(" "),
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    if (
      trigger !== "draft-manual" &&
      hasReachedRunCap(schedule.runCounter)
    ) {
      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error:
          "Run cap has been reached. Restart the completed schedule before running again.",
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    const harnessMode = schedule.harnessMode;
    const harness = harnessMode ? this.harnesses.get(harnessMode) : undefined;

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
        error: harnessMode
          ? `Harness mode '${harnessMode}' is unavailable.`
          : "Harness mode is required before activation.",
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    const existingOccupyingRun = await this.findOccupyingRun(schedule);
    if (existingOccupyingRun) {
      const reason =
        "Run slot is occupied by an active run. AgentScheduler deferred this due run and will coalesce catch-up work for the schedule.";

      if (trigger === "automatic") {
        return this.deferRun(schedule, trigger, requestedAt, reason);
      }

      if (existingOccupyingRun.scheduleId === schedule.id) {
        return existingOccupyingRun;
      }

      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error:
          "Run slot is occupied by an active run. Wait for the active run to finish before starting a manual run.",
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    const pendingDeferredRun = await this.store.getPendingDeferredRun(schedule.id);
    const localSchedulingEnabled = await this.isLocalSchedulingEnabled();
    const preflight = await harness.preflight({
      schedule,
      trigger,
      requestedAt,
      localSchedulingEnabled,
    });

    if (preflight.status === "deferred" && pendingDeferredRun) {
      return pendingDeferredRun;
    }

    const startingRun = this.buildRunHistoryEntry({
      schedule,
      trigger,
      startedAt: requestedAt,
      completedAt: null,
      status: "running",
      resolvedHarnessPolicy:
        preflight.resolvedHarnessPolicy ?? this.defaultPolicySnapshot(schedule),
      externalRunId: null,
      summary: "Run is starting.",
      error: null,
    });
    const reservation = await this.store.reserveActiveRun(startingRun);
    if (!reservation.reserved) {
      const reason =
        "Run slot is occupied by an active run. AgentScheduler deferred this due run and will coalesce catch-up work for the schedule.";

      if (trigger === "automatic") {
        return this.deferRun(schedule, trigger, requestedAt, reason);
      }

      if (reservation.occupyingRun.scheduleId === schedule.id) {
        return reservation.occupyingRun;
      }

      const blockedRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: requestedAt,
        status: "blocked",
        resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error:
          "Run slot is occupied by an active run. Wait for the active run to finish before starting a manual run.",
      });
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    if (preflight.status === "blocked") {
      await this.completePendingDeferredRun(
        pendingDeferredRun,
        requestedAt,
        "Deferred run ended with a blocked catch-up attempt.",
      );
      const blockedRun = {
        ...startingRun,
        completedAt: requestedAt,
        status: "blocked" as const,
        resolvedHarnessPolicy:
          preflight.resolvedHarnessPolicy ?? this.defaultPolicySnapshot(schedule),
        externalRunId: null,
        summary: null,
        error: preflight.reason,
      };
      await this.persistRunResult(schedule, blockedRun, trigger);
      return blockedRun;
    }

    if (preflight.status === "deferred") {
      const deferredRun = {
        ...startingRun,
        status: "deferred" as const,
        completedAt: null,
        resolvedHarnessPolicy:
          preflight.resolvedHarnessPolicy ?? this.defaultPolicySnapshot(schedule),
        summary: null,
        error: preflight.reason,
      };
      await this.store.saveRunHistory(deferredRun);
      return deferredRun;
    }

    if (preflight.status === "requires-approval") {
      await this.completePendingDeferredRun(pendingDeferredRun, requestedAt);
      const approvalWaitingRun = {
        ...startingRun,
        status: "approval-waiting" as const,
        completedAt: null,
        resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
        summary: preflight.reason,
        error: null,
      };
      await this.persistRunResult(schedule, approvalWaitingRun, trigger);
      return approvalWaitingRun;
    }

    await this.completePendingDeferredRun(pendingDeferredRun, requestedAt);
    await this.store.saveRunHistory({
      ...startingRun,
      resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
    });
    let startResult: HarnessStartResult;
    const executionIdentity = `execution:${randomUUID()}`;
    try {
      startResult = await harness.start(
        {
          schedule,
          trigger,
          requestedAt,
          runInstructions: schedule.runInstructions,
          resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
          executionIdentity,
        },
        {
          started: (execution) =>
            this.recordExecutionStarted(
              startingRun,
              executionIdentity,
              execution,
            ),
          heartbeat: () => this.recordExecutionHeartbeat(startingRun.id),
        },
      );
    } catch (error) {
      await this.persistRunResult(
        schedule,
        {
          ...startingRun,
          completedAt: this.nowIso(),
          status: "failed",
          resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
          summary: null,
          error: errorMessageFromUnknown(error),
        },
        trigger,
      );
      throw error;
    }
    const run = {
      ...startingRun,
      completedAt: startResult.completedAt,
      status: startResult.status,
      resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
      externalRunId: startResult.externalRunId,
      summary: startResult.summary,
      error: null,
      executedModel: startResult.executedModel ?? null,
    };

    await this.persistRunResult(schedule, run, trigger);
    return (await this.store.getRunHistoryEntry(run.id)) ?? run;
  }

  private async recordExecutionStarted(
    run: RunHistoryEntry,
    executionIdentity: string,
    execution: LocalRunExecutionStarted,
  ): Promise<void> {
    const now = this.nowIso();
    await this.store.saveLocalRunExecution({
      runId: run.id,
      identity: executionIdentity,
      ownerId: this.executionOwnerId,
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: leaseExpiry(
        now,
        execution.capabilities.heartbeat === false
          ? NON_HEARTBEATING_RUN_LEASE_MS
          : undefined,
      ),
      capabilities: execution.capabilities,
      handle: execution.identity,
      recoveryClaimedAt: null,
      cancellationRequestedAt: null,
    });
    await this.store.saveRunHistory({
      ...run,
      externalRunId: executionIdentity,
      summary: "Local run execution started.",
    });
  }

  private async recordExecutionHeartbeat(runId: string): Promise<void> {
    const now = this.nowIso();
    await this.store.heartbeatLocalRunExecution(
      runId,
      this.executionOwnerId,
      now,
      leaseExpiry(now),
    );
  }

  private async reconcileAbandonedRuns(now: IsoTimestamp): Promise<void> {
    for (const run of await this.store.listActiveRuns()) {
      const execution = await this.store.getLocalRunExecution(run.id);
      const legacyExpired =
        !execution &&
        new Date(run.startedAt).getTime() + LEGACY_ACTIVE_RUN_GRACE_MS <=
          new Date(now).getTime();
      if (!legacyExpired && (!execution || !isExecutionLeaseExpired(execution, now))) {
        continue;
      }
      if (
        !(await this.store.claimExpiredExecution({
          runId: run.id,
          observedHeartbeatAt: execution?.heartbeatAt ?? null,
          observedLeaseExpiresAt: execution?.leaseExpiresAt ?? null,
          claimedAt: now,
        }))
      ) {
        continue;
      }
      const schedule = await this.requireSchedule(run.scheduleId);
      await this.persistRunResult(
        schedule,
        {
          ...run,
          status: "failed",
          completedAt: now,
          summary: null,
          error: execution
            ? `Local run execution '${execution.identity}' stopped heartbeating and its lease expired. AgentScheduler recovered the abandoned Run Slot.`
            : "Legacy active run has no recoverable execution identity and exceeded the recovery grace period. AgentScheduler recovered the abandoned Run Slot.",
        },
        run.trigger,
      );
    }
  }

  private async openHarnessRun(
    runId: string,
    purpose: HarnessOpenPurpose,
  ): Promise<HarnessOpenResult> {
    const run = await this.requireRun(runId);
    const { schedule, harness, externalRunId } =
      await this.requireHarnessForRun(run);

    return harness.open({
      schedule,
      run,
      externalRunId,
      purpose,
      requestedAt: this.nowIso(),
    });
  }

  private async requireRun(runId: string): Promise<RunHistoryEntry> {
    const run = await this.store.getRunHistoryEntry(runId);
    if (!run) {
      throw new Error(`Run '${runId}' was not found.`);
    }
    return run;
  }

  private requireHarnessBackedActiveRun(
    run: RunHistoryEntry,
    action: string,
  ): void {
    if (!isActiveRunStatus(run.status) || run.completedAt !== null) {
      throw new Error(`Only active runs can be ${action}.`);
    }
    if (!run.externalRunId) {
      throw new Error(
        `Only runs with an external harness id can be ${action}.`,
      );
    }
  }

  private async requireHarnessForRun(run: RunHistoryEntry): Promise<{
    schedule: Schedule;
    harness: AgentHarness;
    externalRunId: string;
  }> {
    if (!run.externalRunId) {
      throw new Error("Run does not have an external harness id.");
    }

    const schedule = await this.requireSchedule(run.scheduleId);
    const harnessMode = run.harnessMode ?? schedule.harnessMode;
    const harness = harnessMode ? this.harnesses.get(harnessMode) : undefined;

    if (!harness) {
      throw new Error(
        harnessMode
          ? `Harness mode '${harnessMode}' is unavailable.`
          : "Harness mode is required before opening a run.",
      );
    }

    return {
      schedule,
      harness,
      externalRunId: run.externalRunId,
    };
  }

  private applyHarnessRunUpdate(
    run: RunHistoryEntry,
    update: HarnessStatusResult | HarnessCancelResult,
    requestedAt: IsoTimestamp,
  ): RunHistoryEntry {
    return {
      ...run,
      status: update.status,
      completedAt: isActiveRunStatus(update.status)
        ? null
        : update.completedAt ?? requestedAt,
      summary: update.summary,
      error: update.error,
      executedModel: update.executedModel ?? run.executedModel,
    };
  }

  private async findOccupyingRun(
    schedule: Schedule,
  ): Promise<RunHistoryEntry | undefined> {
    const runSlotKey = this.runSlotKeyFor(schedule);
    if (!runSlotKey) {
      return undefined;
    }

    const activeRuns = await this.store.listActiveRuns();
    return activeRuns.find(
      (run) => this.runSlotKeyFor(run) === runSlotKey,
    );
  }

  private async deferRun(
    schedule: Schedule,
    trigger: RunTrigger,
    requestedAt: IsoTimestamp,
    reason: string,
    resolvedHarnessPolicy: ResolvedHarnessPolicy = this.defaultPolicySnapshot(
      schedule,
    ),
  ): Promise<RunHistoryEntry> {
    const existingDeferredRun = await this.store.getPendingDeferredRun(
      schedule.id,
    );
    if (existingDeferredRun) {
      return existingDeferredRun;
    }

    const deferredRun = this.buildRunHistoryEntry({
      schedule,
      trigger,
      startedAt: requestedAt,
      completedAt: null,
      status: "deferred",
      resolvedHarnessPolicy,
      externalRunId: null,
      summary: null,
      error: reason,
    });
    await this.store.saveRunHistory(deferredRun);
    return deferredRun;
  }

  private async completePendingDeferredRun(
    pendingDeferredRun: RunHistoryEntry | undefined,
    completedAt: IsoTimestamp,
    summary = "Deferred run resumed as a catch-up run.",
  ): Promise<void> {
    if (!pendingDeferredRun) {
      return;
    }

    await this.store.saveRunHistory({
      ...pendingDeferredRun,
      completedAt,
      summary,
    });
  }

  private runSlotKeyFor(
    input: Pick<Schedule | RunHistoryEntry, "targetContext" | "harnessMode">,
  ): string | null {
    if (!input.targetContext || !input.harnessMode) {
      return null;
    }

    return `${input.harnessMode}:${input.targetContext.type}:${input.targetContext.uri}`;
  }

  private manualRunReservationKeysFor(schedule: Schedule): string[] {
    const keys = [`schedule:${schedule.id}`];
    const runSlotKey = this.runSlotKeyFor(schedule);
    if (runSlotKey) {
      keys.push(`slot:${runSlotKey}`);
    }
    return keys;
  }

  private hasManualRunReservation(keys: readonly string[]): boolean {
    return keys.some((key) => this.manualRunReservations.has(key));
  }

  private reserveManualRun(keys: readonly string[]): void {
    for (const key of keys) {
      this.manualRunReservations.add(key);
    }
  }

  private releaseManualRunReservation(keys: readonly string[]): void {
    for (const key of keys) {
      this.manualRunReservations.delete(key);
    }
  }

  private async blockManualRunForReservedSlot(
    schedule: Schedule,
    trigger: RunTrigger,
  ): Promise<RunHistoryEntry> {
    const occupyingRun = await this.findOccupyingRun(schedule);
    if (occupyingRun?.scheduleId === schedule.id) {
      return occupyingRun;
    }

    const requestedAt = this.nowIso();
    const blockedRun = this.buildRunHistoryEntry({
      schedule,
      trigger,
      startedAt: requestedAt,
      completedAt: requestedAt,
      status: "blocked",
      resolvedHarnessPolicy: this.defaultPolicySnapshot(schedule),
      externalRunId: null,
      summary: null,
      error:
        "Run slot is occupied by an active run. Wait for the active run to finish before starting a manual run.",
    });
    await this.persistRunResult(schedule, blockedRun, trigger);
    return blockedRun;
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
    executedModel?: string | null;
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
      executedModel: input.executedModel ?? null,
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const currentSchedule = await this.requireSchedule(schedule.id);
      const pendingDeferredRun =
        trigger === "automatic" && run.status === "completed"
          ? await this.store.getPendingDeferredRun(currentSchedule.id)
          : undefined;

      const reduction = reduceRecurrenceAfterRun({
        schedule: currentSchedule,
        run,
        trigger,
        now: this.clock.now(),
        hasPendingDeferredRun: pendingDeferredRun !== undefined,
      });
      const commit = await this.store.commitRunResult(
        run,
        reduction.transition,
      );
      if (!commit.committed) {
        continue;
      }
      if (!commit.applied) {
        return;
      }

      if (
        pendingDeferredRun &&
        reduction.reachedRunCap
      ) {
        await this.completePendingDeferredRun(
          pendingDeferredRun,
          reduction.completedAt,
          "Deferred run ended because the schedule completed before catch-up work started.",
        );
      }
      return;
    }

    throw new Error(
      `Schedule '${schedule.id}' changed repeatedly while AgentScheduler was saving Run History. Retry after schedule edits settle.`,
    );
  }

  private runCounterViewFor(schedule: Schedule): {
    completed: number;
    limit: number | null;
    label: string;
  } {
    return {
      ...schedule.runCounter,
      label:
        schedule.runCounter.limit === null
          ? String(schedule.runCounter.completed)
          : `${schedule.runCounter.completed}/${schedule.runCounter.limit}`,
    };
  }

  private scheduleActionsFor(
    schedule: Schedule,
    previousRuns: RunHistoryEntry[] = [],
  ): ScheduleDetailView["actions"] {
    const runNowStatusEnabled = schedule.status === "draft" || schedule.enabled;
    const harnessUnavailableReason = this.selectedHarnessUnavailableReason(schedule);
    const runNowEnabled = runNowStatusEnabled && !harnessUnavailableReason;
    const activeRunBlocksDeletion = previousRuns.some(
      (run) => isActiveRunStatus(run.status) && run.completedAt === null,
    );
    return {
      activate: {
        kind: "activate",
        label: "Activate Schedule",
        enabled: schedule.status === "draft" && !harnessUnavailableReason,
        ...(schedule.status !== "draft" && {
          disabledReason: "Only draft schedules can be activated.",
        }),
        ...(schedule.status === "draft" &&
          harnessUnavailableReason && {
            disabledReason: harnessUnavailableReason,
          }),
      },
      runNow: {
        kind: "run-now",
        label: "Run Now",
        enabled: runNowEnabled,
        ...(!runNowStatusEnabled && {
          disabledReason:
            "Manual Run Now is only available for draft or enabled schedules.",
        }),
        ...(runNowStatusEnabled &&
          harnessUnavailableReason && {
            disabledReason: harnessUnavailableReason,
          }),
      },
      pause: {
        kind: "pause",
        label: "Pause",
        enabled: schedule.status === "active",
        ...(schedule.status !== "active" && {
          disabledReason: "Only active schedules can be paused.",
        }),
      },
      resume: {
        kind: "resume",
        label: "Resume",
        enabled: schedule.status === "paused",
        ...(schedule.status !== "paused" && {
          disabledReason: "Only paused schedules can be resumed.",
        }),
      },
      restart: {
        kind: "restart",
        label: "Restart",
        enabled: schedule.status === "completed",
        ...(schedule.status !== "completed" && {
          disabledReason: "Only completed schedules can be restarted.",
        }),
      },
      delete: {
        kind: "delete",
        label: "Delete Schedule",
        enabled: !activeRunBlocksDeletion,
        ...(activeRunBlocksDeletion && {
          disabledReason:
            "Resolve or cancel the active run before deleting this schedule.",
        }),
      },
    };
  }

  private previousRunViewFor(
    run: RunHistoryEntry,
  ): ScheduleDetailPreviousRun {
    return {
      ...run,
      outcome: this.runOutcomeViewFor(run),
      historyDetailLink: {
        runId: run.id,
        view: "run-history-detail",
      },
    };
  }

  private runOutcomeViewFor(run: RunHistoryEntry): RunOutcomeView {
    return {
      status: run.status,
      completedAt: run.completedAt,
      summary: run.summary,
      error: run.error,
      description: this.runOutcomeDescriptionFor(run),
    };
  }

  private runOutcomeDescriptionFor(run: RunHistoryEntry): string {
    const detail = run.error ?? run.summary;

    switch (run.status) {
      case "blocked":
        return `Blocked: ${detail ?? "AgentScheduler blocked this run before it started."}`;
      case "approval-waiting":
        return `Approval needed: ${detail ?? "Open the approval surface to continue this run."}`;
      case "deferred":
        return `Deferred: ${detail ?? "AgentScheduler deferred this run and will coalesce catch-up work."}`;
      case "failed":
        return `Failed: ${detail ?? "The harness reported that this run failed."}`;
      case "completed":
        return detail ?? "Run completed.";
      case "running":
        return detail ?? "Run is running.";
      case "canceled":
        return detail ?? "Run was canceled.";
    }
  }

  private localSchedulingViewFor(
    enabled: boolean,
  ): ScheduleDetailView["localScheduling"] {
    return {
      enabled,
      automaticRuns: enabled ? "active" : "inactive",
      message: enabled
        ? "Automatic runs are active because local scheduling setup is enabled."
        : "Automatic runs are inactive until local scheduling setup is enabled. Manual Run Now can still run from the editor when the harness is available.",
    };
  }

  private harnessAvailabilityViewFor(
    schedule: Schedule,
  ): ScheduleDetailView["harnessAvailability"] {
    const modes = this.listHarnessModeAvailability();
    const selected = schedule.harnessMode
      ? this.harnessModeAvailabilityFor(schedule.harnessMode, schedule)
      : null;

    return {
      modes,
      selected,
      message: selected
        ? selected.available
          ? [
              `${selected.label} harness is available.`,
              selected.manualRunReady === false
                ? selected.manualRunReason
                : "Manual Run Now is ready in the editor.",
              selected.unattendedRunReady === false
                ? selected.unattendedRunReason
                : "Unattended policy is ready for automatic runs.",
              selected.readinessNote,
            ]
              .filter((message): message is string => Boolean(message))
              .join(" ")
          : selected.reason ?? unavailableHarnessModeMessage(selected.mode)
        : "Choose an available harness mode before activating or running this schedule.",
    };
  }

  private defaultPolicySnapshot(schedule: Schedule): ResolvedHarnessPolicy {
    return {
      harnessMode: schedule.harnessMode,
      approvalMode: schedule.approvalMode,
    };
  }

  private selectedHarnessUnavailableReason(schedule: Schedule): string | undefined {
    if (!schedule.harnessMode) {
      return "Choose an available harness mode before activating or running this schedule.";
    }

    const availability = this.harnessModeAvailabilityFor(
      schedule.harnessMode,
      schedule,
    );
    return availability.available
      ? undefined
      : availability.reason ?? unavailableHarnessModeMessage(schedule.harnessMode);
  }

  harnessModeAvailabilityFor(
    mode: HarnessMode,
    schedule?: Schedule,
  ): ScheduleHarnessModeAvailability {
    const harness = this.harnesses.get(mode);
    if (harness?.availability) {
      return harness.availability(schedule);
    }

    const available = !!harness;
    return {
      mode,
      label: HARNESS_MODE_LABELS[mode],
      available,
      ...(!available && { reason: unavailableHarnessModeMessage(mode) }),
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

  async isLocalSchedulingEnabled(): Promise<boolean> {
    if (this.localSchedulingSetup) {
      return this.localSchedulingSetup.isLocalSchedulingEnabled();
    }

    return this.localSchedulingEnabled;
  }

  private async getLocalSchedulingSetupState(): Promise<LocalSchedulingSetupState> {
    if (this.localSchedulingSetup?.getLocalSchedulingSetupState) {
      return this.localSchedulingSetup.getLocalSchedulingSetupState();
    }
    if (this.localSchedulingSetup) {
      return {
        ...defaultLocalSchedulingSetupState(),
        enabled: await this.localSchedulingSetup.isLocalSchedulingEnabled(),
      };
    }

    return {
      ...defaultLocalSchedulingSetupState(),
      enabled: this.localSchedulingEnabled,
    };
  }

  private dueWorkScanDiagnosticsFor(input: {
    scannedAt: IsoTimestamp;
    localSchedulingEnabled: boolean;
    localSchedulingState: LocalSchedulingSetupState;
    dueScheduleCount: number;
    runs: RunHistoryEntry[];
  }): DueWorkScanDiagnostics {
    const wakeupProviderConfigured =
      input.localSchedulingState.enabled &&
      input.localSchedulingState.platform !== null &&
      input.localSchedulingState.triggerId !== null;

    return {
      scannedAt: input.scannedAt,
      localScheduling: {
        enabled: input.localSchedulingEnabled,
        message: input.localSchedulingEnabled
          ? "Automatic runs are active because local scheduling setup is enabled."
          : "Automatic runs are inactive until local scheduling setup is enabled.",
      },
      wakeupProvider: {
        configured: wakeupProviderConfigured,
        platform: input.localSchedulingState.platform,
        triggerId: input.localSchedulingState.triggerId,
        status: wakeupProviderConfigured
          ? "installed"
          : input.localSchedulingState.enabled
            ? "unknown"
            : "not-installed",
      },
      dueScheduleCount: input.dueScheduleCount,
      outcomes: {
        started: input.runs.filter((run) => isStartedRunStatus(run.status)).length,
        completed: input.runs.filter((run) => run.status === "completed").length,
        blocked: input.runs.filter((run) => run.status === "blocked").length,
        deferred: input.runs.filter((run) => run.status === "deferred").length,
        approvalWaiting: input.runs.filter(
          (run) => run.status === "approval-waiting",
        ).length,
        failed: input.runs.filter((run) => run.status === "failed").length,
      },
    };
  }
}

function unavailableHarnessModeMessage(mode: HarnessMode): string {
  return `${HARNESS_MODE_LABELS[mode]} is unavailable in this VS Code environment because no ${HARNESS_MODE_LABELS[mode]} harness is registered. Install or enable the matching Copilot integration, or choose another available harness mode.`;
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error);
}
