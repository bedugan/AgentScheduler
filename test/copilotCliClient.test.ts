import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
  COPILOT_CLI_MISSING_REASON,
  CopilotCliLocalClient,
  ExecFileCopilotCliCommandRunner,
  classifyCopilotCliAvailability,
  resolveCopilotLocalHarnessPolicy,
  type CopilotCliCommandResult,
  type CopilotCliCommandRunOptions,
  type CopilotCliCommandRunner,
  type CopilotInteractiveExecutor,
  type Schedule,
} from "../src/index.js";

describe("Copilot CLI local client", () => {
  it("reports process identity before completion and heartbeats a long-running child", async () => {
    const runner = new ExecFileCopilotCliCommandRunner();
    let identity: string | undefined;
    let heartbeats = 0;
    const before = new Date().toISOString();

    const result = await runner.run(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 80)"],
      {
        timeoutMs: 2_000,
        heartbeatMs: 10,
        onStarted: async (value) => {
          identity = value;
        },
        onHeartbeat: async () => {
          heartbeats += 1;
        },
      },
    );

    assert.match(identity ?? "", /^process:\d+$/);
    assert.ok(heartbeats > 0);
    assert.equal(result.exitCode, 0);
    assert.ok((result.completedAt ?? "") >= before);
  });
  it("reports available when the CLI version probe succeeds", () => {
    assert.deepEqual(
      classifyCopilotCliAvailability({
        exitCode: 0,
        stdout: "GitHub Copilot CLI 1.0.25",
        stderr: "",
      }),
      {
        status: "available",
        approvalSurfaceAvailable: false,
      },
    );
  });

  it("tells the user how to fetch Copilot CLI when the command is missing", () => {
    const availability = classifyCopilotCliAvailability({
      exitCode: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
      errorMessage: "spawn copilot ENOENT",
    });

    assert.deepEqual(availability, {
      status: "unavailable",
      reason: COPILOT_CLI_MISSING_REASON,
    });
    assert.match(availability.reason, /gh copilot/);
    assert.match(availability.reason, /PATH/);
  });

  it("tells the user how to authenticate when credentials are unavailable", () => {
    const availability = classifyCopilotCliAvailability({
      exitCode: null,
      stdout: "",
      stderr: "ERROR: SecItemCopyMatching failed -50",
    });

    assert.deepEqual(availability, {
      status: "unavailable",
      reason: COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
    });
    assert.match(availability.reason, /copilot login/);
    assert.match(availability.reason, /COPILOT_GITHUB_TOKEN/);
  });

  it("refreshes availability so repairing Copilot CLI is detected without restart", async () => {
    const runner = new RecordingCopilotCliCommandRunner([
      { exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" },
      { exitCode: 0, stdout: "GitHub Copilot CLI 1.0.25", stderr: "" },
    ]);
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });

    assert.equal(client.currentAvailability(), undefined);
    assert.equal((await client.refreshAvailability()).status, "unavailable");
    assert.deepEqual(await client.refreshAvailability(), {
      status: "available",
      approvalSurfaceAvailable: false,
    });

    assert.deepEqual(runner.calls, [
      {
        command: "/custom/copilot",
        args: ["--version"],
        options: { timeoutMs: 5_000 },
      },
      {
        command: "/custom/copilot",
        args: ["--version"],
        options: { timeoutMs: 5_000 },
      },
    ]);
  });

  it("refreshes a probe-reported authentication failure after login without restart", async () => {
    const runner = new RecordingCopilotCliCommandRunner([
      {
        exitCode: null,
        stdout: "",
        stderr: "ERROR: SecItemCopyMatching failed -50",
      },
      { exitCode: 0, stdout: "GitHub Copilot CLI 1.0.25", stderr: "" },
    ]);
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });

    assert.deepEqual(await client.refreshAvailability(), {
      status: "unavailable",
      reason: COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
    });
    assert.deepEqual(await client.refreshAvailability(), {
      status: "available",
      approvalSurfaceAvailable: false,
    });
  });

  it("runs manual Default Approvals through the configured interactive approval surface", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: "GitHub Copilot CLI 1.0.25",
      stderr: "",
    });
    const interactiveExecutor = new RecordingInteractiveExecutor();
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
      interactiveExecutor,
    });
    const schedule = createSchedule({
      approvalMode: "default-approvals",
      model: "auto",
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
      },
    });

    assert.deepEqual(await client.checkAvailability(schedule), {
      status: "available",
      approvalSurfaceAvailable: true,
    });
    const result = await client.start({
      schedule,
      trigger: "manual",
      requestedAt: "2026-07-07T16:00:00.000Z",
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: resolveCopilotLocalHarnessPolicy({
        approvalMode: "default-approvals",
        unattended: false,
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(interactiveExecutor.calls[0]?.args.slice(0, -1), [
      "-C",
      "/Users/ada/src/AgentScheduler",
      "-i",
    ]);
    assert.equal(runner.calls.length, 1);
  });

  it("adds supported permission flags from help when Bypass Approvals needs them", async () => {
    const runner = new RecordingCopilotCliCommandRunner([
      {
        exitCode: 0,
        stdout: "GitHub Copilot CLI 1.0.25",
        stderr: "",
      },
      {
        exitCode: 0,
        stdout: "",
        stderr: "Usage: copilot [--no-ask-user] [--allow-all-tools]",
      },
    ]);
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });

    const availability = await client.checkAvailability(
      createSchedule({
        approvalMode: "bypass-approvals",
        model: "gpt-5",
        targetContext: null,
      }),
    );

    assert.deepEqual(availability, {
      status: "available",
      approvalSurfaceAvailable: false,
      supportedPermissionFlags: ["--allow-all-tools", "--no-ask-user"],
    });
    assert.deepEqual(runner.calls, [
      {
        command: "/custom/copilot",
        args: ["--version"],
        options: { timeoutMs: 5_000 },
      },
      {
        command: "/custom/copilot",
        args: ["--help"],
        options: { timeoutMs: 5_000 },
      },
    ]);
  });

  it("runs a bypass-approval manual schedule through Copilot CLI prompt mode", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: {
            data: {
              content: [
                { type: "text", text: "Reviewed the workspace and finished." },
              ],
            },
          },
        }),
        JSON.stringify({
          type: "result",
          sessionId: "fec78c0b-fe67-4e92-90d3-6147089dab90",
          exitCode: 0,
          model: "claude-haiku-4.5",
        }),
      ].join("\n"),
      stderr: "",
      completedAt: "2026-07-07T16:01:23.000Z",
    });
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
      runTimeoutMs: 12_345,
    });
    const schedule = createSchedule({
      approvalMode: "bypass-approvals",
      model: "gpt-5.4",
      targetContext: {
        type: "workspace",
        uri: "file:///Users/briandugan/src/personal/AgentScheduler",
      },
    });

    const result = await client.start({
      schedule,
      trigger: "manual",
      requestedAt: "2026-07-07T16:00:00.000Z",
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: resolveCopilotLocalHarnessPolicy({
        approvalMode: "bypass-approvals",
        unattended: false,
      }),
    });

    assert.deepEqual(result, {
      externalRunId: "fec78c0b-fe67-4e92-90d3-6147089dab90",
      status: "completed",
      completedAt: "2026-07-07T16:01:23.000Z",
      summary: "Reviewed the workspace and finished.",
      executedModel: "claude-haiku-4.5",
    });
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.command, "/custom/copilot");
    assert.deepEqual(runner.calls[0]?.args.slice(0, -1), [
      "-C",
      "/Users/briandugan/src/personal/AgentScheduler",
      "--model",
      "gpt-5.4",
      "--output-format",
      "json",
      "--no-color",
      "--no-ask-user",
      "--allow-all-tools",
      "-p",
    ]);
    assert.equal(runner.calls[0]?.options?.timeoutMs, 12_345);

    const prompt = runner.calls[0]?.args.at(-1) ?? "";
    assert.match(prompt, /AgentScheduler execution frame/);
    assert.match(prompt, /one occurrence of an AgentScheduler run/);
    assert.match(prompt, /AgentScheduler owns recurrence, run caps, and local scheduling/);
    assert.match(prompt, /normal Copilot CLI response/);
    assert.match(prompt, /obey the resolved harness policy/);
    assert.match(prompt, /Review the scheduled workspace\./);
  });

  it("passes autopilot schedules as autonomous all-permission CLI runs", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        sessionId: "autopilot-session",
        exitCode: 0,
      }),
      stderr: "",
    });
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });
    const schedule = createSchedule({
      approvalMode: "autopilot",
      model: "gpt-5",
      targetContext: null,
    });

    await client.start({
      schedule,
      trigger: "manual",
      requestedAt: "2026-07-07T16:00:00.000Z",
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: resolveCopilotLocalHarnessPolicy({
        approvalMode: "autopilot",
        unattended: false,
      }),
    });

    assert.deepEqual(runner.calls[0]?.args.slice(0, -1), [
      "--model",
      "gpt-5",
      "--output-format",
      "json",
      "--no-color",
      "--no-ask-user",
      "--autopilot",
      "--allow-all",
      "-p",
    ]);
    assert.match(
      runner.calls[0]?.args.at(-1) ?? "",
      /Review the scheduled workspace\./,
    );
  });

  it("frames recurrence-heavy run instructions as one Copilot CLI occurrence", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        sessionId: "single-occurrence-session",
        exitCode: 0,
      }),
      stderr: "",
    });
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });
    const schedule = createSchedule({
      approvalMode: "bypass-approvals",
      model: "gpt-5",
      targetContext: null,
      runInstructions: "Run every hour and retrieve the time.",
    });

    await client.start({
      schedule,
      trigger: "automatic",
      requestedAt: "2026-07-07T17:00:00.000Z",
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: resolveCopilotLocalHarnessPolicy({
        approvalMode: "bypass-approvals",
        unattended: true,
      }),
    });

    const prompt = runner.calls[0]?.args.at(-1) ?? "";
    assert.match(prompt, /Run every hour and retrieve the time\./);
    assert.match(prompt, /current run once in the target context/);
    assert.match(prompt, /Do not create or register OS scheduled tasks/);
    assert.match(prompt, /scheduled jobs/);
    assert.match(prompt, /detached processes/);
    assert.match(prompt, /daemons/);
    assert.match(prompt, /timers/);
    assert.match(prompt, /watchers/);
    assert.match(prompt, /solely to implement recurrence/);
  });

  it("records a failed run when Copilot CLI exits unsuccessfully", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 1,
      stdout: JSON.stringify({
        type: "result",
        sessionId: "failed-session",
        exitCode: 1,
      }),
      stderr: "Copilot CLI could not complete the request.",
    });
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });
    const schedule = createSchedule({
      approvalMode: "bypass-approvals",
      model: "gpt-5",
      targetContext: null,
    });

    const result = await client.start({
      schedule,
      trigger: "manual",
      requestedAt: "2026-07-07T16:00:00.000Z",
      runInstructions: schedule.runInstructions,
      resolvedHarnessPolicy: resolveCopilotLocalHarnessPolicy({
        approvalMode: "bypass-approvals",
        unattended: false,
      }),
    });

    assert.deepEqual(result, {
      externalRunId: "failed-session",
      status: "failed",
      completedAt: "2026-07-07T16:00:00.000Z",
      summary: "Copilot CLI could not complete the request.",
      executedModel: null,
    });
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
    const result =
      this.results[Math.min(this.calls.length - 1, this.results.length - 1)] ??
      this.results[0];
    if (!result) {
      throw new Error("RecordingCopilotCliCommandRunner has no results.");
    }
    return structuredClone(result);
  }
}

class RecordingInteractiveExecutor implements CopilotInteractiveExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: readonly string[]) {
    this.calls.push({ command, args: [...args] });
    return {
      externalRunId: "vscode-task:1",
      status: "completed" as const,
      completedAt: "2026-07-07T16:00:00.000Z",
      summary: "Interactive Copilot task completed.",
      executedModel: null,
    };
  }
}

function createSchedule(input: {
  approvalMode: Schedule["approvalMode"];
  model: string;
  targetContext: Schedule["targetContext"];
  runInstructions?: string;
}): Schedule {
  return {
    id: "schedule-1",
    revision: 1,
    status: "active",
    enabled: true,
    runInstructions: input.runInstructions ?? "Review the scheduled workspace.",
    cadence: { type: "cron", expression: "0 * * * *" },
    targetContext: input.targetContext,
    harnessMode: "local-copilot",
    model: input.model,
    approvalMode: input.approvalMode,
    runCounter: { completed: 0, limit: null },
    nextRunAt: "2026-07-07T17:00:00.000Z",
    lastRunAt: null,
    createdAt: "2026-07-07T15:00:00.000Z",
    updatedAt: "2026-07-07T15:00:00.000Z",
  };
}
