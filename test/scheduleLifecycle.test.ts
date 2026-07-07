import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  ScheduleLifecycle,
  SqliteScheduleStore,
  VsCodeNaturalLanguageScheduleCreationFlow,
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
