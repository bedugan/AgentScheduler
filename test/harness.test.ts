import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COPILOT_APPROVAL_MODE_LABELS,
  CopilotLocalHarness,
  ScheduleLifecycle,
  resolveCopilotLocalHarnessPolicy,
  type CopilotLocalClient,
  type CopilotLocalClientAvailability,
  type CopilotLocalStartRequest,
  type HarnessCancelRequest,
  type HarnessCancelResult,
  type HarnessOpenRequest,
  type HarnessStatusRequest,
  type HarnessStatusResult,
  type HarnessStartResult,
  type Schedule,
} from "../src/index.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("harness contract", () => {
  it("routes fake harness status, cancellation, and open/review operations through the lifecycle", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({
      mode: "local-copilot",
      startResult: {
        externalRunId: "fake-local-run-1",
        status: "running",
        completedAt: null,
        summary: "Fake harness is running.",
      },
      statusResult: {
        status: "approval-waiting",
        completedAt: null,
        summary: "Fake harness is waiting for approval.",
        error: null,
      },
      cancelResult: {
        status: "canceled",
        completedAt: "2026-07-07T16:07:00.000Z",
        summary: "Fake harness canceled the run.",
        error: null,
      },
      openResult: (request) => ({
        status: "opened",
        target: `fake://local-copilot/${request.externalRunId}/${request.purpose}`,
      }),
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Exercise the fake harness contract.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "bypass-approvals",
    });

    const run = await lifecycle.startManualRun(schedule.id);
    assert.equal(run.status, "running");
    assert.equal(fakeHarness.startRequests.length, 1);

    const polledRun = await lifecycle.pollRunStatus(run.id);
    assert.equal(polledRun.status, "approval-waiting");
    assert.equal(fakeHarness.statusRequests.length, 1);
    assert.equal(fakeHarness.statusRequests[0]?.externalRunId, "fake-local-run-1");

    const openResult = await lifecycle.openRun(run.id);
    const reviewResult = await lifecycle.reviewRun(run.id);
    assert.deepEqual(openResult, {
      status: "opened",
      target: "fake://local-copilot/fake-local-run-1/open",
    });
    assert.deepEqual(reviewResult, {
      status: "opened",
      target: "fake://local-copilot/fake-local-run-1/review",
    });
    assert.deepEqual(
      fakeHarness.openRequests.map((request) => request.purpose),
      ["open", "review"],
    );

    clock.set("2026-07-07T16:07:00.000Z");
    const canceledRun = await lifecycle.cancelRun(run.id);
    assert.equal(canceledRun.status, "canceled");
    assert.equal(canceledRun.completedAt, "2026-07-07T16:07:00.000Z");
    assert.equal(fakeHarness.cancelRequests.length, 1);
    assert.equal(fakeHarness.cancelRequests[0]?.externalRunId, "fake-local-run-1");
  });
});

describe("Copilot Local harness", () => {
  it("uses Copilot approval wording and maps approval modes to local execution policy", () => {
    assert.deepEqual(COPILOT_APPROVAL_MODE_LABELS, {
      "default-approvals": "Default Approvals",
      "bypass-approvals": "Bypass Approvals",
      autopilot: "Autopilot",
    });

    assert.deepEqual(
      resolveCopilotLocalHarnessPolicy({
        approvalMode: "default-approvals",
        unattended: true,
      }),
      {
        provider: "copilot",
        harnessMode: "local-copilot",
        approvalMode: "default-approvals",
        approvalModeLabel: "Default Approvals",
        localCopilotMode: {
          approvalPreset: "default",
          permissionBehavior: "uses-copilot-default-approvals",
          requiresApprovalSurface: true,
          unattended: true,
        },
      },
    );

    assert.deepEqual(
      resolveCopilotLocalHarnessPolicy({
        approvalMode: "bypass-approvals",
        unattended: true,
      }),
      {
        provider: "copilot",
        harnessMode: "local-copilot",
        approvalMode: "bypass-approvals",
        approvalModeLabel: "Bypass Approvals",
        localCopilotMode: {
          approvalPreset: "bypass",
          permissionBehavior: "bypasses-approval-prompts",
          requiresApprovalSurface: false,
          unattended: true,
        },
      },
    );

    assert.deepEqual(
      resolveCopilotLocalHarnessPolicy({
        approvalMode: "autopilot",
        unattended: true,
      }),
      {
        provider: "copilot",
        harnessMode: "local-copilot",
        approvalMode: "autopilot",
        approvalModeLabel: "Autopilot",
        localCopilotMode: {
          approvalPreset: "autopilot",
          permissionBehavior: "runs-with-autopilot",
          requiresApprovalSurface: false,
          unattended: true,
        },
      },
    );
  });

  it("blocks unattended Default Approvals preflight when no approval surface is available", async () => {
    const client = new RecordingCopilotLocalClient({
      availability: {
        status: "available",
        approvalSurfaceAvailable: false,
      },
    });
    const harness = new CopilotLocalHarness({ client });
    const schedule = createSchedule({
      approvalMode: "default-approvals",
    });

    const preflight = await harness.preflight({
      schedule,
      trigger: "automatic",
      requestedAt: "2026-07-07T16:00:00.000Z",
      localSchedulingEnabled: true,
    });

    assert.equal(preflight.status, "blocked");
    assert.match(preflight.reason, /Default Approvals/);
    assert.match(preflight.reason, /approval surface/);
    assert.deepEqual(preflight.resolvedHarnessPolicy, {
      provider: "copilot",
      harnessMode: "local-copilot",
      approvalMode: "default-approvals",
      approvalModeLabel: "Default Approvals",
      localCopilotMode: {
        approvalPreset: "default",
        permissionBehavior: "uses-copilot-default-approvals",
        requiresApprovalSurface: true,
        unattended: true,
      },
    });
    assert.equal(client.availabilityRequests.length, 1);
    assert.equal(client.startRequests.length, 0);
  });

  it("records unattended Default Approvals blocking as a blocked run without falling back", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const client = new RecordingCopilotLocalClient({
      availability: {
        status: "available",
        approvalSurfaceAvailable: false,
      },
    });
    const localHarness = new CopilotLocalHarness({ client });
    const cloudHarness = new FakeHarness({ mode: "cloud-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [localHarness, cloudHarness],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run unattended with Default Approvals.",
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
    assert.equal(client.startRequests.length, 0);
    assert.equal(cloudHarness.preflightRequests.length, 0);
    assert.equal(cloudHarness.startRequests.length, 0);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.previousRuns.length, 1);
    assert.equal(detail.previousRuns[0]?.status, "blocked");
    assert.match(detail.previousRuns[0]?.error ?? "", /Default Approvals/);
    assert.deepEqual(detail.previousRuns[0]?.resolvedHarnessPolicy, {
      provider: "copilot",
      harnessMode: "local-copilot",
      approvalMode: "default-approvals",
      approvalModeLabel: "Default Approvals",
      localCopilotMode: {
        approvalPreset: "default",
        permissionBehavior: "uses-copilot-default-approvals",
        requiresApprovalSurface: true,
        unattended: true,
      },
    });
  });

  it("snapshots resolved policy and delegates local start, status, cancellation, and review", async () => {
    const client = new RecordingCopilotLocalClient({
      availability: {
        status: "available",
        approvalSurfaceAvailable: false,
      },
      startResult: {
        externalRunId: "copilot-local-run-1",
        status: "running",
        completedAt: null,
        summary: "Copilot local run started.",
      },
      statusResult: {
        status: "approval-waiting",
        completedAt: null,
        summary: "Copilot is waiting for a tool approval.",
        error: null,
      },
      cancelResult: {
        status: "canceled",
        completedAt: "2026-07-07T16:12:00.000Z",
        summary: "Copilot local run was canceled.",
        error: null,
      },
    });
    const harness = new CopilotLocalHarness({ client });
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:10:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [harness],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Run through Local Copilot Mode.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "bypass-approvals",
    });

    const run = await lifecycle.startManualRun(schedule.id);

    assert.equal(run.status, "running");
    assert.equal(run.runInstructionsSnapshot, "Run through Local Copilot Mode.");
    assert.equal(run.approvalModeSnapshot, "bypass-approvals");
    assert.deepEqual(run.resolvedHarnessPolicy, {
      provider: "copilot",
      harnessMode: "local-copilot",
      approvalMode: "bypass-approvals",
      approvalModeLabel: "Bypass Approvals",
      localCopilotMode: {
        approvalPreset: "bypass",
        permissionBehavior: "bypasses-approval-prompts",
        requiresApprovalSurface: false,
        unattended: false,
      },
    });
    assert.equal(client.startRequests.length, 1);
    assert.equal(client.startRequests[0]?.runInstructions, schedule.runInstructions);
    assert.deepEqual(
      client.startRequests[0]?.resolvedHarnessPolicy,
      run.resolvedHarnessPolicy,
    );

    const polledRun = await lifecycle.pollRunStatus(run.id);
    assert.equal(polledRun.status, "approval-waiting");
    assert.equal(client.statusRequests[0]?.externalRunId, "copilot-local-run-1");

    const reviewResult = await lifecycle.reviewRun(run.id);
    assert.deepEqual(reviewResult, {
      status: "opened",
      target: "vscode://github.copilot/chat/copilot-local-run-1?mode=review",
    });
    assert.equal(client.openRequests[0]?.purpose, "review");

    const canceledRun = await lifecycle.cancelRun(run.id);
    assert.equal(canceledRun.status, "canceled");
    assert.equal(canceledRun.summary, "Copilot local run was canceled.");
    assert.equal(client.cancelRequests[0]?.externalRunId, "copilot-local-run-1");
  });

  it("returns meaningful blocked errors for unavailable Local Copilot Mode", async () => {
    const client = new RecordingCopilotLocalClient({
      availability: {
        status: "unavailable",
        reason: "GitHub Copilot local tooling is not installed.",
      },
    });
    const harness = new CopilotLocalHarness({ client });
    const schedule = createSchedule({
      approvalMode: "autopilot",
    });

    const preflight = await harness.preflight({
      schedule,
      trigger: "manual",
      requestedAt: "2026-07-07T16:00:00.000Z",
      localSchedulingEnabled: false,
    });

    assert.equal(preflight.status, "blocked");
    assert.equal(
      preflight.reason,
      "GitHub Copilot local tooling is not installed.",
    );
    assert.equal(client.startRequests.length, 0);
  });
});

class RecordingCopilotLocalClient implements CopilotLocalClient {
  readonly availabilityRequests: Schedule[] = [];
  readonly startRequests: CopilotLocalStartRequest[] = [];
  readonly statusRequests: HarnessStatusRequest[] = [];
  readonly cancelRequests: HarnessCancelRequest[] = [];
  readonly openRequests: HarnessOpenRequest[] = [];

  private readonly availability: CopilotLocalClientAvailability;
  private readonly startResult: HarnessStartResult | undefined;
  private readonly statusResult: HarnessStatusResult | undefined;
  private readonly cancelResult: HarnessCancelResult | undefined;

  constructor(options: {
    availability: CopilotLocalClientAvailability;
    startResult?: Awaited<ReturnType<CopilotLocalClient["start"]>>;
    statusResult?: Awaited<ReturnType<CopilotLocalClient["status"]>>;
    cancelResult?: Awaited<ReturnType<CopilotLocalClient["cancel"]>>;
  }) {
    this.availability = options.availability;
    this.startResult = options.startResult;
    this.statusResult = options.statusResult;
    this.cancelResult = options.cancelResult;
  }

  async checkAvailability(schedule: Schedule): Promise<CopilotLocalClientAvailability> {
    this.availabilityRequests.push(structuredClone(schedule));
    return structuredClone(this.availability);
  }

  async start(request: CopilotLocalStartRequest): Promise<HarnessStartResult> {
    this.startRequests.push(structuredClone(request));
    const defaultResult: HarnessStartResult = {
      externalRunId: "copilot-local-run-1",
      status: "running",
      completedAt: null,
      summary: "Copilot local run started.",
    };

    return structuredClone(
      this.startResult ?? defaultResult,
    );
  }

  async status(request: HarnessStatusRequest): Promise<HarnessStatusResult> {
    this.statusRequests.push(structuredClone(request));
    const defaultResult: HarnessStatusResult = {
      status: "running",
      completedAt: null,
      summary: "Copilot local run is running.",
      error: null,
    };

    return structuredClone(
      this.statusResult ?? defaultResult,
    );
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    this.cancelRequests.push(structuredClone(request));
    const defaultResult: HarnessCancelResult = {
      status: "canceled",
      completedAt: request.requestedAt,
      summary: "Copilot local run was canceled.",
      error: null,
    };

    return structuredClone(
      this.cancelResult ?? defaultResult,
    );
  }

  async open(request: HarnessOpenRequest) {
    this.openRequests.push(structuredClone(request));
    return {
      status: "opened" as const,
      target: `vscode://github.copilot/chat/${request.externalRunId}?mode=${request.purpose}`,
    };
  }
}

function createSchedule(input: { approvalMode: Schedule["approvalMode"] }): Schedule {
  return {
    id: "schedule_1",
    revision: 1,
    status: "active",
    enabled: true,
    runInstructions: "Run through Local Copilot Mode.",
    cadence: { type: "cron", expression: "0 * * * *" },
    targetContext: {
      type: "workspace",
      uri: "file:///tmp/agent-scheduler",
    },
    harnessMode: "local-copilot",
    model: "gpt-5",
    approvalMode: input.approvalMode,
    runCounter: {
      completed: 0,
      limit: null,
    },
    nextRunAt: "2026-07-07T17:00:00.000Z",
    lastRunAt: null,
    createdAt: "2026-07-07T16:00:00.000Z",
    updatedAt: "2026-07-07T16:00:00.000Z",
  };
}
