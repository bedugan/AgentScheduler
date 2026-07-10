import { randomUUID } from "node:crypto";

import type {
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  DueWorkScanResult,
  ExportSchedulesInput,
  HarnessMode,
  ImportSchedulesOptions,
  IsoTimestamp,
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
} from "./domain.js";
import { ScheduleDefinition } from "./scheduleDefinition.js";
import { ScheduleFile } from "./scheduleFile.js";
import { RunCoordinator } from "./runCoordinator.js";
import type {
  AgentHarness,
  HarnessOpenResult,
} from "./harness.js";
import type { LocalSchedulingStateSource } from "./localSchedulingSetup.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";

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
  private readonly executionOwnerId: string;
  private readonly scheduleDefinition: ScheduleDefinition;
  private readonly scheduleFile: ScheduleFile;
  private readonly runCoordinator: RunCoordinator;

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
    this.runCoordinator = new RunCoordinator({
      store: this.store,
      harnesses: this.harnesses,
      clock: this.clock,
      idGenerator: this.idGenerator,
      scheduleDefinition: this.scheduleDefinition,
      executionOwnerId: this.executionOwnerId,
      localSchedulingEnabled: this.localSchedulingEnabled,
      ...(this.localSchedulingSetup && {
        localSchedulingSetup: this.localSchedulingSetup,
      }),
    });
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
    return this.runCoordinator.scanDueWork();
  }

  async startManualRun(scheduleId: string): Promise<RunHistoryEntry> {
    return this.runCoordinator.startManualRun(scheduleId);
  }

  async resolveActiveRun(
    runId: string,
    input: ResolveActiveRunInput,
  ): Promise<RunHistoryEntry> {
    return this.runCoordinator.resolveActiveRun(runId, input);
  }

  async pollRunStatus(runId: string): Promise<RunHistoryEntry> {
    return this.runCoordinator.pollRunStatus(runId);
  }

  async cancelRun(runId: string): Promise<RunHistoryEntry> {
    return this.runCoordinator.cancelRun(runId);
  }

  async openRun(runId: string): Promise<HarnessOpenResult> {
    return this.runCoordinator.openRun(runId);
  }

  async reviewRun(runId: string): Promise<HarnessOpenResult> {
    return this.runCoordinator.reviewRun(runId);
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

  private async requireRun(runId: string): Promise<RunHistoryEntry> {
    const run = await this.store.getRunHistoryEntry(runId);
    if (!run) {
      throw new Error(`Run '${runId}' was not found.`);
    }
    return run;
  }

  private nowIso(): IsoTimestamp {
    return this.clock.now().toISOString();
  }

  async isLocalSchedulingEnabled(): Promise<boolean> {
    return this.runCoordinator.isLocalSchedulingEnabled();
  }
}

function unavailableHarnessModeMessage(mode: HarnessMode): string {
  return `${HARNESS_MODE_LABELS[mode]} is unavailable in this VS Code environment because no ${HARNESS_MODE_LABELS[mode]} harness is registered. Install or enable the matching Copilot integration, or choose another available harness mode.`;
}
