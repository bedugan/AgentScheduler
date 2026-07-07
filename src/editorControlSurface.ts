import type { ScheduleDetailView, ScheduleSummary } from "./domain.js";
import type { ScheduleLifecycle } from "./scheduleLifecycle.js";

export class EditorControlSurface {
  constructor(private readonly lifecycle: ScheduleLifecycle) {}

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
}
