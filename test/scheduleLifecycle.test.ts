import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  ScheduleLifecycle,
  SqliteScheduleStore,
  VsCodeNaturalLanguageScheduleCreationFlow,
} from "../src/index.js";
import type { Schedule } from "../src/index.js";
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
});

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
