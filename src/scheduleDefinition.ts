import type {
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  RunCadence,
  Schedule,
  TargetContext,
  UpdateScheduleInput,
} from "./domain.js";
import { nextRunAtAfter } from "./recurrencePolicy.js";

type ScheduleTransition = "activate" | "pause" | "resume" | "restart";

type ScheduleIdGenerator = {
  nextId(prefix: string): string;
};

export class ScheduleDefinition {
  constructor(
    private readonly idGenerator: ScheduleIdGenerator,
    private readonly unavailableHarnessReason: (
      schedule: Schedule,
    ) => string | undefined,
  ) {}

  create(
    input: CreateDraftScheduleInput | CreateActiveScheduleInput,
    status: "draft" | "active",
    now: Date,
  ): Schedule {
    const timestamp = now.toISOString();
    const schedule: Schedule = {
      id: this.idGenerator.nextId("schedule"),
      revision: 1,
      status,
      enabled: status === "active",
      runInstructions: input.runInstructions,
      cadence: input.cadence,
      targetContext: input.targetContext,
      harnessMode: input.harnessMode,
      model: input.model,
      ...(input.agentProfile && { agentProfile: input.agentProfile }),
      approvalMode: input.approvalMode,
      runCounter: {
        completed: 0,
        limit: input.runCap?.maxRuns ?? null,
      },
      nextRunAt:
        status === "active"
          ? nextRunAtAfter((input as CreateActiveScheduleInput).cadence, now)
          : null,
      lastRunAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (status === "active") {
      this.assertActivationReady(schedule);
    }
    return schedule;
  }

  update(schedule: Schedule, input: UpdateScheduleInput, now: Date): Schedule {
    const cadenceChanged =
      Object.hasOwn(input, "cadence") &&
      !sameRunCadence(schedule.cadence, input.cadence ?? null);
    const agentProfile = Object.hasOwn(input, "agentProfile")
      ? input.agentProfile?.trim()
      : schedule.agentProfile;
    const nextSchedule: Schedule = {
      ...schedule,
      revision: schedule.revision + 1,
      runInstructions: input.runInstructions ?? schedule.runInstructions,
      cadence: Object.hasOwn(input, "cadence")
        ? (input.cadence ?? null)
        : schedule.cadence,
      targetContext: Object.hasOwn(input, "targetContext")
        ? (input.targetContext ?? null)
        : schedule.targetContext,
      harnessMode: Object.hasOwn(input, "harnessMode")
        ? (input.harnessMode ?? null)
        : schedule.harnessMode,
      model: input.model ?? schedule.model,
      ...(agentProfile && { agentProfile }),
      approvalMode: input.approvalMode ?? schedule.approvalMode,
      runCounter: Object.hasOwn(input, "runCap")
        ? {
            completed: schedule.runCounter.completed,
            limit: input.runCap?.maxRuns ?? null,
          }
        : schedule.runCounter,
      updatedAt: now.toISOString(),
    };
    if (sameScheduleConfiguration(schedule, nextSchedule)) {
      return schedule;
    }
    if (nextSchedule.status === "active") {
      this.assertActivationReady(nextSchedule);
      if (cadenceChanged) {
        nextSchedule.nextRunAt = nextRunAtAfter(nextSchedule.cadence, now);
      }
    }
    return nextSchedule;
  }

  transition(
    schedule: Schedule,
    transition: ScheduleTransition,
    now: Date,
  ): Schedule {
    const timestamp = now.toISOString();
    switch (transition) {
      case "activate":
        requireStatus(schedule, ["draft"], "activated");
        this.assertActivationReady(schedule);
        return {
          ...schedule,
          status: "active",
          enabled: true,
          nextRunAt: nextRunAtAfter(schedule.cadence, now),
          updatedAt: timestamp,
        };
      case "pause":
        requireStatus(schedule, ["active"], "paused");
        return {
          ...schedule,
          status: "paused",
          enabled: false,
          nextRunAt: null,
          updatedAt: timestamp,
        };
      case "resume":
        requireStatus(schedule, ["paused"], "resumed");
        this.assertActivationReady(schedule);
        return {
          ...schedule,
          status: "active",
          enabled: true,
          nextRunAt: nextRunAtAfter(schedule.cadence, now),
          updatedAt: timestamp,
        };
      case "restart":
        requireStatus(schedule, ["completed"], "restarted");
        this.assertActivationReady(schedule);
        return {
          ...schedule,
          status: "active",
          enabled: true,
          runCounter: { ...schedule.runCounter, completed: 0 },
          nextRunAt: nextRunAtAfter(schedule.cadence, now),
          updatedAt: timestamp,
        };
    }
  }

  assertActivationReady(
    schedule: Schedule,
  ): asserts schedule is Schedule & {
    cadence: NonNullable<Schedule["cadence"]>;
    targetContext: NonNullable<Schedule["targetContext"]>;
    harnessMode: NonNullable<Schedule["harnessMode"]>;
  } {
    const missing = this.missingActivationRequirements(schedule);
    if (missing.length > 0) {
      throw new Error(missing.join(" "));
    }
  }

  missingActivationRequirements(schedule: Schedule): string[] {
    const messages: string[] = [];
    if (schedule.runInstructions.trim().length === 0) {
      messages.push("Run instructions are required before activation.");
    }
    if (!schedule.cadence) {
      messages.push("Run cadence is required before activation.");
    }
    if (!schedule.targetContext) {
      messages.push("Target context is required before activation.");
    }
    if (!schedule.harnessMode) {
      messages.push("Harness mode is required before activation.");
    } else {
      const unavailableReason = this.unavailableHarnessReason(schedule);
      if (unavailableReason) {
        messages.push(unavailableReason);
      }
    }
    return messages;
  }
}

function requireStatus(
  schedule: Schedule,
  allowed: Schedule["status"][],
  action: string,
): void {
  if (!allowed.includes(schedule.status)) {
    throw new Error(`Only ${allowed.join(" or ")} schedules can be ${action}.`);
  }
}

function sameRunCadence(
  left: RunCadence | null,
  right: RunCadence | null,
): boolean {
  return (
    left === right ||
    (left?.type === "cron" &&
      right?.type === "cron" &&
      left.expression === right.expression)
  );
}

function sameScheduleConfiguration(left: Schedule, right: Schedule): boolean {
  return (
    left.runInstructions === right.runInstructions &&
    sameRunCadence(left.cadence, right.cadence) &&
    sameTargetContext(left.targetContext, right.targetContext) &&
    left.harnessMode === right.harnessMode &&
    left.model === right.model &&
    left.agentProfile === right.agentProfile &&
    left.approvalMode === right.approvalMode &&
    left.runCounter.limit === right.runCounter.limit
  );
}

function sameTargetContext(
  left: TargetContext | null,
  right: TargetContext | null,
): boolean {
  return (
    left === right ||
    (left?.type === "workspace" &&
      right?.type === "workspace" &&
      left.uri === right.uri &&
      left.label === right.label)
  );
}
