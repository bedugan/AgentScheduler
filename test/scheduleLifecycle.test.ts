import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  ScheduleLifecycle,
  SqliteScheduleStore,
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
});
