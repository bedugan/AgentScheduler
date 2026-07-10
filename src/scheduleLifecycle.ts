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
  Schedule,
  ScheduleHarnessModeAvailability,
  ScheduleExportFile,
  ScheduleDetailView,
  ScheduleImportResult,
  UpdateScheduleInput,
} from "./domain.js";
import {
  HARNESS_MODE_LABELS,
  SUPPORTED_HARNESS_MODES,
} from "./domain.js";
import { ScheduleDefinition } from "./scheduleDefinition.js";
import { ScheduleFile } from "./scheduleFile.js";
import { ScheduleProjection } from "./scheduleProjection.js";
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
  private readonly harnesses: Map<string, AgentHarness>;
  private readonly scheduleDefinition: ScheduleDefinition;
  private readonly scheduleFile: ScheduleFile;
  private readonly runCoordinator: RunCoordinator;
  private readonly scheduleProjection: ScheduleProjection;

  constructor(options: ScheduleLifecycleOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    const idGenerator = options.idGenerator ?? new RandomIdGenerator();
    const executionOwnerId =
      options.executionOwnerId ?? `process:${process.pid}:${randomUUID()}`;
    this.harnesses = new Map(
      options.harnesses.map((harness) => [harness.mode, harness]),
    );
    this.scheduleProjection = new ScheduleProjection(
      executionOwnerId,
      () => this.listHarnessModeAvailability(),
      (mode, schedule) => this.harnessModeAvailabilityFor(mode, schedule),
    );
    this.scheduleDefinition = new ScheduleDefinition(
      idGenerator,
      (schedule) =>
        this.scheduleProjection.selectedHarnessUnavailableReason(schedule),
    );
    this.scheduleFile = new ScheduleFile(idGenerator, (mode) =>
      this.harnesses.has(mode),
    );
    this.runCoordinator = new RunCoordinator({
      store: this.store,
      harnesses: this.harnesses,
      clock: this.clock,
      idGenerator,
      scheduleDefinition: this.scheduleDefinition,
      executionOwnerId,
      localSchedulingEnabled: options.localSchedulingEnabled ?? false,
      ...(options.localSchedulingSetup && {
        localSchedulingSetup: options.localSchedulingSetup,
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
    if (!(await this.store.createSchedule(schedule))) {
      throw new Error(`Schedule '${schedule.id}' already exists.`);
    }
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
    await this.createImportedSchedules(result);
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
    await this.createImportedSchedules(result);
    return result;
  }

  async activateSchedule(scheduleId: string): Promise<Schedule> {
    return this.applyScheduleDefinitionChange(
      scheduleId,
      (schedule) =>
        this.scheduleDefinition.transition(
          schedule,
          "activate",
          this.clock.now(),
        ),
    );
  }

  async pauseSchedule(scheduleId: string): Promise<Schedule> {
    return this.applyScheduleDefinitionChange(
      scheduleId,
      (schedule) =>
        this.scheduleDefinition.transition(schedule, "pause", this.clock.now()),
    );
  }

  async resumeSchedule(scheduleId: string): Promise<Schedule> {
    return this.applyScheduleDefinitionChange(
      scheduleId,
      (schedule) =>
        this.scheduleDefinition.transition(schedule, "resume", this.clock.now()),
    );
  }

  async restartCompletedSchedule(scheduleId: string): Promise<Schedule> {
    return this.applyScheduleDefinitionChange(
      scheduleId,
      (schedule) =>
        this.scheduleDefinition.transition(
          schedule,
          "restart",
          this.clock.now(),
        ),
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const result = await this.store.deleteScheduleIfIdle(scheduleId);
    if (result === "active-run") {
      throw new Error(
        "Schedule cannot be deleted while it has a running or approval-waiting run. Cancel or resolve the active run before deleting the schedule.",
      );
    }
    if (result === "not-found") {
      throw new Error(`Schedule '${scheduleId}' was not found.`);
    }
  }

  async updateSchedule(
    scheduleId: string,
    input: UpdateScheduleInput,
  ): Promise<Schedule> {
    return this.applyScheduleDefinitionChange(
      scheduleId,
      (schedule) =>
        this.scheduleDefinition.update(schedule, input, this.clock.now()),
    );
  }

  async openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView> {
    const schedule = await this.requireSchedule(scheduleId);
    if (schedule.harnessMode) {
      await this.refreshHarnessModeAvailability(schedule.harnessMode, schedule);
    }
    const previousRuns = await this.store.listRunHistory(scheduleId);
    const localSchedulingEnabled = await this.isLocalSchedulingEnabled();

    return this.scheduleProjection.scheduleDetail(
      schedule,
      previousRuns,
      localSchedulingEnabled,
    );
  }

  async openRunHistoryDetail(runId: string): Promise<RunHistoryDetailView> {
    const run = await this.requireRun(runId);
    const execution = await this.store.getLocalRunExecution(run.id);
    return this.scheduleProjection.runHistoryDetail(run, execution);
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

  private async createImportedSchedules(
    result: ScheduleImportResult,
  ): Promise<void> {
    for (const schedule of result.schedules) {
      if (!(await this.store.createSchedule(schedule))) {
        throw new Error(
          `Imported schedule id '${schedule.id}' already exists. No existing schedule was overwritten.`,
        );
      }
    }
  }

  private async applyScheduleDefinitionChange(
    scheduleId: string,
    change: (schedule: Schedule) => Schedule,
  ): Promise<Schedule> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.requireSchedule(scheduleId);
      const next = change(current);
      if (next === current) {
        return current;
      }
      if (await this.store.compareAndSaveSchedule(current, next)) {
        return next;
      }
    }
    throw new Error(
      `Schedule '${scheduleId}' changed repeatedly while AgentScheduler was saving its definition. Retry after concurrent changes settle.`,
    );
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
