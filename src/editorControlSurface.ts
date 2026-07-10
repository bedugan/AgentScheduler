import type {
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  RunHistoryDetailView,
  RunHistoryEntry,
  ScheduleHarnessModeAvailability,
  ScheduleDetailView,
  ScheduleSummary,
  UpdateScheduleInput,
  HarnessMode,
} from "./domain.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import type {
  LocalSchedulingSetup,
  LocalSchedulingSetupResult,
  WakeupTriggerIntent,
} from "./localSchedulingSetup.js";
import type { ScheduleLifecycle } from "./scheduleLifecycle.js";

export interface EditorControlSurfaceOptions {
  localSchedulingSetup?: LocalSchedulingSetup;
  enableLocalSchedulingUnavailableReason?: string;
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
    const automaticRuns = (await this.lifecycle.isLocalSchedulingEnabled())
      ? "active"
      : "inactive";

    return schedules.map((schedule) => ({
      id: schedule.id,
      status: schedule.status,
      enabled: schedule.enabled,
      automaticRuns,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      runCounter: schedule.runCounter,
      runInstructions: schedule.runInstructions,
      cadence: schedule.cadence,
      targetContext: schedule.targetContext,
      harnessMode: schedule.harnessMode,
      model: schedule.model,
      ...(schedule.agentProfile && { agentProfile: schedule.agentProfile }),
      approvalMode: schedule.approvalMode,
    }));
  }

  async listHarnessModeAvailability(): Promise<ScheduleHarnessModeAvailability[]> {
    await Promise.all(
      this.lifecycle
        .listHarnessModeAvailability()
        .map((availability) =>
          this.lifecycle.refreshHarnessModeAvailability(availability.mode),
        ),
    );
    return this.lifecycle.listHarnessModeAvailability();
  }

  async listHarnessModels(mode: HarnessMode): Promise<readonly ScheduleModelOption[]> {
    return this.lifecycle.listHarnessModels(mode);
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

  async cancelRun(runId: string): Promise<RunHistoryEntry> {
    return this.lifecycle.cancelRun(runId);
  }

  async openRun(runId: string): Promise<unknown> {
    return this.lifecycle.openRun(runId);
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

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.lifecycle.deleteSchedule(scheduleId);
  }

  async enableLocalScheduling(): Promise<LocalSchedulingSetupResult> {
    if (this.options.enableLocalSchedulingUnavailableReason) {
      throw new Error(this.options.enableLocalSchedulingUnavailableReason);
    }
    if (!this.options.localSchedulingSetup) {
      throw new Error("Local scheduling setup is not configured.");
    }
    if (!this.options.confirmEnableLocalScheduling) {
      throw new Error(
        "Enable local scheduling requires an explicit confirmation callback.",
      );
    }

    const intent = this.previewEnableLocalScheduling();
    const confirmed = await this.options.confirmEnableLocalScheduling(intent);
    if (!confirmed) {
      throw new Error("Enable local scheduling was not confirmed.");
    }

    return this.options.localSchedulingSetup.install();
  }

  previewEnableLocalScheduling(): WakeupTriggerIntent {
    return this.requireLocalSchedulingSetup().installIntent();
  }

  async verifyLocalScheduling(): Promise<LocalSchedulingSetupResult> {
    return this.requireLocalSchedulingSetup().verify();
  }

  async disableLocalScheduling(): Promise<LocalSchedulingSetupResult> {
    return this.requireLocalSchedulingSetup().uninstall();
  }

  private requireLocalSchedulingSetup(): LocalSchedulingSetup {
    if (!this.options.localSchedulingSetup) {
      throw new Error("Local scheduling setup is not configured.");
    }
    return this.options.localSchedulingSetup;
  }
}
