import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EditorControlSurface, ScheduleLifecycle } from "../src/index.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("schedule import and export", () => {
  it("exports selected and all schedules as versioned readable JSON without run history", async () => {
    const clock = new FakeClock("2026-07-07T20:00:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const firstSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Review open release blockers and summarize next steps.",
      cadence: { type: "cron", expression: "0 9 * * 1-5" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/briandugan/src/personal/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      agentProfile: "triage",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 5 },
    });
    await lifecycle.createDraftSchedule({
      runInstructions: "Check nightly dependency updates.",
      cadence: { type: "cron", expression: "0 6 * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/dependency-check",
      },
      harnessMode: "cloud-copilot",
      model: "gpt-5-mini",
      approvalMode: "bypass-approvals",
    });

    clock.set("2026-07-07T20:05:00.000Z");
    const run = await lifecycle.startManualRun(firstSchedule.id);

    clock.set("2026-07-07T20:10:00.000Z");
    const selectedJson = await lifecycle.exportSchedulesAsJson({
      scheduleIds: [firstSchedule.id],
    });
    const selectedExport = JSON.parse(selectedJson) as {
      schemaVersion: number;
      exportedAt: string;
      schedules: Array<Record<string, unknown>>;
    };
    const allExport = await lifecycle.exportSchedules();

    assert.match(selectedJson, /\n  "schemaVersion": 1,/);
    assert.equal(selectedExport.schemaVersion, 1);
    assert.equal(selectedExport.exportedAt, "2026-07-07T20:10:00.000Z");
    assert.equal(selectedExport.schedules.length, 1);
    assert.equal(allExport.schedules.length, 2);

    assert.deepEqual(selectedExport.schedules[0], {
      sourceScheduleId: firstSchedule.id,
      revision: 1,
      runInstructions: "Review open release blockers and summarize next steps.",
      cadence: { type: "cron", expression: "0 9 * * 1-5" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/briandugan/src/personal/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      agentProfile: "triage",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 5 },
    });
    assert.equal(selectedJson.includes(run.id), false);
    assert.equal(selectedJson.includes("previousRuns"), false);
    assert.equal(selectedJson.includes("runHistory"), false);
    assert.equal(selectedJson.includes("Fake harness completed"), false);
  });

  it("round-trips incomplete draft activation fields with import warnings", async () => {
    const clock = new FakeClock("2026-07-07T20:30:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const draft = await lifecycle.createDraftSchedule({
      runInstructions: "Review bug branches.",
      cadence: null,
      targetContext: null,
      harnessMode: null,
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const exportFile = await lifecycle.exportSchedules({
      scheduleIds: [draft.id],
    });

    assert.deepEqual(exportFile.schedules[0], {
      sourceScheduleId: draft.id,
      revision: 1,
      runInstructions: "Review bug branches.",
      cadence: null,
      targetContext: null,
      harnessMode: null,
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: null,
    });

    clock.set("2026-07-07T20:35:00.000Z");
    const imported = await lifecycle.importSchedules(exportFile);

    assert.equal(imported.schedules.length, 1);
    assert.deepEqual(
      imported.warnings.map((warning) => warning.code).sort(),
      ["activation-blocker", "missing-workspace", "unavailable-harness-mode"],
    );
    assert.equal(imported.schedules[0]?.status, "paused");
    assert.equal(imported.schedules[0]?.enabled, false);
    assert.equal(imported.schedules[0]?.cadence, null);
    assert.equal(imported.schedules[0]?.targetContext, null);
    assert.equal(imported.schedules[0]?.harnessMode, null);
    assert.equal(imported.schedules[0]?.nextRunAt, null);
  });

  it("imports versioned schedules as paused and returns activation warnings", async () => {
    const clock = new FakeClock("2026-07-07T21:00:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);

    const result = await lifecycle.importSchedules(
      {
        schemaVersion: 1,
        exportedAt: "2026-07-07T20:45:00.000Z",
        schedules: [
          {
            sourceScheduleId: "source_schedule_1",
            revision: 4,
            runInstructions: "Run imported release readiness checks.",
            cadence: { type: "cron", expression: "30 8 * * 1-5" },
            targetContext: {
              type: "workspace",
              uri: "file:///missing/workspace",
              label: "Missing workspace",
            },
            harnessMode: "cloud-copilot",
            model: "gpt-5",
            approvalMode: "legacy-approval-mode",
            runCap: { maxRuns: 2 },
          },
        ],
      },
      {
        isWorkspaceAvailable: (uri) => uri !== "file:///missing/workspace",
      },
    );

    assert.equal(result.schedules.length, 1);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code).sort(),
      [
        "missing-workspace",
        "stale-policy-setting",
        "unavailable-harness-mode",
      ],
    );
    assert.deepEqual(
      result.warnings.map((warning) => warning.message.startsWith("Blocked:")),
      [true, true, true],
    );
    assert.equal(result.warnings[0]?.sourceScheduleId, "source_schedule_1");

    const imported = result.schedules[0];
    assert.ok(imported);
    assert.equal(imported.id, "schedule_1");
    assert.equal(imported.revision, 1);
    assert.equal(imported.status, "paused");
    assert.equal(imported.enabled, false);
    assert.equal(imported.runInstructions, "Run imported release readiness checks.");
    assert.deepEqual(imported.cadence, { type: "cron", expression: "30 8 * * 1-5" });
    assert.deepEqual(imported.targetContext, {
      type: "workspace",
      uri: "file:///missing/workspace",
      label: "Missing workspace",
    });
    assert.equal(imported.harnessMode, "cloud-copilot");
    assert.equal(imported.model, "gpt-5");
    assert.equal(imported.approvalMode, "default-approvals");
    assert.deepEqual(imported.runCounter, { completed: 0, limit: 2 });
    assert.equal(imported.nextRunAt, null);
    assert.equal(imported.lastRunAt, null);
    assert.equal(imported.createdAt, "2026-07-07T21:00:00.000Z");
    assert.equal(imported.updatedAt, "2026-07-07T21:00:00.000Z");

    const detail = await editor.openScheduleDetail(imported.id);
    assert.equal(detail.schedule.status, "paused");
    assert.equal(detail.schedule.enabled, false);
    assert.equal(detail.previousRuns.length, 0);
  });

  it("imports from JSON and rejects unsupported schema versions without saving", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T22:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const result = await lifecycle.importSchedulesJson(
      JSON.stringify({
        schemaVersion: 1,
        exportedAt: "2026-07-07T21:50:00.000Z",
        schedules: [
          {
            sourceScheduleId: "source_schedule_2",
            revision: 1,
            runInstructions: "Run the imported JSON path.",
            cadence: { type: "cron", expression: "15 * * * *" },
            targetContext: {
              type: "workspace",
              uri: "file:///tmp/imported-json",
            },
            harnessMode: "local-copilot",
            model: "gpt-5",
            approvalMode: "autopilot",
            runCap: null,
          },
        ],
      }),
    );

    assert.equal(result.schedules.length, 1);
    assert.equal(result.schedules[0]?.status, "paused");
    assert.deepEqual(result.warnings, []);

    await assert.rejects(
      lifecycle.importSchedulesJson(
        JSON.stringify({
          schemaVersion: 2,
          exportedAt: "2026-07-07T21:55:00.000Z",
          schedules: [],
        }),
      ),
      /Unsupported schedule export schema version '2'/,
    );
    assert.equal((await lifecycle.listSchedules()).length, 1);
  });

  it("imports by creating new definitions without overwriting an id collision", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T22:30:00.000Z"),
      idGenerator: { nextId: () => "schedule_collision" },
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const existing = await lifecycle.createDraftSchedule({
      runInstructions: "Keep this existing definition.",
      cadence: null,
      targetContext: null,
      harnessMode: null,
      model: "auto",
      approvalMode: "default-approvals",
    });

    await assert.rejects(
      lifecycle.importSchedules({
        schemaVersion: 1,
        exportedAt: "2026-07-07T22:20:00.000Z",
        schedules: [
          {
            sourceScheduleId: "source_collision",
            revision: 1,
            runInstructions: "Do not overwrite the existing definition.",
            cadence: null,
            targetContext: null,
            harnessMode: null,
            model: "auto",
            approvalMode: "default-approvals",
            runCap: null,
          },
        ],
      }),
      /already exists.*No existing schedule was overwritten/,
    );

    assert.equal(
      (await lifecycle.openScheduleDetail(existing.id)).schedule.runInstructions,
      "Keep this existing definition.",
    );
  });
});
