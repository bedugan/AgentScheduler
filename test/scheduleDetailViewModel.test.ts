import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EditorControlSurface, ScheduleLifecycle } from "../src/index.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("Schedule Detail view model", () => {
  it("shows editable instructions, schedule overview fields, linked run outcomes, and quiet notification defaults together", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);

    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Review open bug branches and summarize risks.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 5 },
    });
    await lifecycle.activateSchedule(schedule.id);

    clock.set("2026-07-07T16:10:00.000Z");
    const run = await editor.runScheduleNow(schedule.id);
    const detail = await editor.openScheduleDetail(schedule.id);

    assert.deepEqual(detail.runInstructions, {
      value: "Review open bug branches and summarize risks.",
      editable: true,
      scheduleRevision: 1,
    });
    assert.deepEqual(detail.overview, {
      status: "active",
      enabled: true,
      nextRunAt: "2026-07-07T17:00:00.000Z",
      lastRunAt: "2026-07-07T16:10:00.000Z",
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
        label: "AgentScheduler",
      },
      cadence: { type: "cron", expression: "0 * * * *" },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCounter: {
        completed: 1,
        limit: 5,
        label: "1/5",
      },
    });
    assert.deepEqual(detail.actions.runNow, {
      kind: "run-now",
      label: "Run Now",
      enabled: true,
    });
    assert.deepEqual(detail.notificationState, {
      runOutcomes: "quiet-in-app",
      desktopNotifications: "off",
    });
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.id, run.id);
    assert.deepEqual(detail.previousRuns[0]?.outcome, {
      status: "completed",
      completedAt: "2026-07-07T16:10:00.000Z",
      summary: "Fake harness completed the draft run.",
      error: null,
    });
    assert.deepEqual(detail.previousRuns[0]?.historyDetailLink, {
      runId: run.id,
      view: "run-history-detail",
    });

    const historyDetail = await editor.openRunHistoryDetail(run.id);
    assert.equal(
      historyDetail.resolvedRunInstructions,
      "Review open bug branches and summarize risks.",
    );
    assert.equal(historyDetail.approvalMode, "default-approvals");
    assert.deepEqual(historyDetail.resolvedHarnessPolicy, {
      harnessMode: "local-copilot",
      approvalMode: "default-approvals",
      sandbox: "fake",
    });
  });

  it("edits inline instructions for future runs while active run history stays tied to the starting revision", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    let startAttempts = 0;
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: (request) => {
        startAttempts += 1;
        return startAttempts === 1
          ? {
              externalRunId: "active-run-before-edit",
              status: "running",
              completedAt: null,
              summary: "Run is still active.",
            }
          : {
              externalRunId: "future-run-after-edit",
              status: "completed",
              completedAt: request.requestedAt,
              summary: "Future run used edited instructions.",
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
    const editor = new EditorControlSurface(lifecycle);

    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Use the original instructions.",
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

    clock.set("2026-07-07T16:10:00.000Z");
    const activeRun = await editor.runScheduleNow(schedule.id);
    assert.equal(activeRun.status, "running");

    const editedDetail = await editor.saveScheduleDetailEdits(schedule.id, {
      runInstructions: "Use the edited instructions for future runs.",
    });
    assert.equal(editedDetail.schedule.revision, 2);
    assert.equal(
      editedDetail.runInstructions.value,
      "Use the edited instructions for future runs.",
    );

    const activeHistoryDetail = await editor.openRunHistoryDetail(activeRun.id);
    assert.equal(activeHistoryDetail.scheduleRevision, 1);
    assert.equal(
      activeHistoryDetail.resolvedRunInstructions,
      "Use the original instructions.",
    );

    clock.set("2026-07-07T16:20:00.000Z");
    await lifecycle.resolveActiveRun(activeRun.id, {
      status: "completed",
      summary: "Original run completed after the edit.",
    });

    clock.set("2026-07-07T16:30:00.000Z");
    const futureRun = await editor.runScheduleNow(schedule.id);
    const futureHistoryDetail = await editor.openRunHistoryDetail(futureRun.id);

    assert.equal(futureHistoryDetail.scheduleRevision, 2);
    assert.equal(
      futureHistoryDetail.resolvedRunInstructions,
      "Use the edited instructions for future runs.",
    );
    assert.equal(
      fakeHarness.startRequests[1]?.runInstructions,
      futureHistoryDetail.resolvedRunInstructions,
    );
  });

  it("renders paused and completed actions distinctly, restarts completed schedules without deleting history, and blocks unavailable manual runs", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);

    const draftSchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Validate the schedule before enabling recurrence.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/draft-schedule",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const draftDetail = await editor.openScheduleDetail(draftSchedule.id);
    assert.equal(draftDetail.overview.status, "draft");
    assert.equal(draftDetail.actions.runNow.enabled, true);

    const pausedSchedule = await lifecycle.createActiveSchedule({
      runInstructions: "Pause and resume explicitly.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/paused-schedule",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    await lifecycle.pauseSchedule(pausedSchedule.id);

    const pausedDetail = await editor.openScheduleDetail(pausedSchedule.id);
    assert.equal(pausedDetail.overview.status, "paused");
    assert.deepEqual(pausedDetail.actions.resume, {
      kind: "resume",
      label: "Resume",
      enabled: true,
    });
    assert.equal(pausedDetail.actions.restart.enabled, false);
    assert.equal(pausedDetail.actions.runNow.enabled, false);
    await assert.rejects(
      () => editor.runScheduleNow(pausedSchedule.id),
      /Manual Run Now is only available for draft or enabled schedules./,
    );

    clock.set("2026-07-07T18:10:00.000Z");
    const resumedDetail = await editor.resumeSchedule(pausedSchedule.id);
    assert.equal(resumedDetail.overview.status, "active");
    assert.equal(resumedDetail.overview.nextRunAt, "2026-07-07T19:00:00.000Z");

    const cappedSchedule = await lifecycle.createActiveSchedule({
      runInstructions: "Complete once, then require restart.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/completed-schedule",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });

    clock.set("2026-07-07T18:20:00.000Z");
    const completedRun = await editor.runScheduleNow(cappedSchedule.id);
    const completedDetail = await editor.openScheduleDetail(cappedSchedule.id);
    assert.equal(completedDetail.overview.status, "completed");
    assert.deepEqual(completedDetail.overview.runCounter, {
      completed: 1,
      limit: 1,
      label: "1/1",
    });
    assert.deepEqual(completedDetail.actions.restart, {
      kind: "restart",
      label: "Restart",
      enabled: true,
    });
    assert.equal(completedDetail.actions.resume.enabled, false);
    assert.equal(completedDetail.actions.runNow.enabled, false);
    await assert.rejects(
      () => editor.runScheduleNow(cappedSchedule.id),
      /Manual Run Now is only available for draft or enabled schedules./,
    );

    clock.set("2026-07-07T18:30:00.000Z");
    const restartedDetail = await editor.restartCompletedSchedule(
      cappedSchedule.id,
    );
    assert.equal(restartedDetail.overview.status, "active");
    assert.equal(restartedDetail.overview.enabled, true);
    assert.equal(restartedDetail.overview.nextRunAt, "2026-07-07T19:00:00.000Z");
    assert.deepEqual(restartedDetail.overview.runCounter, {
      completed: 0,
      limit: 1,
      label: "0/1",
    });
    assert.deepEqual(
      restartedDetail.previousRuns.map((run) => run.id),
      [completedRun.id],
    );
  });
});
