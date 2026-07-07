import { randomUUID } from "node:crypto";

import type {
  ApprovalMode,
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  DueWorkScanResult,
  ExportSchedulesInput,
  HarnessMode,
  ImportSchedulesOptions,
  IsoTimestamp,
  ResolvedHarnessPolicy,
  ResolveActiveRunInput,
  RunCadence,
  RunCapInput,
  RunHistoryEntry,
  RunTrigger,
  Schedule,
  ScheduleExportEntry,
  ScheduleExportFile,
  ScheduleDetailView,
  ScheduleImportResult,
  ScheduleImportWarning,
  TargetContext,
} from "./domain.js";
import {
  SCHEDULE_EXPORT_SCHEMA_VERSION,
  isActiveRunStatus,
  isStartedRunStatus,
} from "./domain.js";
import { nextRunAtAfter } from "./cadence.js";
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
    return this.createSchedule(input, "draft");
  }

  async createActiveSchedule(input: CreateActiveScheduleInput): Promise<Schedule> {
    return this.createSchedule(input, "active");
  }

  private async createSchedule(
    input: CreateDraftScheduleInput | CreateActiveScheduleInput,
    status: "draft" | "active",
  ): Promise<Schedule> {
    const now = this.nowIso();
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
      approvalMode: input.approvalMode,
      runCounter: {
        completed: 0,
        limit: input.runCap?.maxRuns ?? null,
      },
      nextRunAt:
        status === "active"
          ? nextRunAtAfter(
              (input as CreateActiveScheduleInput).cadence,
              this.clock.now(),
            )
          : null,
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

  async exportSchedules(
    input: ExportSchedulesInput = {},
  ): Promise<ScheduleExportFile> {
    const schedules = input.scheduleIds
      ? await Promise.all(input.scheduleIds.map((id) => this.requireSchedule(id)))
      : await this.store.listSchedules();

    return {
      schemaVersion: SCHEDULE_EXPORT_SCHEMA_VERSION,
      exportedAt: this.nowIso(),
      schedules: schedules.map((schedule) => this.exportEntryFor(schedule)),
    };
  }

  async exportSchedulesAsJson(input: ExportSchedulesInput = {}): Promise<string> {
    return `${JSON.stringify(await this.exportSchedules(input), null, 2)}\n`;
  }

  async importSchedules(
    exportFile: unknown,
    options: ImportSchedulesOptions = {},
  ): Promise<ScheduleImportResult> {
    const entries = parseScheduleExportFile(exportFile);
    const warnings = await this.collectImportWarnings(entries, options);
    const now = this.nowIso();
    const schedules = entries.map((entry) => this.importedScheduleFor(entry, now));

    for (const schedule of schedules) {
      await this.store.saveSchedule(schedule);
    }

    return { schedules, warnings };
  }

  async importSchedulesJson(
    json: string,
    options: ImportSchedulesOptions = {},
  ): Promise<ScheduleImportResult> {
    let exportFile: unknown;
    try {
      exportFile = JSON.parse(json);
    } catch (error) {
      throw new Error("Schedule export JSON is invalid.", { cause: error });
    }

    return this.importSchedules(exportFile, options);
  }

  async activateSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    this.requireScheduleStatus(schedule, ["draft"], "activated");
    this.requireActivationRequirements(schedule);
    const now = this.nowIso();
    const activeSchedule: Schedule = {
      ...schedule,
      status: "active",
      enabled: true,
      nextRunAt: nextRunAtAfter(schedule.cadence, this.clock.now()),
      updatedAt: now,
    };

    await this.store.saveSchedule(activeSchedule);
    return activeSchedule;
  }

  async pauseSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    this.requireScheduleStatus(schedule, ["active"], "paused");
    const now = this.nowIso();
    const pausedSchedule: Schedule = {
      ...schedule,
      status: "paused",
      enabled: false,
      nextRunAt: null,
      updatedAt: now,
    };

    await this.store.saveSchedule(pausedSchedule);
    return pausedSchedule;
  }

  async resumeSchedule(scheduleId: string): Promise<Schedule> {
    const schedule = await this.requireSchedule(scheduleId);
    this.requireScheduleStatus(schedule, ["paused"], "resumed");
    this.requireActivationRequirements(schedule);
    const now = this.nowIso();
    const resumedSchedule: Schedule = {
      ...schedule,
      status: "active",
      enabled: true,
      nextRunAt: nextRunAtAfter(schedule.cadence, this.clock.now()),
      updatedAt: now,
    };

    await this.store.saveSchedule(resumedSchedule);
    return resumedSchedule;
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
      if (isStartedRunStatus(run.status)) {
        startedRunIds.push(run.id);
      }
    }

    return { startedRunIds };
  }

  async startManualRun(scheduleId: string): Promise<RunHistoryEntry> {
    const schedule = await this.requireSchedule(scheduleId);
    const trigger: RunTrigger =
      schedule.status === "draft" ? "draft-manual" : "manual";

    return this.startRun(schedule, trigger);
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

  private async startRun(
    schedule: Schedule,
    trigger: RunTrigger,
  ): Promise<RunHistoryEntry> {
    const requestedAt = this.nowIso();
    const missingRunRequirements = this.missingActivationRequirements(schedule);
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
      this.hasRunCounterReachedLimit(schedule.runCounter)
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
      await this.store.saveRunHistory(blockedRun);
      await this.store.saveSchedule({
        ...schedule,
        status: "completed",
        enabled: false,
        nextRunAt: null,
        lastRunAt: requestedAt,
        updatedAt: requestedAt,
      });
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

    const occupyingRun = await this.findOccupyingRun(schedule);
    if (occupyingRun) {
      const reason =
        "Run slot is occupied by an active run. AgentScheduler deferred this due run and will coalesce catch-up work for the schedule.";

      if (trigger === "automatic") {
        return this.deferRun(schedule, trigger, requestedAt, reason);
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
    const preflight = await harness.preflight({
      schedule,
      trigger,
      requestedAt,
      localSchedulingEnabled: this.localSchedulingEnabled,
    });

    if (preflight.status === "blocked") {
      await this.completePendingDeferredRun(
        pendingDeferredRun,
        requestedAt,
        "Deferred run ended with a blocked catch-up attempt.",
      );
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

    if (preflight.status === "deferred") {
      return this.deferRun(
        schedule,
        trigger,
        requestedAt,
        preflight.reason,
        preflight.resolvedHarnessPolicy,
      );
    }

    if (preflight.status === "requires-approval") {
      await this.completePendingDeferredRun(pendingDeferredRun, requestedAt);
      const approvalWaitingRun = this.buildRunHistoryEntry({
        schedule,
        trigger,
        startedAt: requestedAt,
        completedAt: null,
        status: "approval-waiting",
        resolvedHarnessPolicy: preflight.resolvedHarnessPolicy,
        externalRunId: null,
        summary: preflight.reason,
        error: null,
      });
      await this.persistRunResult(schedule, approvalWaitingRun, trigger);
      return approvalWaitingRun;
    }

    await this.completePendingDeferredRun(pendingDeferredRun, requestedAt);
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
    let nextStatus = schedule.status;
    let nextEnabled = schedule.enabled;
    let nextRunAt = schedule.nextRunAt;

    if (isActiveRunStatus(run.status)) {
      if (trigger === "automatic" && schedule.cadence) {
        nextRunAt = nextRunAtAfter(schedule.cadence, new Date(run.startedAt));
      }

      await this.store.saveSchedule({
        ...schedule,
        nextRunAt,
        lastRunAt: run.startedAt,
        updatedAt: run.startedAt,
      });
      return;
    }

    if (trigger !== "draft-manual" && run.status === "completed") {
      nextRunCounter.completed += 1;
    }

    const pendingDeferredRun =
      trigger === "automatic" && run.status === "completed"
        ? await this.store.getPendingDeferredRun(schedule.id)
        : undefined;

    if (this.hasRunCounterReachedLimit(nextRunCounter)) {
      nextStatus = "completed";
      nextEnabled = false;
      nextRunAt = null;
      await this.completePendingDeferredRun(
        pendingDeferredRun,
        completedAt,
        "Deferred run ended because the schedule completed before catch-up work started.",
      );
    } else if (
      trigger === "automatic" &&
      run.status === "completed" &&
      schedule.cadence
    ) {
      nextRunAt = pendingDeferredRun
        ? schedule.nextRunAt
        : nextRunAtAfter(schedule.cadence, new Date(completedAt));
    }

    await this.store.saveSchedule({
      ...schedule,
      status: nextStatus,
      enabled: nextEnabled,
      runCounter: nextRunCounter,
      nextRunAt,
      lastRunAt: completedAt,
      updatedAt: completedAt,
    });
  }

  private hasRunCounterReachedLimit(runCounter: Schedule["runCounter"]): boolean {
    return runCounter.limit !== null && runCounter.completed >= runCounter.limit;
  }

  private requireScheduleStatus(
    schedule: Schedule,
    allowedStatuses: Schedule["status"][],
    action: string,
  ): void {
    if (!allowedStatuses.includes(schedule.status)) {
      throw new Error(
        `Only ${formatScheduleStatuses(allowedStatuses)} schedules can be ${action}.`,
      );
    }
  }

  private requireActivationRequirements(
    schedule: Schedule,
  ): asserts schedule is ActivationReadySchedule {
    const missingRequirements = this.missingActivationRequirements(schedule);
    if (missingRequirements.length > 0) {
      throw new Error(missingRequirements.join(" "));
    }
  }

  private defaultPolicySnapshot(schedule: Schedule): ResolvedHarnessPolicy {
    return {
      harnessMode: schedule.harnessMode,
      approvalMode: schedule.approvalMode,
    };
  }

  private exportEntryFor(schedule: Schedule): ScheduleExportEntry {
    return {
      sourceScheduleId: schedule.id,
      revision: schedule.revision,
      runInstructions: schedule.runInstructions,
      cadence: schedule.cadence,
      targetContext: schedule.targetContext,
      harnessMode: schedule.harnessMode,
      model: schedule.model,
      approvalMode: schedule.approvalMode,
      runCap:
        schedule.runCounter.limit === null
          ? null
          : { maxRuns: schedule.runCounter.limit },
    };
  }

  private async collectImportWarnings(
    entries: ParsedScheduleExportEntry[],
    options: ImportSchedulesOptions,
  ): Promise<ScheduleImportWarning[]> {
    const warnings: ScheduleImportWarning[] = [];

    for (const entry of entries) {
      const workspaceAvailable = entry.targetContext
        ? entry.targetContext.uri.trim().length > 0 &&
          (options.isWorkspaceAvailable
            ? await options.isWorkspaceAvailable(entry.targetContext.uri)
            : true)
        : false;

      if (!workspaceAvailable) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "missing-workspace",
          message: entry.targetContext
            ? `Workspace '${entry.targetContext.uri}' is not available on this machine.`
            : "Target context is required before activation.",
        });
      }

      if (!entry.harnessMode || !this.harnesses.has(entry.harnessMode)) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "unavailable-harness-mode",
          message: entry.harnessMode
            ? `Harness mode '${entry.harnessMode}' is unavailable.`
            : "Harness mode is required before activation.",
        });
      }

      if (entry.runInstructions.trim().length === 0) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "activation-blocker",
          message: "Run instructions are required before activation.",
        });
      }

      if (!entry.cadence) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "activation-blocker",
          message: "Run cadence is required before activation.",
        });
      }

      if (entry.originalApprovalMode !== entry.approvalMode) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "stale-policy-setting",
          message: `Approval mode '${entry.originalApprovalMode}' is no longer supported; imported schedule uses Default Approvals.`,
        });
      }
    }

    return warnings;
  }

  private importedScheduleFor(
    entry: ParsedScheduleExportEntry,
    now: IsoTimestamp,
  ): Schedule {
    return {
      id: this.idGenerator.nextId("schedule"),
      revision: 1,
      status: "paused",
      enabled: false,
      runInstructions: entry.runInstructions,
      cadence: entry.cadence,
      targetContext: entry.targetContext,
      harnessMode: entry.harnessMode,
      model: entry.model,
      approvalMode: entry.approvalMode,
      runCounter: {
        completed: 0,
        limit: entry.runCap?.maxRuns ?? null,
      },
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private missingActivationRequirements(schedule: Schedule): string[] {
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
    }
    return messages;
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

interface ParsedScheduleExportEntry {
  sourceScheduleId: string;
  revision: number;
  runInstructions: string;
  cadence: RunCadence | null;
  targetContext: TargetContext | null;
  harnessMode: HarnessMode | null;
  model: string;
  approvalMode: ApprovalMode;
  originalApprovalMode: string;
  runCap: RunCapInput | null;
}

function parseScheduleExportFile(exportFile: unknown): ParsedScheduleExportEntry[] {
  const file = requireRecord(exportFile, "schedule export file");
  const schemaVersion = file.schemaVersion;

  if (schemaVersion !== SCHEDULE_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schedule export schema version '${String(schemaVersion)}'.`,
    );
  }

  requireString(file, "exportedAt", "schedule export file");

  if (!Array.isArray(file.schedules)) {
    throw new Error("Schedule export file must contain a schedules array.");
  }

  return file.schedules.map((entry, index) =>
    parseScheduleExportEntry(entry, `schedules[${index}]`),
  );
}

function parseScheduleExportEntry(
  value: unknown,
  path: string,
): ParsedScheduleExportEntry {
  const entry = requireRecord(value, path);
  const originalApprovalMode = requireString(entry, "approvalMode", path);

  return {
    sourceScheduleId: requireString(entry, "sourceScheduleId", path),
    revision: requirePositiveInteger(entry, "revision", path),
    runInstructions: requireString(entry, "runInstructions", path),
    cadence: parseNullableCadence(entry.cadence, `${path}.cadence`),
    targetContext: parseNullableTargetContext(
      entry.targetContext,
      `${path}.targetContext`,
    ),
    harnessMode: parseNullableHarnessMode(
      entry.harnessMode,
      `${path}.harnessMode`,
    ),
    model: requireString(entry, "model", path),
    approvalMode: parseApprovalMode(originalApprovalMode),
    originalApprovalMode,
    runCap: parseRunCap(entry.runCap, `${path}.runCap`),
  };
}

function parseNullableCadence(value: unknown, path: string): RunCadence | null {
  return value === null ? null : parseCadence(value, path);
}

function parseCadence(value: unknown, path: string): RunCadence {
  const cadence = requireRecord(value, path);
  const type = requireString(cadence, "type", path);

  if (type !== "cron") {
    throw new Error(`${path}.type must be 'cron'.`);
  }

  return {
    type,
    expression: requireString(cadence, "expression", path),
  };
}

function parseNullableTargetContext(
  value: unknown,
  path: string,
): TargetContext | null {
  return value === null ? null : parseTargetContext(value, path);
}

function parseTargetContext(value: unknown, path: string): TargetContext {
  const targetContext = requireRecord(value, path);
  const type = requireString(targetContext, "type", path);

  if (type !== "workspace") {
    throw new Error(`${path}.type must be 'workspace'.`);
  }

  const parsed: TargetContext = {
    type,
    uri: requireString(targetContext, "uri", path),
  };

  if (targetContext.label !== undefined) {
    parsed.label = requireString(targetContext, "label", path);
  }

  return parsed;
}

function parseNullableHarnessMode(
  value: unknown,
  path: string,
): HarnessMode | null {
  return value === null ? null : parseHarnessMode(value, path);
}

function parseHarnessMode(value: unknown, path: string): HarnessMode {
  if (value === "local-copilot" || value === "cloud-copilot") {
    return value;
  }

  throw new Error(`${path} must be a supported harness mode.`);
}

function parseApprovalMode(value: string): ApprovalMode {
  if (
    value === "default-approvals" ||
    value === "bypass-approvals" ||
    value === "autopilot"
  ) {
    return value;
  }

  return "default-approvals";
}

function parseRunCap(value: unknown, path: string): RunCapInput | null {
  if (value === null || value === undefined) {
    return null;
  }

  const runCap = requireRecord(value, path);
  return {
    maxRuns: requirePositiveInteger(runCap, "maxRuns", path),
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${path} must be an object.`);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`${path}.${key} must be a string.`);
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = record[key];
  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    return value;
  }

  throw new Error(`${path}.${key} must be a positive integer.`);
}

type ActivationReadySchedule = Schedule & {
  cadence: NonNullable<Schedule["cadence"]>;
  targetContext: NonNullable<Schedule["targetContext"]>;
  harnessMode: NonNullable<Schedule["harnessMode"]>;
};

function formatScheduleStatuses(statuses: Schedule["status"][]): string {
  return statuses.join(" or ");
}
