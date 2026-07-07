import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ApprovalMode,
  HarnessMode,
  RunCadence,
  RunCounter,
  RunHistoryEntry,
  RunStatus,
  RunTrigger,
  Schedule,
  ScheduleStatus,
  TargetContext,
} from "./domain.js";
import type { ScheduleStore } from "./store.js";

export interface SqliteScheduleStoreOptions {
  databasePath: string;
}

interface ScheduleRow {
  id: string;
  revision: number;
  status: ScheduleStatus;
  enabled: number;
  run_instructions: string;
  cadence_json: string;
  target_context_json: string;
  harness_mode: HarnessMode | "";
  model: string;
  approval_mode: ApprovalMode;
  run_counter_json: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunHistoryRow {
  id: string;
  schedule_id: string;
  schedule_revision: number;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  run_instructions_snapshot: string;
  approval_mode_snapshot: ApprovalMode;
  resolved_harness_policy_json: string;
  harness_mode: HarnessMode | "";
  model: string;
  target_context_json: string;
  external_run_id: string | null;
  summary: string | null;
  error: string | null;
}

export class SqliteScheduleStore implements ScheduleStore {
  private readonly database: DatabaseSync;

  constructor(options: SqliteScheduleStoreOptions) {
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(options.databasePath);
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  async saveSchedule(schedule: Schedule): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO schedules (
          id,
          revision,
          status,
          enabled,
          run_instructions,
          cadence_json,
          target_context_json,
          harness_mode,
          model,
          approval_mode,
          run_counter_json,
          next_run_at,
          last_run_at,
          created_at,
          updated_at
        ) VALUES (
          $id,
          $revision,
          $status,
          $enabled,
          $run_instructions,
          $cadence_json,
          $target_context_json,
          $harness_mode,
          $model,
          $approval_mode,
          $run_counter_json,
          $next_run_at,
          $last_run_at,
          $created_at,
          $updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          revision = excluded.revision,
          status = excluded.status,
          enabled = excluded.enabled,
          run_instructions = excluded.run_instructions,
          cadence_json = excluded.cadence_json,
          target_context_json = excluded.target_context_json,
          harness_mode = excluded.harness_mode,
          model = excluded.model,
          approval_mode = excluded.approval_mode,
          run_counter_json = excluded.run_counter_json,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `)
      .run({
        id: schedule.id,
        revision: schedule.revision,
        status: schedule.status,
        enabled: schedule.enabled ? 1 : 0,
        run_instructions: schedule.runInstructions,
        cadence_json: JSON.stringify(schedule.cadence),
        target_context_json: JSON.stringify(schedule.targetContext),
        harness_mode: schedule.harnessMode ?? "",
        model: schedule.model,
        approval_mode: schedule.approvalMode,
        run_counter_json: JSON.stringify(schedule.runCounter),
        next_run_at: schedule.nextRunAt,
        last_run_at: schedule.lastRunAt,
        created_at: schedule.createdAt,
        updated_at: schedule.updatedAt,
      });
  }

  async getSchedule(id: string): Promise<Schedule | undefined> {
    const row = this.database
      .prepare("SELECT * FROM schedules WHERE id = $id")
      .get({ id }) as ScheduleRow | undefined;

    return row ? this.scheduleFromRow(row) : undefined;
  }

  async listSchedules(): Promise<Schedule[]> {
    const rows = this.database
      .prepare("SELECT * FROM schedules ORDER BY created_at ASC, id ASC")
      .all() as unknown as ScheduleRow[];

    return rows.map((row) => this.scheduleFromRow(row));
  }

  async listDueSchedules(now: string): Promise<Schedule[]> {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM schedules
        WHERE enabled = 1
          AND status = 'active'
          AND next_run_at IS NOT NULL
          AND cadence_json <> 'null'
          AND target_context_json <> 'null'
          AND harness_mode <> ''
          AND next_run_at <= $now
        ORDER BY next_run_at ASC, id ASC
      `)
      .all({ now }) as unknown as ScheduleRow[];

    return rows.map((row) => this.scheduleFromRow(row));
  }

  async saveRunHistory(entry: RunHistoryEntry): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO run_history (
          id,
          schedule_id,
          schedule_revision,
          trigger,
          status,
          started_at,
          completed_at,
          run_instructions_snapshot,
          approval_mode_snapshot,
          resolved_harness_policy_json,
          harness_mode,
          model,
          target_context_json,
          external_run_id,
          summary,
          error
        ) VALUES (
          $id,
          $schedule_id,
          $schedule_revision,
          $trigger,
          $status,
          $started_at,
          $completed_at,
          $run_instructions_snapshot,
          $approval_mode_snapshot,
          $resolved_harness_policy_json,
          $harness_mode,
          $model,
          $target_context_json,
          $external_run_id,
          $summary,
          $error
        )
      `)
      .run({
        id: entry.id,
        schedule_id: entry.scheduleId,
        schedule_revision: entry.scheduleRevision,
        trigger: entry.trigger,
        status: entry.status,
        started_at: entry.startedAt,
        completed_at: entry.completedAt,
        run_instructions_snapshot: entry.runInstructionsSnapshot,
        approval_mode_snapshot: entry.approvalModeSnapshot,
        resolved_harness_policy_json: JSON.stringify(entry.resolvedHarnessPolicy),
        harness_mode: entry.harnessMode ?? "",
        model: entry.model,
        target_context_json: JSON.stringify(entry.targetContext),
        external_run_id: entry.externalRunId,
        summary: entry.summary,
        error: entry.error,
      });
  }

  async listRunHistory(scheduleId: string): Promise<RunHistoryEntry[]> {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM run_history
        WHERE schedule_id = $schedule_id
        ORDER BY started_at DESC, id DESC
      `)
      .all({ schedule_id: scheduleId }) as unknown as RunHistoryRow[];

    return rows.map((row) => this.runHistoryFromRow(row));
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        run_instructions TEXT NOT NULL,
        cadence_json TEXT NOT NULL,
        target_context_json TEXT NOT NULL,
        harness_mode TEXT NOT NULL,
        model TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        run_counter_json TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules(enabled, status, next_run_at);

      CREATE TABLE IF NOT EXISTS run_history (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        schedule_revision INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        run_instructions_snapshot TEXT NOT NULL,
        approval_mode_snapshot TEXT NOT NULL,
        resolved_harness_policy_json TEXT NOT NULL,
        harness_mode TEXT NOT NULL,
        model TEXT NOT NULL,
        target_context_json TEXT NOT NULL,
        external_run_id TEXT,
        summary TEXT,
        error TEXT,
        FOREIGN KEY(schedule_id) REFERENCES schedules(id)
      );

      CREATE INDEX IF NOT EXISTS idx_run_history_schedule
        ON run_history(schedule_id, started_at DESC);
    `);
  }

  private scheduleFromRow(row: ScheduleRow): Schedule {
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      enabled: row.enabled === 1,
      runInstructions: row.run_instructions,
      cadence: parseJson<RunCadence | null>(row.cadence_json),
      targetContext: parseJson<TargetContext | null>(row.target_context_json),
      harnessMode: row.harness_mode === "" ? null : row.harness_mode,
      model: row.model,
      approvalMode: row.approval_mode,
      runCounter: parseJson<RunCounter>(row.run_counter_json),
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private runHistoryFromRow(row: RunHistoryRow): RunHistoryEntry {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      scheduleRevision: row.schedule_revision,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      runInstructionsSnapshot: row.run_instructions_snapshot,
      approvalModeSnapshot: row.approval_mode_snapshot,
      resolvedHarnessPolicy: parseJson<Record<string, unknown>>(
        row.resolved_harness_policy_json,
      ),
      harnessMode: row.harness_mode === "" ? null : row.harness_mode,
      model: row.model,
      targetContext: parseJson<TargetContext | null>(row.target_context_json),
      externalRunId: row.external_run_id,
      summary: row.summary,
      error: row.error,
    };
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
