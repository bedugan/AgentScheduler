import type {
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  RunHistoryDetailView,
  RunHistoryEntry,
  ScheduleDetailView,
  ScheduleSummary,
  UpdateScheduleInput,
} from "./domain.js";
import type {
  LocalSchedulingSetup,
  LocalSchedulingSetupResult,
  WakeupTriggerIntent,
} from "./localSchedulingSetup.js";
import type { ScheduleLifecycle } from "./scheduleLifecycle.js";

export interface EditorControlSurfaceOptions {
  localSchedulingSetup?: LocalSchedulingSetup;
  confirmEnableLocalScheduling?: (
    intent: WakeupTriggerIntent,
  ) => Promise<boolean>;
}

export class EditorControlSurface {
  constructor(
    private readonly lifecycle: ScheduleLifecycle,
    private readonly options: EditorControlSurfaceOptions = {},
  ) {}

  async listSchedules(): Promise<ScheduleSummary[]> {
    const schedules = await this.lifecycle.listSchedules();

    return schedules.map((schedule) => ({
      id: schedule.id,
      status: schedule.status,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      runCounter: schedule.runCounter,
      runInstructions: schedule.runInstructions,
      cadence: schedule.cadence,
      targetContext: schedule.targetContext,
      harnessMode: schedule.harnessMode,
      model: schedule.model,
      approvalMode: schedule.approvalMode,
    }));
  }

  async openScheduleDetail(scheduleId: string): Promise<ScheduleDetailView> {
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async createDraftSchedule(
    input: CreateDraftScheduleInput,
  ): Promise<ScheduleDetailView> {
    const schedule = await this.lifecycle.createDraftSchedule(input);
    return this.lifecycle.openScheduleDetail(schedule.id);
  }

  async createActiveSchedule(
    input: CreateActiveScheduleInput,
  ): Promise<ScheduleDetailView> {
    const schedule = await this.lifecycle.createActiveSchedule(input);
    return this.lifecycle.openScheduleDetail(schedule.id);
  }

  async openRunHistoryDetail(runId: string): Promise<RunHistoryDetailView> {
    return this.lifecycle.openRunHistoryDetail(runId);
  }

  async saveScheduleDetailEdits(
    scheduleId: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleDetailView> {
    await this.lifecycle.updateSchedule(scheduleId, input);
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async runScheduleNow(scheduleId: string): Promise<RunHistoryEntry> {
    return this.lifecycle.startManualRun(scheduleId);
  }

  async activateSchedule(scheduleId: string): Promise<ScheduleDetailView> {
    await this.lifecycle.activateSchedule(scheduleId);
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async pauseSchedule(scheduleId: string): Promise<ScheduleDetailView> {
    await this.lifecycle.pauseSchedule(scheduleId);
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async resumeSchedule(scheduleId: string): Promise<ScheduleDetailView> {
    await this.lifecycle.resumeSchedule(scheduleId);
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async restartCompletedSchedule(
    scheduleId: string,
  ): Promise<ScheduleDetailView> {
    await this.lifecycle.restartCompletedSchedule(scheduleId);
    return this.lifecycle.openScheduleDetail(scheduleId);
  }

  async enableLocalScheduling(): Promise<LocalSchedulingSetupResult> {
    if (!this.options.localSchedulingSetup) {
      throw new Error("Local scheduling setup is not configured.");
    }
    if (!this.options.confirmEnableLocalScheduling) {
      throw new Error(
        "Enable local scheduling requires an explicit confirmation callback.",
      );
    }

    const intent = this.options.localSchedulingSetup.installIntent();
    const confirmed = await this.options.confirmEnableLocalScheduling(intent);
    if (!confirmed) {
      throw new Error("Enable local scheduling was not confirmed.");
    }

    return this.options.localSchedulingSetup.install();
  }
}
