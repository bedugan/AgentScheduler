import type {
  RunHistoryEntry,
  RunTrigger,
  Schedule,
} from "./domain.js";
import { isActiveRunStatus } from "./domain.js";
import { nextRunAtAfter } from "./recurrencePolicy.js";
import type { ScheduleOperationalTransition } from "./store.js";

export interface RecurrenceReduction {
  transition: ScheduleOperationalTransition;
  completedAt: string;
  reachedRunCap: boolean;
}

export function hasReachedRunCap(runCounter: Schedule["runCounter"]): boolean {
  return runCounter.limit !== null && runCounter.completed >= runCounter.limit;
}

export function reduceRecurrenceAfterRun(input: {
  schedule: Schedule;
  run: RunHistoryEntry;
  trigger: RunTrigger;
  now: Date;
  hasPendingDeferredRun: boolean;
}): RecurrenceReduction {
  const { schedule, run, trigger } = input;
  const completedAt = run.completedAt ?? run.startedAt;
  const recurrenceAnchor = new Date(
    Math.max(new Date(completedAt).getTime(), input.now.getTime()),
  );
  const runCounter = { ...schedule.runCounter };
  let status = schedule.status;
  let enabled = schedule.enabled;
  let nextRunAt = schedule.nextRunAt;

  if (isActiveRunStatus(run.status)) {
    if (trigger === "automatic" && schedule.cadence) {
      nextRunAt = nextRunAtAfter(schedule.cadence, new Date(run.startedAt));
    }
  } else if (trigger !== "draft-manual" && run.status === "completed") {
    runCounter.completed += 1;
  }

  const reachedRunCap = hasReachedRunCap(runCounter);
  if (!isActiveRunStatus(run.status)) {
    if (reachedRunCap) {
      status = "completed";
      enabled = false;
      nextRunAt = null;
    } else if (
      trigger === "automatic" &&
      run.status === "completed" &&
      schedule.cadence
    ) {
      nextRunAt = input.hasPendingDeferredRun
        ? schedule.nextRunAt
        : nextRunAtAfter(schedule.cadence, recurrenceAnchor);
    } else if (
      trigger === "automatic" &&
      schedule.status === "active" &&
      schedule.enabled &&
      schedule.cadence
    ) {
      nextRunAt = nextRunAtAfter(schedule.cadence, recurrenceAnchor);
    }
  }

  return {
    completedAt,
    reachedRunCap,
    transition: {
      scheduleId: schedule.id,
      expectedRevision: schedule.revision,
      expectedState: {
        status: schedule.status,
        enabled: schedule.enabled,
        runCounter: schedule.runCounter,
        nextRunAt: schedule.nextRunAt,
        lastRunAt: schedule.lastRunAt,
        updatedAt: schedule.updatedAt,
      },
      status,
      enabled,
      runCounter,
      nextRunAt,
      lastRunAt: isActiveRunStatus(run.status) ? run.startedAt : completedAt,
      updatedAt: isActiveRunStatus(run.status) ? run.startedAt : completedAt,
    },
  };
}
