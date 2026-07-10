import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  CopilotCliLocalClient,
  CopilotLocalHarness,
  EditorControlSurface,
  ScheduleLifecycle,
  SqliteScheduleStore,
  VsCodeNaturalLanguageScheduleCreationFlow,
  type CopilotCliCommandResult,
  type CopilotCliCommandRunOptions,
  type CopilotCliCommandRunner,
  type CopilotInteractiveExecutor,
  type RunResultCommit,
  type ScheduleRunStateUpdate,
} from "../src/index.js";
import type {
  HarnessMode,
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessStartRequest,
  HarnessStartResult,
  HarnessExecutionObserver,
  Schedule,
} from "../src/index.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("Schedule Lifecycle API tracer bullet", () => {
  it("creates a disabled draft, hides it from due scans, runs it through a fake harness, and shows history", async () => {
    const clock = new FakeClock("2026-07-07T16:00:00.000Z");
    const store = new InMemoryScheduleStore();
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [fakeHarness],
    });
    const editor = new EditorControlSurface(lifecycle);

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Review open bug branches and summarize risks.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/briandugan/src/personal/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 5 },
    });

    assert.equal(schedule.status, "draft");
    assert.equal(schedule.enabled, false);
    assert.deepEqual(schedule.runCounter, { completed: 0, limit: 5 });

    const list = await editor.listSchedules();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, schedule.id);
    assert.equal(list[0]?.status, "draft");
    assert.equal(list[0]?.nextRunAt, null);

    const dueScan = await lifecycle.scanDueWork();
    assert.deepEqual(dueScan.startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 0);

    clock.set("2026-07-07T16:05:00.000Z");
    const run = await lifecycle.startManualRun(schedule.id);

    assert.equal(run.trigger, "draft-manual");
    assert.equal(run.status, "completed");
    assert.equal(run.runInstructionsSnapshot, schedule.runInstructions);
    assert.equal(run.approvalModeSnapshot, "default-approvals");
    assert.deepEqual(run.resolvedHarnessPolicy, {
      harnessMode: "local-copilot",
      approvalMode: "default-approvals",
      sandbox: "fake",
    });
    assert.equal(fakeHarness.startRequests.length, 1);

    const detail = await editor.openScheduleDetail(schedule.id);
    assert.equal(detail.schedule.id, schedule.id);
    assert.equal(detail.schedule.enabled, false);
    assert.equal(detail.schedule.runInstructions, schedule.runInstructions);
    assert.deepEqual(detail.schedule.cadence, { type: "cron", expression: "0 * * * *" });
    assert.deepEqual(detail.schedule.targetContext, {
      type: "workspace",
      uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      label: "AgentScheduler",
    });
    assert.equal(detail.schedule.harnessMode, "local-copilot");
    assert.equal(detail.schedule.model, "gpt-5");
    assert.equal(detail.schedule.approvalMode, "default-approvals");
    assert.deepEqual(detail.runCounter, { completed: 0, limit: 5 });
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.id, run.id);
    assert.equal(detail.previousRuns[0]?.trigger, "draft-manual");
    assert.equal(detail.lastRunAt, "2026-07-07T16:05:00.000Z");
  });

  it("persists schedules and run history in the SQLite local store across lifecycle restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const firstStore = new SqliteScheduleStore({ databasePath });
      const firstLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T17:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store: firstStore,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });

      const schedule = await firstLifecycle.createDraftSchedule({
        runInstructions: "Run the persistence smoke test.",
        cadence: { type: "cron", expression: "*/30 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/agent-scheduler",
          label: "Persistence fixture",
        },
        harnessMode: "local-copilot",
        model: "gpt-5-mini",
        approvalMode: "bypass-approvals",
        runCap: { maxRuns: 3 },
      });
      await firstLifecycle.startManualRun(schedule.id);
      firstStore.close();

      const secondStore = new SqliteScheduleStore({ databasePath });
      const secondLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T18:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store: secondStore,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      const editor = new EditorControlSurface(secondLifecycle);

      const schedules = await editor.listSchedules();
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0]?.id, schedule.id);
      assert.equal(schedules[0]?.status, "draft");
      assert.equal(schedules[0]?.enabled, false);

      const detail = await editor.openScheduleDetail(schedule.id);
      assert.equal(detail.schedule.runInstructions, schedule.runInstructions);
      assert.deepEqual(detail.runCounter, { completed: 0, limit: 3 });
      assert.equal(detail.previousRuns.length, 1);
      assert.equal(detail.previousRuns[0]?.trigger, "draft-manual");
      assert.equal(detail.previousRuns[0]?.status, "completed");
      assert.equal(
        detail.previousRuns[0]?.runInstructionsSnapshot,
        "Run the persistence smoke test.",
      );
      assert.equal(detail.previousRuns[0]?.approvalModeSnapshot, "bypass-approvals");

      secondStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("waits for normal SQLite writer contention and uses WAL journaling", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");
    let lockHolder: ChildProcess | undefined;
    let store: SqliteScheduleStore | undefined;

    try {
      store = new SqliteScheduleStore({ databasePath });
      const lifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T17:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      const schedule = await lifecycle.createDraftSchedule({
        runInstructions: "Wait for the other Local Store writer.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/agent-scheduler",
        },
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
      });

      lockHolder = spawn(
        process.execPath,
        [
          "-e",
          [
            'const { DatabaseSync } = require("node:sqlite");',
            "const database = new DatabaseSync(process.argv[1]);",
            'database.exec("BEGIN IMMEDIATE TRANSACTION");',
            'process.stdout.write("locked\\n");',
            "setTimeout(() => {",
            '  database.exec("COMMIT");',
            "  database.close();",
            "}, 150);",
          ].join("\n"),
          databasePath,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      assert.ok(lockHolder.stdout);
      await once(lockHolder.stdout, "data");

      const updated = await lifecycle.updateSchedule(schedule.id, {
        runInstructions: "The contending writer completed safely.",
      });
      assert.equal(
        updated.runInstructions,
        "The contending writer completed safely.",
      );
      await once(lockHolder, "exit");

      const inspector = new DatabaseSync(databasePath, { readOnly: true });
      const journalMode = inspector.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      inspector.close();
      assert.equal(journalMode.journal_mode, "wal");
    } finally {
      lockHolder?.kill();
      store?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("deletes schedules and run history from the SQLite local store", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const store = new SqliteScheduleStore({ databasePath });
      const lifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T17:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      const schedule = await lifecycle.createDraftSchedule({
        runInstructions: "Delete this SQLite schedule.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/agent-scheduler",
        },
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
      });
      const run = await lifecycle.startManualRun(schedule.id);
      assert.ok(await store.getLocalRunExecution(run.id));
      await lifecycle.deleteSchedule(schedule.id);
      store.close();

      const reopenedStore = new SqliteScheduleStore({ databasePath });
      assert.equal(await reopenedStore.getSchedule(schedule.id), undefined);
      assert.deepEqual(await reopenedStore.listRunHistory(schedule.id), []);
      assert.equal(await reopenedStore.getLocalRunExecution(run.id), undefined);
      reopenedStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("runs due active schedules from the SQLite local store after lifecycle restart", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const firstStore = new SqliteScheduleStore({ databasePath });
      const firstLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T16:05:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: true,
        store: firstStore,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });

      const schedule = await firstLifecycle.createDraftSchedule({
        runInstructions: "Run from the SQLite due query.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/agent-scheduler",
          label: "SQLite due scan fixture",
        },
        harnessMode: "local-copilot",
        model: "gpt-5-mini",
        approvalMode: "default-approvals",
      });
      await firstLifecycle.activateSchedule(schedule.id);
      firstStore.close();

      const fakeHarness = new FakeHarness({ mode: "local-copilot" });
      const secondStore = new SqliteScheduleStore({ databasePath });
      const secondLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T17:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: true,
        store: secondStore,
        harnesses: [fakeHarness],
      });

      assert.deepEqual((await secondLifecycle.scanDueWork()).startedRunIds, [
        "run_1",
      ]);
      assert.equal(fakeHarness.startRequests.length, 1);

      const detail = await secondLifecycle.openScheduleDetail(schedule.id);
      assert.deepEqual(detail.runCounter, { completed: 1, limit: null });
      assert.equal(detail.lastRunAt, "2026-07-07T17:00:00.000Z");
      assert.equal(detail.nextRunAt, "2026-07-07T18:00:00.000Z");

      secondStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("persists active and deferred run state in the SQLite local store across lifecycle restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");
    const idGenerator = new SequentialIdGenerator();

    try {
      let startAttempts = 0;
      const firstHarness = new FakeHarness({
        mode: "local-copilot",
        startResult: (request) => {
          startAttempts += 1;
          return startAttempts === 1
            ? {
                externalRunId: "sqlite-approval-waiting-run",
                status: "approval-waiting",
                completedAt: null,
                summary: "Waiting for approval.",
              }
            : {
                externalRunId: "unexpected-overlap",
                status: "completed",
                completedAt: request.requestedAt,
                summary: "This run should not overlap.",
              };
        },
      });
      const firstStore = new SqliteScheduleStore({ databasePath });
      const firstLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T16:05:00.000Z"),
        idGenerator,
        localSchedulingEnabled: true,
        store: firstStore,
        harnesses: [firstHarness],
      });
      const targetContext = {
        type: "workspace" as const,
        uri: "file:///tmp/agent-scheduler",
      };
      const firstSchedule = await firstLifecycle.createDraftSchedule({
        runInstructions: "Persist an approval-waiting run.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext,
        harnessMode: "local-copilot",
        model: "gpt-5-mini",
        approvalMode: "default-approvals",
      });
      const secondSchedule = await firstLifecycle.createDraftSchedule({
        runInstructions: "Persist one deferred catch-up run.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext,
        harnessMode: "local-copilot",
        model: "gpt-5-mini",
        approvalMode: "default-approvals",
      });
      await firstLifecycle.activateSchedule(firstSchedule.id);
      await firstLifecycle.activateSchedule(secondSchedule.id);

      const firstClock = new FakeClock("2026-07-07T17:00:00.000Z");
      const runLifecycle = new ScheduleLifecycle({
        clock: firstClock,
        idGenerator,
        localSchedulingEnabled: true,
        store: firstStore,
        harnesses: [firstHarness],
      });
      assert.deepEqual((await runLifecycle.scanDueWork()).startedRunIds, [
        "run_3",
      ]);
      firstStore.close();

      const secondHarness = new FakeHarness({ mode: "local-copilot" });
      const secondStore = new SqliteScheduleStore({ databasePath });
      const secondClock = new FakeClock("2026-07-07T17:10:00.000Z");
      const secondLifecycle = new ScheduleLifecycle({
        clock: secondClock,
        idGenerator,
        localSchedulingEnabled: true,
        store: secondStore,
        harnesses: [secondHarness],
      });

      assert.deepEqual((await secondLifecycle.scanDueWork()).startedRunIds, []);
      assert.equal(secondHarness.startRequests.length, 0);

      await secondLifecycle.resolveActiveRun("run_3", {
        status: "completed",
        summary: "Approved run completed after restart.",
      });
      assert.deepEqual((await secondLifecycle.scanDueWork()).startedRunIds, [
        "run_5",
      ]);

      const secondDetail = await secondLifecycle.openScheduleDetail(
        secondSchedule.id,
      );
      assert.equal(secondDetail.previousRuns[0]?.id, "run_5");
      assert.equal(secondDetail.previousRuns[0]?.status, "completed");
      assert.equal(secondDetail.previousRuns[1]?.id, "run_4");
      assert.equal(secondDetail.previousRuns[1]?.status, "deferred");
      assert.equal(
        secondDetail.previousRuns[1]?.completedAt,
        "2026-07-07T17:10:00.000Z",
      );

      secondStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("does not consider disabled draft schedules during automatic due work scans", async () => {
    const clock = new FakeClock("2026-07-07T19:00:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    await lifecycle.createDraftSchedule({
      runInstructions: "This draft should not run automatically.",
      cadence: { type: "cron", expression: "* * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    const dueScan = await lifecycle.scanDueWork();

    assert.deepEqual(dueScan.startedRunIds, []);
    assert.equal(fakeHarness.preflightRequests.length, 0);
    assert.equal(fakeHarness.startRequests.length, 0);
  });

  it("deletes schedules and run history while blocking deletion with active runs", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    let startAttempts = 0;
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        startAttempts += 1;
        return startAttempts === 1
          ? {
              externalRunId: "active-before-delete",
              status: "running",
              completedAt: null,
              summary: "Run is still active.",
            }
          : {
              externalRunId: "completed-before-delete",
              status: "completed",
              completedAt: request.requestedAt,
              summary: "Run completed before deletion.",
            };
      },
    });
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store,
      harnesses: [fakeHarness],
    });
    const draft = await lifecycle.createDraftSchedule({
      runInstructions: "Delete this draft.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const active = await lifecycle.createActiveSchedule({
      runInstructions: "Delete this active schedule.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const paused = await lifecycle.createActiveSchedule({
      runInstructions: "Delete this paused schedule.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const completed = await lifecycle.createActiveSchedule({
      runInstructions: "Delete this completed schedule and history.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });

    await lifecycle.pauseSchedule(paused.id);
    const runningRun = await lifecycle.startManualRun(active.id);
    await assert.rejects(
      () => lifecycle.deleteSchedule(active.id),
      /running or approval-waiting run/,
    );
    await lifecycle.resolveActiveRun(runningRun.id, {
      status: "completed",
      summary: "Resolved before deletion.",
    });

    clock.set("2026-07-07T16:10:00.000Z");
    await lifecycle.startManualRun(completed.id);
    assert.equal((await store.listRunHistory(completed.id)).length, 1);

    await lifecycle.deleteSchedule(draft.id);
    await lifecycle.deleteSchedule(active.id);
    await lifecycle.deleteSchedule(paused.id);
    await lifecycle.deleteSchedule(completed.id);

    assert.deepEqual(await lifecycle.listSchedules(), []);
    assert.deepEqual(await store.listRunHistory(completed.id), []);
    await assert.rejects(
      () => lifecycle.openScheduleDetail(draft.id),
      /Schedule 'schedule_1' was not found\./,
    );
    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
  });

  it("starts active schedules when their hourly cron cadence is due", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run when the top of the hour arrives.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    const activeSchedule = await lifecycle.activateSchedule(schedule.id);
    assert.equal(activeSchedule.status, "active");
    assert.equal(activeSchedule.enabled, true);
    assert.equal(activeSchedule.nextRunAt, "2026-07-07T17:00:00.000Z");

    clock.set("2026-07-07T16:59:59.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);
    assert.equal(fakeHarness.startRequests.length, 1);
    assert.equal(fakeHarness.startRequests[0]?.trigger, "automatic");

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.deepEqual(detail.runCounter, { completed: 1, limit: null });
    assert.equal(detail.lastRunAt, "2026-07-07T17:00:00.000Z");
    assert.equal(detail.nextRunAt, "2026-07-07T18:00:00.000Z");
  });

  it("counts manual runs on active schedules and completes finite run caps", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run manually until the cap is reached.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 2 },
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T16:10:00.000Z");
    const firstRun = await lifecycle.startManualRun(schedule.id);
    assert.equal(firstRun.trigger, "manual");

    const detailAfterFirstRun = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detailAfterFirstRun.schedule.status, "active");
    assert.equal(detailAfterFirstRun.schedule.enabled, true);
    assert.deepEqual(detailAfterFirstRun.runCounter, { completed: 1, limit: 2 });
    assert.equal(detailAfterFirstRun.nextRunAt, "2026-07-07T17:00:00.000Z");

    clock.set("2026-07-07T16:20:00.000Z");
    await lifecycle.startManualRun(schedule.id);

    const detailAfterSecondRun = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detailAfterSecondRun.schedule.status, "completed");
    assert.equal(detailAfterSecondRun.schedule.enabled, false);
    assert.deepEqual(detailAfterSecondRun.runCounter, { completed: 2, limit: 2 });
    assert.equal(detailAfterSecondRun.nextRunAt, null);
  });

  it("completes finite run caps reached by automatic due runs", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run automatically once.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.schedule.status, "completed");
    assert.equal(detail.schedule.enabled, false);
    assert.deepEqual(detail.runCounter, { completed: 1, limit: 1 });
    assert.equal(detail.nextRunAt, null);
  });

  it("records selected and executed models separately in run history", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const executedModels = ["claude-haiku-4.5", "gpt-5.1"];
    let runIndex = 0;
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        const executedModel = executedModels[runIndex] ?? "unknown-model";
        runIndex += 1;
        return {
          externalRunId: `model-run-${runIndex}`,
          status: "completed",
          completedAt: request.requestedAt,
          summary: `Ran with ${executedModel}.`,
          executedModel,
        };
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Run with the auto-selected model.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });

    await lifecycle.startManualRun(schedule.id);
    clock.set("2026-07-07T16:10:00.000Z");
    await lifecycle.startManualRun(schedule.id);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.deepEqual(
      detail.previousRuns.map((run) => run.model),
      ["auto", "auto"],
    );
    assert.deepEqual(
      detail.previousRuns.map((run) => run.executedModel),
      ["gpt-5.1", "claude-haiku-4.5"],
    );

    const historyDetail = await lifecycle.openRunHistoryDetail(
      detail.previousRuns[0]?.id ?? "",
    );
    assert.equal(historyDetail.selectedModel, "auto");
    assert.equal(historyDetail.executedModel, "gpt-5.1");
  });

  it("rejects manual runs after a finite run cap is completed until explicit restart", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Stop once the cap is complete.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T16:10:00.000Z");
    await lifecycle.startManualRun(schedule.id);

    clock.set("2026-07-07T16:20:00.000Z");
    await assert.rejects(
      () => lifecycle.startManualRun(schedule.id),
      /Manual Run Now is only available for draft or enabled schedules./,
    );
    assert.equal(fakeHarness.startRequests.length, 1);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.schedule.status, "completed");
    assert.deepEqual(detail.runCounter, { completed: 1, limit: 1 });
    assert.equal(detail.actions.restart.enabled, true);
    assert.equal(detail.actions.runNow.enabled, false);
  });

  it("rejects lifecycle transitions that would silently restart completed schedules", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Complete before invalid transitions are attempted.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T16:10:00.000Z");
    await lifecycle.startManualRun(schedule.id);

    await assert.rejects(
      () => lifecycle.resumeSchedule(schedule.id),
      /Only paused schedules can be resumed./,
    );
    await assert.rejects(
      () => lifecycle.activateSchedule(schedule.id),
      /Only draft schedules can be activated./,
    );
    await assert.rejects(
      () => lifecycle.pauseSchedule(schedule.id),
      /Only active schedules can be paused./,
    );

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.schedule.status, "completed");
    assert.equal(detail.schedule.enabled, false);
    assert.deepEqual(detail.runCounter, { completed: 1, limit: 1 });
    assert.equal(detail.nextRunAt, null);
  });

  it("resumes paused schedules from the resume time without replaying missed intervals", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run only after an explicit resume.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T16:30:00.000Z");
    const pausedSchedule = await lifecycle.pauseSchedule(schedule.id);
    assert.equal(pausedSchedule.status, "paused");
    assert.equal(pausedSchedule.enabled, false);
    assert.equal(pausedSchedule.nextRunAt, null);

    await assert.rejects(
      () => lifecycle.activateSchedule(schedule.id),
      /Only draft schedules can be activated./,
    );

    clock.set("2026-07-07T18:10:00.000Z");
    const resumedSchedule = await lifecycle.resumeSchedule(schedule.id);
    assert.equal(resumedSchedule.status, "active");
    assert.equal(resumedSchedule.enabled, true);
    assert.equal(resumedSchedule.nextRunAt, "2026-07-07T19:00:00.000Z");

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 0);

    clock.set("2026-07-07T19:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);
    assert.equal(fakeHarness.startRequests.length, 1);
  });

  it("coalesces missed custom cron due times into one catch-up run", async () => {
    const clock = new FakeClock("2026-07-07T08:50:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run on weekday quarter-hour checkpoints.",
      cadence: { type: "cron", expression: "15,45 9-17 * * 1-5" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    const activeSchedule = await lifecycle.activateSchedule(schedule.id);
    assert.equal(activeSchedule.nextRunAt, "2026-07-07T09:15:00.000Z");

    clock.set("2026-07-07T12:20:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);
    assert.equal(fakeHarness.startRequests.length, 1);

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 1);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.trigger, "automatic");
    assert.equal(detail.nextRunAt, "2026-07-07T12:45:00.000Z");
  });

  it("defers and coalesces automatic runs while a run slot is occupied", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => ({
        externalRunId: `approval-${request.schedule.id}`,
        status: "approval-waiting",
        completedAt: null,
        summary: "Waiting for user approval.",
      }),
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });
    const targetContext = {
      type: "workspace" as const,
      uri: "file:///tmp/agent-scheduler",
    };

    const firstSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Start first and wait for approval.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const secondSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Defer while the first run occupies the slot.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(firstSchedule.id);
    await lifecycle.activateSchedule(secondSchedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_3"]);
    assert.equal(fakeHarness.startRequests.length, 1);

    const firstDetail = await lifecycle.openScheduleDetail(firstSchedule.id);
    assert.equal(firstDetail.previousRuns[0]?.status, "approval-waiting");

    const secondDetail = await lifecycle.openScheduleDetail(secondSchedule.id);
    assert.equal(secondDetail.previousRuns.length, 1);
    assert.equal(secondDetail.previousRuns[0]?.status, "deferred");
    assert.equal(secondDetail.previousRuns[0]?.completedAt, null);
    assert.equal(
      secondDetail.previousRuns[0]?.error,
      "Run slot is occupied by an active run. AgentScheduler deferred this due run and will coalesce catch-up work for the schedule.",
    );

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 1);
    assert.equal(
      (await lifecycle.openScheduleDetail(secondSchedule.id)).previousRuns
        .length,
      1,
    );
  });

  it("keeps concurrent manual starts idempotent for the same schedule and blocks the Run Slot", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const slowHarness = new SlowStartHarness("local-copilot");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [slowHarness],
    });
    const targetContext = {
      type: "workspace" as const,
      uri: "file:///tmp/agent-scheduler",
    };
    const firstSchedule = await lifecycle.createActiveSchedule({
      runInstructions: "Start one manual run slowly.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const sameSlotSchedule = await lifecycle.createActiveSchedule({
      runInstructions: "Attempt another manual run in the same slot.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    const firstRunPromise = lifecycle.startManualRun(firstSchedule.id);
    await slowHarness.started;

    const sameScheduleRun = await lifecycle.startManualRun(firstSchedule.id);
    const sameSlotRun = await lifecycle.startManualRun(sameSlotSchedule.id);

    assert.equal(sameScheduleRun.status, "running");
    assert.equal(sameScheduleRun.scheduleId, firstSchedule.id);
    assert.equal(sameScheduleRun.summary, "Run is starting.");
    assert.equal(sameSlotRun.status, "blocked");
    assert.match(sameSlotRun.error ?? "", /Run slot is occupied/);
    assert.equal(slowHarness.startRequests.length, 1);

    slowHarness.finishStart();
    const firstRun = await firstRunPromise;

    assert.equal(firstRun.status, "completed");
    assert.equal(firstRun.id, sameScheduleRun.id);
    assert.equal(slowHarness.startRequests.length, 1);

    const firstDetail = await lifecycle.openScheduleDetail(firstSchedule.id);
    assert.equal(firstDetail.previousRuns.length, 1);
    assert.equal(firstDetail.previousRuns[0]?.status, "completed");

    const sameSlotDetail = await lifecycle.openScheduleDetail(sameSlotSchedule.id);
    assert.equal(sameSlotDetail.previousRuns.length, 1);
    assert.equal(sameSlotDetail.previousRuns[0]?.status, "blocked");
  });

  it("preserves schedule edits made while a manual Agent Run is active", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const slowHarness = new SlowStartHarness("local-copilot");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        slowHarness,
        new FakeHarness({ mode: "cloud-copilot" }),
      ],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Use the starting Schedule Revision.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 3 },
    });

    const runPromise = lifecycle.startManualRun(schedule.id);
    await slowHarness.started;
    const editedSchedule = await lifecycle.updateSchedule(schedule.id, {
      runInstructions: "Keep these future-run instructions.",
      cadence: { type: "cron", expression: "30 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler-next",
      },
      harnessMode: "cloud-copilot",
      model: "gpt-5.1",
      approvalMode: "bypass-approvals",
      runCap: { maxRuns: 5 },
    });

    slowHarness.finishStart();
    const run = await runPromise;
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.equal(run.scheduleRevision, schedule.revision);
    assert.equal(run.runInstructionsSnapshot, schedule.runInstructions);
    assert.equal(detail.schedule.revision, editedSchedule.revision);
    assert.equal(
      detail.schedule.runInstructions,
      "Keep these future-run instructions.",
    );
    assert.deepEqual(detail.schedule.cadence, {
      type: "cron",
      expression: "30 * * * *",
    });
    assert.deepEqual(detail.schedule.targetContext, {
      type: "workspace",
      uri: "file:///tmp/agent-scheduler-next",
    });
    assert.equal(detail.schedule.harnessMode, "cloud-copilot");
    assert.equal(detail.schedule.model, "gpt-5.1");
    assert.equal(detail.schedule.approvalMode, "bypass-approvals");
    assert.deepEqual(detail.schedule.runCounter, { completed: 1, limit: 5 });
  });

  it("rebases a Run Result when the Schedule Revision changes during commit", async () => {
    class ConcurrentEditStore extends InMemoryScheduleStore {
      private editPending = true;

      override async commitRunResult(
        entry: Parameters<InMemoryScheduleStore["commitRunResult"]>[0],
        scheduleUpdate: ScheduleRunStateUpdate,
      ): Promise<RunResultCommit> {
        if (this.editPending) {
          this.editPending = false;
          const schedule = await this.getSchedule(scheduleUpdate.scheduleId);
          assert.ok(schedule);
          await this.saveSchedule({
            ...schedule,
            revision: schedule.revision + 1,
            runInstructions: "Concurrent edit won the race.",
          });
        }
        return super.commitRunResult(entry, scheduleUpdate);
      }
    }

    const store = new ConcurrentEditStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Original instructions.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    await lifecycle.startManualRun(schedule.id);
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.equal(detail.schedule.revision, 2);
    assert.equal(
      detail.schedule.runInstructions,
      "Concurrent edit won the race.",
    );
    assert.deepEqual(detail.schedule.runCounter, { completed: 1, limit: null });
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.scheduleRevision, 1);
  });

  it("preserves a concurrent pause while committing a Run Result", async () => {
    class ConcurrentPauseStore extends InMemoryScheduleStore {
      private pausePending = true;

      override async commitRunResult(
        entry: Parameters<InMemoryScheduleStore["commitRunResult"]>[0],
        scheduleUpdate: ScheduleRunStateUpdate,
      ): Promise<RunResultCommit> {
        if (this.pausePending) {
          this.pausePending = false;
          const schedule = await this.getSchedule(scheduleUpdate.scheduleId);
          assert.ok(schedule);
          await this.saveSchedule({
            ...schedule,
            status: "paused",
            enabled: false,
            nextRunAt: null,
            updatedAt: "2026-07-07T16:06:00.000Z",
          });
        }
        return super.commitRunResult(entry, scheduleUpdate);
      }
    }

    const store = new ConcurrentPauseStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Do not undo a concurrent pause.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    await lifecycle.startManualRun(schedule.id);
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.equal(detail.schedule.status, "paused");
    assert.equal(detail.schedule.enabled, false);
    assert.equal(detail.schedule.nextRunAt, null);
    assert.deepEqual(detail.schedule.runCounter, { completed: 1, limit: null });
  });

  it("atomically completes a schedule whose edited run cap is already reached", async () => {
    class ConcurrentCapEditStore extends InMemoryScheduleStore {
      private editPending = false;

      armConcurrentEdit(): void {
        this.editPending = true;
      }

      override async commitRunResult(
        entry: Parameters<InMemoryScheduleStore["commitRunResult"]>[0],
        scheduleUpdate: ScheduleRunStateUpdate,
      ): Promise<RunResultCommit> {
        if (this.editPending) {
          this.editPending = false;
          const schedule = await this.getSchedule(scheduleUpdate.scheduleId);
          assert.ok(schedule);
          await this.saveSchedule({
            ...schedule,
            revision: schedule.revision + 1,
            runInstructions: "Preserve this concurrent cap edit.",
          });
        }
        return super.commitRunResult(entry, scheduleUpdate);
      }
    }

    const store = new ConcurrentCapEditStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Complete after the cap is lowered.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 2 },
    });
    await lifecycle.startManualRun(schedule.id);
    await lifecycle.updateSchedule(schedule.id, { runCap: { maxRuns: 1 } });
    store.armConcurrentEdit();

    const blockedRun = await lifecycle.startManualRun(schedule.id);
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.equal(blockedRun.status, "blocked");
    assert.equal(detail.schedule.status, "completed");
    assert.equal(detail.schedule.enabled, false);
    assert.equal(detail.schedule.nextRunAt, null);
    assert.equal(
      detail.schedule.runInstructions,
      "Preserve this concurrent cap edit.",
    );
    assert.deepEqual(detail.schedule.runCounter, { completed: 1, limit: 1 });
    assert.deepEqual(
      detail.previousRuns.map((run) => run.status),
      ["completed", "blocked"],
    );
  });

  it("uses the SQLite local store reservation to suppress duplicate Run Now starts across lifecycle instances", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const store = new SqliteScheduleStore({ databasePath });
      const slowHarness = new SlowStartHarness("local-copilot");
      const firstLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T16:05:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store,
        harnesses: [slowHarness],
      });
      const schedule = await firstLifecycle.createActiveSchedule({
        runInstructions: "Start one persisted manual run slowly.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/agent-scheduler",
        },
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
      });

      const firstRunPromise = firstLifecycle.startManualRun(schedule.id);
      await slowHarness.started;

      const secondLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T16:05:01.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store,
        harnesses: [slowHarness],
      });
      const duplicateRun = await secondLifecycle.startManualRun(schedule.id);

      assert.equal(duplicateRun.status, "running");
      assert.equal(slowHarness.startRequests.length, 1);

      slowHarness.finishStart();
      const completedRun = await firstRunPromise;

      assert.equal(completedRun.status, "completed");
      assert.equal(completedRun.id, duplicateRun.id);
      assert.equal(slowHarness.startRequests.length, 1);

      const detail = await secondLifecycle.openScheduleDetail(schedule.id);
      assert.equal(detail.previousRuns.length, 1);
      assert.equal(detail.previousRuns[0]?.id, completedRun.id);
      assert.equal(detail.previousRuns[0]?.status, "completed");

      store.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("applies a concurrent terminal Run Result only once", async () => {
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: (request) => ({
            externalRunId: "active-run",
            status: "running",
            completedAt: null,
            summary: `Running ${request.schedule.id}.`,
          }),
        }),
      ],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Complete exactly once.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 2 },
    });
    const activeRun = await lifecycle.startManualRun(schedule.id);

    await Promise.all([
      lifecycle.resolveActiveRun(activeRun.id, {
        status: "completed",
        summary: "First completion report.",
      }),
      lifecycle.resolveActiveRun(activeRun.id, {
        status: "completed",
        summary: "Duplicate completion report.",
      }),
    ]);
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.deepEqual(detail.runCounter, { completed: 1, limit: 2 });
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.status, "completed");
  });

  it("keeps approval-waiting runs active until they resolve, then starts deferred catch-up work", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    let startAttempts = 0;
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        startAttempts += 1;
        return startAttempts === 1
          ? {
              externalRunId: `approval-${request.schedule.id}`,
              status: "approval-waiting",
              completedAt: null,
              summary: "Waiting for user approval.",
            }
          : {
              externalRunId: `catch-up-${request.schedule.id}`,
              status: "completed",
              completedAt: request.requestedAt,
              summary: "Catch-up run completed.",
            };
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });
    const targetContext = {
      type: "workspace" as const,
      uri: "file:///tmp/agent-scheduler",
    };

    const firstSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Wait for approval before completing.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const secondSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run one catch-up after approval resolves.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(firstSchedule.id);
    await lifecycle.activateSchedule(secondSchedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_3"]);

    clock.set("2026-07-07T17:10:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 1);

    const resolvedRun = await lifecycle.resolveActiveRun("run_3", {
      status: "completed",
      summary: "Approved run completed.",
    });
    assert.equal(resolvedRun.status, "completed");
    assert.equal(resolvedRun.completedAt, "2026-07-07T17:10:00.000Z");

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_5"]);
    assert.equal(fakeHarness.startRequests.length, 2);

    const secondDetail = await lifecycle.openScheduleDetail(secondSchedule.id);
    assert.equal(secondDetail.previousRuns.length, 2);
    assert.equal(secondDetail.previousRuns[0]?.id, "run_5");
    assert.equal(secondDetail.previousRuns[0]?.status, "completed");
    assert.equal(secondDetail.previousRuns[1]?.id, "run_4");
    assert.equal(secondDetail.previousRuns[1]?.status, "deferred");
    assert.equal(
      secondDetail.previousRuns[1]?.completedAt,
      "2026-07-07T17:10:00.000Z",
    );
  });

  it("starts one same-schedule catch-up after an approval-waiting run spans its next due time", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    let startAttempts = 0;
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        startAttempts += 1;
        return startAttempts === 1
          ? {
              externalRunId: "approval-waiting-run",
              status: "approval-waiting",
              completedAt: null,
              summary: "Waiting for approval.",
            }
          : {
              externalRunId: "same-schedule-catch-up",
              status: "completed",
              completedAt: request.requestedAt,
              summary: "Same-schedule catch-up completed.",
            };
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Stay active long enough to miss the next interval.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);

    clock.set("2026-07-07T18:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(
      (await lifecycle.openScheduleDetail(schedule.id)).previousRuns.length,
      2,
    );

    clock.set("2026-07-07T18:10:00.000Z");
    await lifecycle.resolveActiveRun("run_2", {
      status: "completed",
      summary: "Approved run completed.",
    });

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_4"]);
    assert.equal(fakeHarness.startRequests.length, 2);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 3);
    assert.equal(detail.previousRuns[0]?.id, "run_4");
    assert.equal(detail.previousRuns[0]?.status, "completed");
    assert.equal(detail.previousRuns[1]?.id, "run_3");
    assert.equal(detail.previousRuns[1]?.status, "deferred");
    assert.equal(
      detail.previousRuns[1]?.completedAt,
      "2026-07-07T18:10:00.000Z",
    );
    assert.equal(detail.previousRuns[2]?.id, "run_2");
    assert.equal(detail.previousRuns[2]?.status, "completed");
  });

  it("records blocked preflight errors without falling back to another harness", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const localHarness = new FakeHarness({
      mode: "local-copilot",
      preflightResult: {
        status: "blocked",
        reason: "Local Copilot CLI is not authenticated.",
        resolvedHarnessPolicy: {
          harnessMode: "local-copilot",
          approvalMode: "default-approvals",
        },
      },
    });
    const cloudHarness = new FakeHarness({ mode: "cloud-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [localHarness, cloudHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Do not fall back when local Copilot is unavailable.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(localHarness.preflightRequests.length, 1);
    assert.equal(localHarness.startRequests.length, 0);
    assert.equal(cloudHarness.preflightRequests.length, 0);
    assert.equal(cloudHarness.startRequests.length, 0);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.status, "blocked");
    assert.equal(
      detail.previousRuns[0]?.error,
      "Local Copilot CLI is not authenticated.",
    );
    assert.deepEqual(detail.previousRuns[0]?.resolvedHarnessPolicy, {
      harnessMode: "local-copilot",
      approvalMode: "default-approvals",
    });

    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    const detailAfterImmediateRescan = await lifecycle.openScheduleDetail(
      schedule.id,
    );
    assert.equal(detailAfterImmediateRescan.previousRuns.length, 1);
    assert.equal(
      detailAfterImmediateRescan.nextRunAt,
      "2026-07-07T18:00:00.000Z",
    );
  });

  it("advances delayed failed automatic runs beyond the current time", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const harness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        clock.set("2026-07-07T17:35:00.000Z");
        return {
          externalRunId: "failed-automatic-run",
          status: "failed",
          completedAt: request.requestedAt,
          summary: "The harness failed this occurrence.",
        };
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [harness],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Retry on the next Run Cadence.",
      cadence: { type: "cron", expression: "*/5 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "bypass-approvals",
    });

    clock.set("2026-07-07T17:00:00.000Z");
    await lifecycle.scanDueWork();
    await lifecycle.scanDueWork();
    const detail = await lifecycle.openScheduleDetail(schedule.id);

    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.status, "failed");
    assert.equal(detail.nextRunAt, "2026-07-07T17:40:00.000Z");
  });

  it("records unexpected harness start errors against the reserved run", async () => {
    const store = new InMemoryScheduleStore();
    const throwingHarness = new ThrowingStartHarness("local-copilot");
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [throwingHarness],
    });

    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Exercise a throwing harness start.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    await assert.rejects(
      () => lifecycle.startManualRun(schedule.id),
      /Harness start crashed./,
    );

    assert.equal(throwingHarness.startRequests.length, 1);
    assert.equal((await store.listActiveRuns()).length, 0);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.id, "run_2");
    assert.equal(detail.previousRuns[0]?.status, "failed");
    assert.equal(detail.previousRuns[0]?.completedAt, "2026-07-07T16:05:00.000Z");
    assert.equal(detail.previousRuns[0]?.error, "Harness start crashed.");
  });

  it("starts manual Local Copilot Mode runs through the Copilot CLI client", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: {
            data: {
              content: [{ type: "text", text: "Manual CLI run completed." }],
            },
          },
        }),
        JSON.stringify({
          type: "result",
          sessionId: "manual-cli-session",
          exitCode: 0,
        }),
      ].join("\n"),
      stderr: "",
    });
    const harness = new CopilotLocalHarness({
      client: new CopilotCliLocalClient({
        command: "/custom/copilot",
        runner,
        cachedAvailability: {
          status: "available",
          approvalSurfaceAvailable: false,
          supportedPermissionFlags: ["--no-ask-user", "--allow-all-tools"],
        },
      }),
    });
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [harness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run the concrete Copilot CLI client.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });

    const run = await lifecycle.startManualRun(schedule.id);

    assert.equal(run.status, "completed");
    assert.equal(run.externalRunId, "manual-cli-session");
    assert.equal(run.summary, "Manual CLI run completed.");
    assert.deepEqual(run.resolvedHarnessPolicy, {
      provider: "copilot",
      harnessMode: "local-copilot",
      approvalMode: "bypass-approvals",
      approvalModeLabel: "Bypass Approvals",
      localCopilotMode: {
        approvalPreset: "bypass",
        permissionBehavior: "bypasses-approval-prompts",
        cli: {
          promptFlag: "-p",
          outputFormat: "json",
          permissionFlags: ["--no-ask-user", "--allow-all-tools"],
        },
        requiresApprovalSurface: false,
        unattended: false,
      },
    });
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.command, "/custom/copilot");
    assert.deepEqual(runner.calls[0]?.args.slice(0, -1), [
      "-C",
      "/tmp/agent-scheduler",
      "--output-format",
      "json",
      "--no-color",
      "--no-ask-user",
      "--allow-all-tools",
      "-p",
    ]);
    assert.equal(runner.calls[0]?.options?.timeoutMs, 1_800_000);
    assert.match(
      runner.calls[0]?.args.at(-1) ?? "",
      /AgentScheduler execution frame/,
    );
    assert.match(
      runner.calls[0]?.args.at(-1) ?? "",
      /Run the concrete Copilot CLI client\./,
    );
  });

  it("completes a default draft Run Now through the interactive Copilot approval surface", async () => {
    const interactiveExecutor: CopilotInteractiveExecutor = {
      run: async (_command, _args, request) => ({
        externalRunId: "vscode-task:manual-default",
        status: "completed",
        completedAt: request.requestedAt,
        summary: "Interactive Copilot task completed.",
        executedModel: null,
      }),
    };
    const harness = new CopilotLocalHarness({
      client: new CopilotCliLocalClient({
        command: "/custom/copilot",
        runner: new RecordingCopilotCliCommandRunner({
          exitCode: 0,
          stdout: "GitHub Copilot CLI 1.0.25",
          stderr: "",
        }),
        interactiveExecutor,
      }),
    });
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [harness],
    });
    const editor = new EditorControlSurface(lifecycle);
    assert.deepEqual(await editor.listHarnessModels("local-copilot"), [
      { id: "auto", displayName: "Auto", vendor: "GitHub Copilot" },
    ]);
    const detail = await editor.createDraftSchedule({
      runInstructions: "Review the workspace with user-approved tools.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/agent-scheduler" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });

    const run = await editor.runScheduleNow(detail.schedule.id);

    assert.equal(run.status, "completed");
    assert.equal(run.externalRunId, "vscode-task:manual-default");
    assert.equal(run.approvalModeSnapshot, "default-approvals");
  });

  it("refreshes repaired Local Copilot availability in an existing Schedule Detail", async () => {
    const runner = new RecordingCopilotCliCommandRunner([
      { exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" },
      { exitCode: 0, stdout: "GitHub Copilot CLI 1.0.25", stderr: "" },
    ]);
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new CopilotLocalHarness({
          client: new CopilotCliLocalClient({ command: "/custom/copilot", runner }),
        }),
      ],
    });
    const editor = new EditorControlSurface(lifecycle);
    const created = await editor.createDraftSchedule({
      runInstructions: "Review the repaired workspace.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/agent-scheduler" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });

    assert.equal(created.harnessAvailability.selected?.available, false);
    const repaired = await editor.openScheduleDetail(created.schedule.id);
    assert.equal(repaired.harnessAvailability.selected?.available, true);
    assert.match(repaired.harnessAvailability.message, /available/);
  });

  it("keeps concurrent schedule policy readiness isolated per Schedule Detail", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new CopilotLocalHarness({
          client: new CopilotCliLocalClient({
            command: "/custom/copilot",
            runner: new RecordingCopilotCliCommandRunner({
              exitCode: 0,
              stdout: "GitHub Copilot CLI 1.0.25",
              stderr: "",
            }),
            interactiveExecutor: {
              run: async (_command, _args, request) => ({
                externalRunId: "unused",
                status: "completed",
                completedAt: request.requestedAt,
                summary: null,
              }),
            },
          }),
        }),
      ],
    });
    const defaultSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Use user-approved tools.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/default" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });
    const bypassSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run with bypass approvals.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/bypass" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });

    const [defaultDetail, bypassDetail] = await Promise.all([
      lifecycle.openScheduleDetail(defaultSchedule.id),
      lifecycle.openScheduleDetail(bypassSchedule.id),
    ]);

    assert.equal(defaultDetail.harnessAvailability.selected?.manualRunReady, true);
    assert.equal(
      defaultDetail.harnessAvailability.selected?.unattendedRunReady,
      false,
    );
    assert.equal(bypassDetail.harnessAvailability.selected?.manualRunReady, true);
    assert.equal(
      bypassDetail.harnessAvailability.selected?.unattendedRunReady,
      true,
    );
  });

  it("blocks activation when a registered harness reports itself unavailable", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          availability: {
            mode: "local-copilot",
            label: "Local Copilot Mode",
            available: false,
            reason:
              "GitHub Copilot CLI was not found. Install GitHub Copilot CLI, or run `gh copilot` to download it through GitHub CLI, then ensure `copilot` is on PATH.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Try to activate without Copilot CLI.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "bypass-approvals",
    });

    await assert.rejects(
      () => lifecycle.activateSchedule(schedule.id),
      /GitHub Copilot CLI was not found/,
    );

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.harnessAvailability.selected?.available, false);
    assert.match(
      detail.harnessAvailability.message,
      /GitHub Copilot CLI was not found/,
    );
  });

  it("records requires-approval preflight outcomes as approval-waiting active runs", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      preflightResult: {
        status: "requires-approval",
        reason: "Approval is waiting in VS Code.",
        resolvedHarnessPolicy: {
          harnessMode: "local-copilot",
          approvalMode: "default-approvals",
        },
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Wait for approval before starting.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, ["run_2"]);
    assert.equal(fakeHarness.startRequests.length, 0);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns[0]?.status, "approval-waiting");
    assert.equal(
      detail.previousRuns[0]?.summary,
      "Approval is waiting in VS Code.",
    );
    assert.equal(detail.previousRuns[0]?.completedAt, null);
  });

  it("coalesces deferred preflight outcomes into one pending deferred run", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      preflightResult: {
        status: "deferred",
        reason: "Harness is temporarily busy.",
        resolvedHarnessPolicy: {
          harnessMode: "local-copilot",
          approvalMode: "default-approvals",
        },
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Defer when preflight asks the scheduler to wait.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.preflightRequests.length, 2);
    assert.equal(fakeHarness.startRequests.length, 0);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.status, "deferred");
    assert.equal(detail.previousRuns[0]?.error, "Harness is temporarily busy.");
    assert.equal(detail.previousRuns[0]?.completedAt, null);
  });

  it("keeps the idle due scan path to one local due query under 50 ms", async () => {
    class InstrumentedStore extends InMemoryScheduleStore {
      dueQueries = 0;

      override async listDueSchedules(now: string): Promise<Schedule[]> {
        this.dueQueries += 1;
        return super.listDueSchedules(now);
      }
    }

    const store = new InstrumentedStore();
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store,
      harnesses: [fakeHarness],
    });

    const startedAt = performance.now();
    const dueScan = await lifecycle.scanDueWork();
    const elapsedMs = performance.now() - startedAt;

    assert.deepEqual(dueScan.startedRunIds, []);
    assert.equal(store.dueQueries, 1);
    assert.equal(fakeHarness.preflightRequests.length, 0);
    assert.equal(fakeHarness.startRequests.length, 0);
    assert.ok(
      elapsedMs < 50,
      `Expected idle due scan to finish under 50 ms, took ${elapsedMs} ms.`,
    );
  });

  it("reconciles a legacy active reservation while Local Scheduling is disabled", async () => {
    const clock = new FakeClock("2026-07-07T16:00:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "worker:first",
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "legacy-process",
            status: "running",
            completedAt: null,
            summary: "Legacy process started.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Leave a legacy active reservation.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/legacy" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });
    const run = await lifecycle.startManualRun(schedule.id);
    await store.deleteLocalRunExecution(run.id);

    clock.set("2026-07-07T16:03:00.000Z");
    await lifecycle.scanDueWork();

    const recovered = await store.getRunHistoryEntry(run.id);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.completedAt, "2026-07-07T16:03:00.000Z");
    assert.match(recovered?.error ?? "", /no recoverable execution identity/);
  });

  it("keeps a heartbeating execution active and recovers it after its lease expires", async () => {
    const clock = new FakeClock("2026-07-07T16:00:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "worker:first",
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "process:123",
            status: "running",
            completedAt: null,
            summary: "Process is running.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run longer than one heartbeat.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/lease" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });
    const run = await lifecycle.startManualRun(schedule.id);
    const execution = await store.getLocalRunExecution(run.id);
    assert.match(execution?.identity ?? "", /^execution:/);
    assert.equal(execution?.handle, "process:123");

    await store.saveLocalRunExecution({
      ...execution!,
      capabilities: { ...execution!.capabilities, heartbeat: true },
      heartbeatAt: "2026-07-07T16:01:30.000Z",
      leaseExpiresAt: "2026-07-07T16:03:30.000Z",
    });
    clock.set("2026-07-07T16:03:00.000Z");
    await lifecycle.scanDueWork();
    assert.equal((await store.getRunHistoryEntry(run.id))?.status, "running");

    clock.set("2026-07-07T16:03:31.000Z");
    await lifecycle.scanDueWork();
    const recovered = await store.getRunHistoryEntry(run.id);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /lease expired/);
  });

  it("does not recover an execution whose heartbeat renews between read and claim", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "worker:owner",
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "process:heartbeat-race",
            status: "running",
            completedAt: null,
            summary: "Running.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Renew before recovery claim.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/heartbeat-race" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });
    const run = await lifecycle.startManualRun(schedule.id);
    const observed = (await store.getLocalRunExecution(run.id))!;
    await store.saveLocalRunExecution({
      ...observed,
      capabilities: { ...observed.capabilities, heartbeat: true },
      leaseExpiresAt: "2026-07-07T16:04:59.000Z",
    });
    const stale = (await store.getLocalRunExecution(run.id))!;
    assert.equal(
      await store.heartbeatLocalRunExecution(
        run.id,
        "worker:owner",
        "2026-07-07T16:05:00.000Z",
        "2026-07-07T16:07:00.000Z",
      ),
      true,
    );

    assert.equal(
      await store.claimExpiredExecution({
        runId: run.id,
        observedHeartbeatAt: stale.heartbeatAt,
        observedLeaseExpiresAt: stale.leaseExpiresAt,
        claimedAt: "2026-07-07T16:05:00.000Z",
      }),
      false,
    );
    assert.equal((await store.getRunHistoryEntry(run.id))?.status, "running");
  });

  it("recovers after a recovery worker crashes between claim and terminalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduler-claim-crash-"));
    const databasePath = join(directory, "schedules.sqlite");
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const crashedStore = new SqliteScheduleStore({ databasePath });
    const crashedWorker = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "worker:crashed",
      localSchedulingEnabled: false,
      store: crashedStore,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "process:crashed-reconciler",
            status: "running",
            completedAt: null,
            summary: "Process is running.",
          },
        }),
      ],
    });
    let replacementStore: SqliteScheduleStore | undefined;
    let crashedStoreOpen = true;
    try {
      const schedule = await crashedWorker.createDraftSchedule({
        runInstructions: "Recover after a crashed recovery worker.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: {
          type: "workspace",
          uri: "file:///tmp/recovery-crash",
        },
        harnessMode: "local-copilot",
        model: "auto",
        approvalMode: "bypass-approvals",
      });
      const run = await crashedWorker.startManualRun(schedule.id);
      const execution = (await crashedStore.getLocalRunExecution(run.id))!;
      await crashedStore.saveLocalRunExecution({
        ...execution,
        capabilities: { ...execution.capabilities, heartbeat: true },
        leaseExpiresAt: "2026-07-07T16:04:59.000Z",
      });
      assert.equal(
        await crashedStore.claimExpiredExecution({
          runId: run.id,
          observedHeartbeatAt: execution.heartbeatAt,
          observedLeaseExpiresAt: "2026-07-07T16:04:59.000Z",
          claimedAt: "2026-07-07T16:05:00.000Z",
        }),
        true,
      );
      crashedStore.close();
      crashedStoreOpen = false;

      replacementStore = new SqliteScheduleStore({ databasePath });
      const replacementWorker = new ScheduleLifecycle({
        clock,
        executionOwnerId: "worker:replacement",
        localSchedulingEnabled: false,
        store: replacementStore,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      clock.set("2026-07-07T16:06:59.000Z");
      await replacementWorker.scanDueWork();
      assert.equal(
        (await replacementStore.getRunHistoryEntry(run.id))?.status,
        "running",
      );

      clock.set("2026-07-07T16:07:00.000Z");
      await replacementWorker.scanDueWork();
      const recovered = await replacementStore.getRunHistoryEntry(run.id);
      assert.equal(recovered?.status, "failed");
      assert.match(recovered?.error ?? "", /lease expired/);
    } finally {
      replacementStore?.close();
      if (crashedStoreOpen) {
        crashedStore.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies one terminal recovery when two reconcilers claim the same expired lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduler-reconcile-"));
    const databasePath = join(directory, "schedules.sqlite");
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const firstStore = new SqliteScheduleStore({ databasePath });
    const secondStore = new SqliteScheduleStore({ databasePath });
    const harness = new FakeHarness({
      mode: "local-copilot",
      startResult: {
        externalRunId: "process:race",
        status: "running",
        completedAt: null,
        summary: "Process is running.",
      },
    });
    const first = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "worker:first",
      localSchedulingEnabled: false,
      store: firstStore,
      harnesses: [harness],
    });
    try {
      const schedule = await first.createDraftSchedule({
        runInstructions: "Recover once.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: { type: "workspace", uri: "file:///tmp/race" },
        harnessMode: "local-copilot",
        model: "auto",
        approvalMode: "bypass-approvals",
      });
      const run = await first.startManualRun(schedule.id);
      const execution = (await firstStore.getLocalRunExecution(run.id))!;
      await firstStore.saveLocalRunExecution({
        ...execution,
        capabilities: { ...execution.capabilities, heartbeat: true },
        leaseExpiresAt: "2026-07-07T16:04:59.000Z",
      });
      const second = new ScheduleLifecycle({
        clock,
        executionOwnerId: "worker:second",
        localSchedulingEnabled: false,
        store: secondStore,
        harnesses: [harness],
      });

      await Promise.all([first.scanDueWork(), second.scanDueWork()]);

      const history = await firstStore.listRunHistory(schedule.id);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.status, "failed");
      assert.equal(history[0]?.completedAt, "2026-07-07T16:05:00.000Z");
    } finally {
      firstStore.close();
      secondStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces execution identity and supported cancellation in Run History Detail", async () => {
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "extension:current",
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "vscode-task:active",
            status: "running",
            completedAt: null,
            summary: "Interactive task is running.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Wait for user-approved work.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/cancel" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });
    const run = await lifecycle.startManualRun(schedule.id);

    const detail = await lifecycle.openRunHistoryDetail(run.id);
    assert.match(detail.execution?.identity ?? "", /^execution:/);
    assert.equal(detail.execution?.handle, "vscode-task:active");
    assert.equal(detail.actions.cancel.enabled, true);

    const restartedLifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      executionOwnerId: "extension:restarted",
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const restartedDetail = await restartedLifecycle.openRunHistoryDetail(run.id);
    assert.equal(restartedDetail.actions.cancel.enabled, false);
    assert.match(
      restartedDetail.actions.cancel.disabledReason ?? "",
      /unsupported from this process/,
    );

    const canceled = await lifecycle.cancelRun(run.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.completedAt, "2026-07-07T16:00:00.000Z");
  });

  it("persists a cancellation request while waiting for execution shutdown", async () => {
    class TimedOutCancellationHarness extends FakeHarness {
      override async cancel(
        _request: HarnessCancelRequest,
      ): Promise<HarnessCancelResult> {
        throw new Error("Timed out waiting for the task to end.");
      }
    }
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "extension:current",
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new TimedOutCancellationHarness({
          mode: "local-copilot",
          startResult: {
            externalRunId: "vscode-task:active",
            status: "running",
            completedAt: null,
            summary: "Interactive task is running.",
          },
        }),
      ],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Wait for shutdown confirmation.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/cancel-timeout" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });
    const run = await lifecycle.startManualRun(schedule.id);

    await assert.rejects(
      lifecycle.cancelRun(run.id),
      /Timed out waiting for the task to end/,
    );

    assert.equal(
      (await store.getLocalRunExecution(run.id))?.cancellationRequestedAt,
      "2026-07-07T16:00:00.000Z",
    );
    assert.equal((await store.getRunHistoryEntry(run.id))?.status, "running");
    const detail = await lifecycle.openRunHistoryDetail(run.id);
    assert.equal(detail.actions.cancel.enabled, false);
    assert.match(detail.actions.cancel.disabledReason ?? "", /waiting.*exit/i);
  });

  it("persists execution identity before completion so an active run can be canceled", async () => {
    let release!: () => void;
    let started!: () => void;
    const startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    class GatedExecutionHarness extends FakeHarness {
      override async start(
        request: HarnessStartRequest,
        observer?: HarnessExecutionObserver,
      ): Promise<HarnessStartResult> {
        await observer?.started({
          identity: "process:456",
          capabilities: { cancel: true, open: true, heartbeat: true },
        });
        started();
        await startGate;
        return {
          externalRunId: "copilot-session-after-completion",
          status: "completed",
          completedAt: request.requestedAt,
          summary: "Process completed.",
        };
      }
    }
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      executionOwnerId: "extension:current",
      localSchedulingEnabled: false,
      store,
      harnesses: [new GatedExecutionHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Start a controllable process.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/identity" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });

    const startPromise = lifecycle.startManualRun(schedule.id);
    await executionStarted;
    const active = (await store.listRunHistory(schedule.id))[0]!;
    assert.match(active.externalRunId ?? "", /^execution:/);
    assert.equal(
      (await store.getLocalRunExecution(active.id))?.handle,
      "process:456",
    );
    assert.equal(
      (await lifecycle.openRunHistoryDetail(active.id)).actions.cancel.enabled,
      true,
    );
    await lifecycle.cancelRun(active.id);
    release();
    assert.equal((await startPromise).status, "canceled");
    assert.equal((await store.getRunHistoryEntry(active.id))?.status, "canceled");
  });
});

class RecordingCopilotCliCommandRunner implements CopilotCliCommandRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    options: CopilotCliCommandRunOptions | undefined;
  }> = [];

  private readonly results: CopilotCliCommandResult[];

  constructor(result: CopilotCliCommandResult | CopilotCliCommandResult[]) {
    this.results = Array.isArray(result) ? result : [result];
  }

  async run(
    command: string,
    args: readonly string[],
    options?: CopilotCliCommandRunOptions,
  ): Promise<CopilotCliCommandResult> {
    this.calls.push({ command, args: [...args], options });
    const result = this.results[Math.min(this.calls.length - 1, this.results.length - 1)];
    if (!result) {
      throw new Error("RecordingCopilotCliCommandRunner has no result.");
    }
    return structuredClone(result);
  }
}

class SlowStartHarness extends FakeHarness {
  readonly started: Promise<void>;
  private resolveStarted: (() => void) | undefined;
  private releaseStart: (() => void) | undefined;
  private readonly startGate: Promise<void>;

  constructor(mode: HarnessMode) {
    super({ mode });
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.startGate = new Promise((resolve) => {
      this.releaseStart = resolve;
    });
  }

  override async start(
    request: HarnessStartRequest,
  ): Promise<HarnessStartResult> {
    this.startRequests.push(structuredClone(request));
    this.resolveStarted?.();
    await this.startGate;

    return {
      externalRunId: `slow-run-${this.startRequests.length}`,
      status: "completed",
      completedAt: request.requestedAt,
      summary: "Slow harness completed the manual run.",
    };
  }

  finishStart(): void {
    this.releaseStart?.();
  }
}

class ThrowingStartHarness extends FakeHarness {
  constructor(mode: HarnessMode) {
    super({ mode });
  }

  override async start(
    request: HarnessStartRequest,
  ): Promise<HarnessStartResult> {
    this.startRequests.push(structuredClone(request));
    throw new Error("Harness start crashed.");
  }
}

describe("VS Code natural-language schedule creation", () => {
  it("activates a complete request after one confirmation with VS Code defaults", async () => {
    const clock = new FakeClock("2026-07-07T20:00:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const workspace = {
      type: "workspace" as const,
      uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      label: "AgentScheduler",
    };
    const confirmationRequests: unknown[] = [];
    const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
      lifecycle,
      currentWorkspace: workspace,
      defaultModel: "gpt-5",
      confirmActivation: async (proposal) => {
        confirmationRequests.push(proposal);
        return true;
      },
    });

    assert.equal(
      creationFlow.languageModelTool.name,
      "agentScheduler.createSchedule",
    );

    const result = await creationFlow.languageModelTool.invoke({
      naturalLanguageRequest: "run every hour to review bug branches",
      runCap: { maxRuns: 5 },
    });

    assert.equal(result.source, "language-model-tool");
    assert.equal(result.outcome, "activated");
    assert.deepEqual(result.validationMessages, []);
    assert.equal(confirmationRequests.length, 1);
    assert.deepEqual(confirmationRequests[0], {
      runInstructions: "Review bug branches.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: workspace,
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 5 },
    });

    assert.equal(result.schedule.status, "active");
    assert.equal(result.schedule.enabled, true);
    assert.equal(result.schedule.runInstructions, "Review bug branches.");
    assert.deepEqual(result.schedule.cadence, {
      type: "cron",
      expression: "0 * * * *",
    });
    assert.deepEqual(result.schedule.targetContext, workspace);
    assert.equal(result.schedule.harnessMode, "local-copilot");
    assert.equal(result.schedule.model, "gpt-5");
    assert.equal(result.schedule.approvalMode, "default-approvals");
    assert.deepEqual(result.schedule.runCounter, { completed: 0, limit: 5 });

    const editor = new EditorControlSurface(lifecycle);
    const detail = await editor.openScheduleDetail(result.schedule.id);
    assert.equal(detail.schedule.status, "active");
    assert.equal(detail.schedule.enabled, true);
  });

  it("honors explicit Cloud Copilot Mode requests during natural-language creation", async () => {
    const clock = new FakeClock("2026-07-07T20:30:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new FakeHarness({ mode: "local-copilot" }),
        new FakeHarness({ mode: "cloud-copilot" }),
      ],
    });
    const workspace = {
      type: "workspace" as const,
      uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      label: "AgentScheduler",
    };
    const confirmationRequests: unknown[] = [];
    const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
      lifecycle,
      currentWorkspace: workspace,
      defaultModel: "gpt-5",
      confirmActivation: async (proposal) => {
        confirmationRequests.push(proposal);
        return true;
      },
    });

    const result = await creationFlow.invokeLanguageModelTool({
      naturalLanguageRequest:
        "run every hour in Cloud Copilot Mode to review release branches",
    });

    assert.equal(result.outcome, "activated");
    assert.deepEqual(result.validationMessages, []);
    assert.deepEqual(confirmationRequests[0], {
      runInstructions: "Review release branches.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: workspace,
      harnessMode: "cloud-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    assert.equal(result.schedule.harnessMode, "cloud-copilot");
  });

  it("derives single-run instructions from recurrence phrasing across creation entry points", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T20:45:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const workspace = {
      type: "workspace" as const,
      uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      label: "AgentScheduler",
    };
    const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
      lifecycle,
      currentWorkspace: workspace,
      defaultModel: "gpt-5",
      confirmActivation: async () => true,
    });

    const toolResult = await creationFlow.languageModelTool.invoke({
      naturalLanguageRequest: "Run every hour and check the current time",
    });
    const chatResult = await creationFlow.chatParticipant.handleRequest({
      naturalLanguageRequest: "hourly to check open pull requests",
    });
    const slashResult = await creationFlow.slashCommand.execute({
      naturalLanguageRequest: "run every 15 minutes and summarize CI status",
    });
    const explicitInstructionsResult =
      await creationFlow.languageModelTool.invoke({
        naturalLanguageRequest: "Create an hourly status check schedule.",
        runInstructions: "Run every hour and check the current time",
        cadence: { type: "cron", expression: "0 * * * *" },
      });

    assert.equal(toolResult.outcome, "activated");
    assert.deepEqual(toolResult.schedule.cadence, {
      type: "cron",
      expression: "0 * * * *",
    });
    assert.equal(toolResult.schedule.runInstructions, "Check the current time.");

    assert.equal(chatResult.outcome, "activated");
    assert.deepEqual(chatResult.schedule.cadence, {
      type: "cron",
      expression: "0 * * * *",
    });
    assert.equal(chatResult.schedule.runInstructions, "Check open pull requests.");

    assert.equal(slashResult.outcome, "activated");
    assert.deepEqual(slashResult.schedule.cadence, {
      type: "cron",
      expression: "*/15 * * * *",
    });
    assert.equal(slashResult.schedule.runInstructions, "Summarize CI status.");

    assert.equal(explicitInstructionsResult.outcome, "activated");
    assert.equal(
      explicitInstructionsResult.schedule.runInstructions,
      "Check the current time.",
    );

    for (const result of [
      toolResult,
      chatResult,
      slashResult,
      explicitInstructionsResult,
    ]) {
      assert.doesNotMatch(result.schedule.runInstructions, /every hour/i);
      assert.doesNotMatch(result.schedule.runInstructions, /hourly/i);
      assert.doesNotMatch(result.schedule.runInstructions, /every \d+ minutes/i);
      assert.doesNotMatch(result.schedule.runInstructions, /scheduled task/i);
    }
  });

  it("creates a disabled draft with validation messages when activation requirements are missing", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T21:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    let confirmationRequests = 0;
    const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
      lifecycle,
      defaultModel: "gpt-5",
      confirmActivation: async () => {
        confirmationRequests += 1;
        return true;
      },
    });

    const result = await creationFlow.invokeLanguageModelTool({
      naturalLanguageRequest: "review bug branches",
    });

    assert.equal(result.source, "language-model-tool");
    assert.equal(result.outcome, "draft");
    assert.deepEqual(result.validationMessages, [
      "Run cadence is required before activation.",
      "Target context is required before activation.",
    ]);
    assert.equal(confirmationRequests, 0);
    assert.equal(result.schedule.status, "draft");
    assert.equal(result.schedule.enabled, false);
    assert.equal(result.schedule.runInstructions, "Review bug branches.");
    assert.equal(result.schedule.cadence, null);
    assert.equal(result.schedule.targetContext, null);
    assert.equal(result.schedule.harnessMode, "local-copilot");
    assert.equal(result.schedule.approvalMode, "default-approvals");
    assert.equal(result.schedule.nextRunAt, null);
  });

  it("routes chat and slash-command fallback entry points through the same creation flow", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T22:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new FakeHarness({ mode: "local-copilot" }),
        new FakeHarness({ mode: "cloud-copilot" }),
      ],
    });
    const workspace = {
      type: "workspace" as const,
      uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      label: "AgentScheduler",
    };
    const confirmationRequests: unknown[] = [];
    const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
      lifecycle,
      currentWorkspace: workspace,
      defaultModel: "gpt-5",
      confirmActivation: async (proposal) => {
        confirmationRequests.push(proposal);
        return true;
      },
    });

    assert.equal(creationFlow.chatParticipant.id, "agentScheduler.schedule");
    const chatResult = await creationFlow.chatParticipant.handleRequest({
      naturalLanguageRequest: "create a cloud schedule",
      runInstructions: "Review cloud Copilot agent branches.",
      cadence: { type: "cron", expression: "*/30 * * * *" },
      targetContext: workspace,
      harnessMode: "cloud-copilot",
      model: "gpt-5-mini",
      approvalMode: "bypass-approvals",
      runCap: { maxRuns: 2 },
    });

    assert.equal(chatResult.source, "chat-participant");
    assert.equal(chatResult.outcome, "activated");
    assert.equal(chatResult.schedule.harnessMode, "cloud-copilot");
    assert.equal(chatResult.schedule.model, "gpt-5-mini");
    assert.equal(chatResult.schedule.approvalMode, "bypass-approvals");
    assert.deepEqual(chatResult.schedule.runCounter, { completed: 0, limit: 2 });

    assert.equal(
      creationFlow.slashCommand.command,
      "agentScheduler.createSchedule",
    );
    const slashResult = await creationFlow.slashCommand.execute({
      naturalLanguageRequest: "run every hour to delete stale release branches",
    });

    assert.equal(slashResult.source, "slash-command");
    assert.equal(slashResult.outcome, "draft");
    assert.deepEqual(slashResult.validationMessages, [
      "Request includes potentially destructive work and must be reviewed before automatic recurrence.",
    ]);
    assert.equal(slashResult.schedule.status, "draft");
    assert.equal(slashResult.schedule.enabled, false);
    assert.equal(slashResult.schedule.harnessMode, "local-copilot");
    assert.equal(slashResult.schedule.approvalMode, "default-approvals");
    assert.equal(confirmationRequests.length, 1);
  });

  it("persists incomplete natural-language drafts without placeholder activation fields", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const store = new SqliteScheduleStore({ databasePath });
      const lifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-07T23:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      const creationFlow = new VsCodeNaturalLanguageScheduleCreationFlow({
        lifecycle,
        defaultModel: "gpt-5",
        confirmActivation: async () => true,
      });

      const result = await creationFlow.languageModelTool.invoke({
        naturalLanguageRequest: "review bug branches",
      });
      store.close();

      const reopenedStore = new SqliteScheduleStore({ databasePath });
      const reopenedLifecycle = new ScheduleLifecycle({
        clock: new FakeClock("2026-07-08T00:00:00.000Z"),
        idGenerator: new SequentialIdGenerator(),
        localSchedulingEnabled: false,
        store: reopenedStore,
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      });
      const detail = await reopenedLifecycle.openScheduleDetail(result.schedule.id);

      assert.equal(detail.schedule.status, "draft");
      assert.equal(detail.schedule.enabled, false);
      assert.equal(detail.schedule.cadence, null);
      assert.equal(detail.schedule.targetContext, null);
      assert.equal(detail.schedule.harnessMode, "local-copilot");

      reopenedStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
