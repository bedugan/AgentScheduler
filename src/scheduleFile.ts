import type {
  ApprovalMode,
  HarnessMode,
  ImportSchedulesOptions,
  IsoTimestamp,
  RunCadence,
  RunCapInput,
  Schedule,
  ScheduleExportEntry,
  ScheduleExportFile,
  ScheduleImportResult,
  ScheduleImportWarning,
  TargetContext,
} from "./domain.js";
import { SCHEDULE_EXPORT_SCHEMA_VERSION } from "./domain.js";

type ScheduleIdGenerator = { nextId(prefix: string): string };

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

export class ScheduleFile {
  constructor(
    private readonly idGenerator: ScheduleIdGenerator,
    private readonly hasHarness: (mode: HarnessMode) => boolean,
  ) {}

  export(schedules: Schedule[], exportedAt: IsoTimestamp): ScheduleExportFile {
    return {
      schemaVersion: SCHEDULE_EXPORT_SCHEMA_VERSION,
      exportedAt,
      schedules: schedules.map(exportEntryFor),
    };
  }

  async import(
    exportFile: unknown,
    options: ImportSchedulesOptions,
    importedAt: IsoTimestamp,
  ): Promise<ScheduleImportResult> {
    const entries = parseScheduleExportFile(exportFile);
    return {
      schedules: entries.map((entry) =>
        importedScheduleFor(entry, importedAt, this.idGenerator),
      ),
      warnings: await collectImportWarnings(entries, options, this.hasHarness),
    };
  }

  async importJson(
    json: string,
    options: ImportSchedulesOptions,
    importedAt: IsoTimestamp,
  ): Promise<ScheduleImportResult> {
    let exportFile: unknown;
    try {
      exportFile = JSON.parse(json);
    } catch (error) {
      throw new Error("Schedule export JSON is invalid.", { cause: error });
    }
    return this.import(exportFile, options, importedAt);
  }
}

function exportEntryFor(schedule: Schedule): ScheduleExportEntry {
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

async function collectImportWarnings(
  entries: ParsedScheduleExportEntry[],
  options: ImportSchedulesOptions,
  hasHarness: (mode: HarnessMode) => boolean,
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
          ? `Blocked: Workspace '${entry.targetContext.uri}' is not available on this machine.`
          : "Blocked: Target context is required before activation.",
      });
    }
    if (!entry.harnessMode || !hasHarness(entry.harnessMode)) {
      warnings.push({
        sourceScheduleId: entry.sourceScheduleId,
        code: "unavailable-harness-mode",
        message: entry.harnessMode
          ? `Blocked: Harness mode '${entry.harnessMode}' is unavailable.`
          : "Blocked: Harness mode is required before activation.",
      });
    }
    if (entry.runInstructions.trim().length === 0) {
      warnings.push({
        sourceScheduleId: entry.sourceScheduleId,
        code: "activation-blocker",
        message: "Blocked: Run instructions are required before activation.",
      });
    }
    if (!entry.cadence) {
      warnings.push({
        sourceScheduleId: entry.sourceScheduleId,
        code: "activation-blocker",
        message: "Blocked: Run cadence is required before activation.",
      });
    }
    if (entry.originalApprovalMode !== entry.approvalMode) {
      warnings.push({
        sourceScheduleId: entry.sourceScheduleId,
        code: "stale-policy-setting",
        message: `Blocked: Approval mode '${entry.originalApprovalMode}' is no longer supported; imported schedule uses Default Approvals.`,
      });
    }
  }
  return warnings;
}

function importedScheduleFor(
  entry: ParsedScheduleExportEntry,
  now: IsoTimestamp,
  idGenerator: ScheduleIdGenerator,
): Schedule {
  return {
    id: idGenerator.nextId("schedule"),
    revision: 1,
    status: "paused",
    enabled: false,
    runInstructions: entry.runInstructions,
    cadence: entry.cadence,
    targetContext: entry.targetContext,
    harnessMode: entry.harnessMode,
    model: entry.model,
    approvalMode: entry.approvalMode,
    runCounter: { completed: 0, limit: entry.runCap?.maxRuns ?? null },
    nextRunAt: null,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function parseScheduleExportFile(exportFile: unknown): ParsedScheduleExportEntry[] {
  const file = requireRecord(exportFile, "schedule export file");
  if (file.schemaVersion !== SCHEDULE_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schedule export schema version '${String(file.schemaVersion)}'.`,
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
  if (type !== "cron") throw new Error(`${path}.type must be 'cron'.`);
  return { type, expression: requireString(cadence, "expression", path) };
}
function parseNullableTargetContext(
  value: unknown,
  path: string,
): TargetContext | null {
  return value === null ? null : parseTargetContext(value, path);
}
function parseTargetContext(value: unknown, path: string): TargetContext {
  const target = requireRecord(value, path);
  const type = requireString(target, "type", path);
  if (type !== "workspace") {
    throw new Error(`${path}.type must be 'workspace'.`);
  }
  const parsed: TargetContext = {
    type,
    uri: requireString(target, "uri", path),
  };
  if (target.label !== undefined) {
    parsed.label = requireString(target, "label", path);
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
  if (value === "local-copilot" || value === "cloud-copilot") return value;
  throw new Error(`${path} must be a supported harness mode.`);
}
function parseApprovalMode(value: string): ApprovalMode {
  return value === "default-approvals" ||
    value === "bypass-approvals" ||
    value === "autopilot"
    ? value
    : "default-approvals";
}
function parseRunCap(value: unknown, path: string): RunCapInput | null {
  if (value === null || value === undefined) return null;
  return {
    maxRuns: requirePositiveInteger(
      requireRecord(value, path),
      "maxRuns",
      path,
    ),
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
  if (typeof value === "string") return value;
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
