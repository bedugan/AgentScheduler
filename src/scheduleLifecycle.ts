import { randomUUID } from "node:crypto";

import type {
  ApprovalMode,
  CreateDraftScheduleInput,
  DueWorkScanResult,
  ExportSchedulesInput,
  HarnessMode,
  ImportSchedulesOptions,
  IsoTimestamp,
  ResolvedHarnessPolicy,
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
import { SCHEDULE_EXPORT_SCHEMA_VERSION } from "./domain.js";
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
      const workspaceAvailable =
        entry.targetContext.uri.trim().length > 0 &&
        (options.isWorkspaceAvailable
          ? await options.isWorkspaceAvailable(entry.targetContext.uri)
          : true);

      if (!workspaceAvailable) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "missing-workspace",
          message: `Workspace '${entry.targetContext.uri}' is not available on this machine.`,
        });
      }

      if (!this.harnesses.has(entry.harnessMode)) {
        warnings.push({
          sourceScheduleId: entry.sourceScheduleId,
          code: "unavailable-harness-mode",
          message: `Harness mode '${entry.harnessMode}' is unavailable.`,
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
  cadence: RunCadence;
  targetContext: TargetContext;
  harnessMode: HarnessMode;
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
    cadence: parseCadence(entry.cadence, `${path}.cadence`),
    targetContext: parseTargetContext(entry.targetContext, `${path}.targetContext`),
    harnessMode: parseHarnessMode(entry.harnessMode, `${path}.harnessMode`),
    model: requireString(entry, "model", path),
    approvalMode: parseApprovalMode(originalApprovalMode),
    originalApprovalMode,
    runCap: parseRunCap(entry.runCap, `${path}.runCap`),
  };
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
