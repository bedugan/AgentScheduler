import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
  COPILOT_CLI_MISSING_REASON,
  CopilotCliLocalClient,
  CopilotLocalHarness,
  EditorControlSurface,
  LocalSchedulingSetup,
  MacOsLaunchdWakeupProvider,
  ScheduleLifecycle,
  SqliteScheduleStore,
  WindowsTaskSchedulerWakeupProvider,
  runWorkerCli,
} from "../src/index.js";
import type {
  CopilotCliCommandResult,
  CopilotCliCommandRunOptions,
  CopilotCliCommandRunner,
  DueWorkScanResult,
  LocalSchedulingSetupResult,
  LocalSchedulingSetupState,
  RunHistoryEntry,
  Schedule,
  WakeupProvider,
  WakeupTriggerIntent,
  WakeupTriggerOperation,
  WakeupTriggerRequest,
  WakeupTriggerResult,
} from "../src/index.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryLocalSchedulingSetupStore,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("local scheduling setup", () => {
  it("generates Windows Task Scheduler install, verify, and uninstall intent for one per-user trigger", () => {
    const provider = new WindowsTaskSchedulerWakeupProvider();
    const request: WakeupTriggerRequest = {
      triggerId: "AgentSchedulerLocalWakeup",
      workerExecutable: "C:\\Program Files\\nodejs\\node.exe",
      workerArguments: [
        "C:\\Users\\Ada\\.vscode\\extensions\\agent-scheduler\\dist\\src\\workerCli.js",
        "scan-due-work",
        "--store",
        "C:\\Users\\Ada\\AppData\\Local\\AgentScheduler\\schedules.sqlite",
      ],
      intervalMinutes: 5,
    };

    const install = provider.intentFor("install", request);
    const verify = provider.intentFor("verify", request);
    const uninstall = provider.intentFor("uninstall", request);

    assert.equal(install.platform, "windows");
    assert.equal(install.triggerId, "AgentSchedulerLocalWakeup");
    assert.equal(install.commands.length, 1);
    assert.deepEqual(install.commands[0]?.args.slice(0, 8), [
      "/Create",
      "/TN",
      "AgentSchedulerLocalWakeup",
      "/SC",
      "MINUTE",
      "/MO",
      "5",
      "/TR",
    ]);
    assert.match(
      install.commands[0]?.args[8] ?? "",
      /^"C:\\Program Files\\nodejs\\node\.exe" /,
    );
    assert.match(
      install.commands[0]?.args[8] ?? "",
      /workerCli\.js" scan-due-work --store /,
    );
    assert.deepEqual(install.commands[0]?.args.slice(9), ["/F"]);
    assert.deepEqual(install.files, []);

    assert.deepEqual(verify.commands[0]?.args, [
      "/Query",
      "/TN",
      "AgentSchedulerLocalWakeup",
    ]);
    assert.deepEqual(uninstall.commands[0]?.args, [
      "/Delete",
      "/TN",
      "AgentSchedulerLocalWakeup",
      "/F",
    ]);
  });

  it("generates macOS launchd install, verify, and uninstall intent after Windows support", () => {
    const provider = new MacOsLaunchdWakeupProvider();
    const plistPath =
      "/Users/ada/Library/LaunchAgents/com.bedugan.AgentScheduler.local-wakeup.plist";
    const request: WakeupTriggerRequest = {
      triggerId: "com.bedugan.AgentScheduler.local-wakeup",
      workerExecutable: "/opt/homebrew/bin/node",
      workerArguments: [
        "/Users/ada/.vscode/extensions/agent-scheduler/dist/src/workerCli.js",
        "scan-due-work",
        "--store",
        "/Users/ada/Library/Application Support/AgentScheduler/schedules.sqlite",
      ],
      intervalMinutes: 5,
      launchdPlistPath: plistPath,
      userId: 501,
    };

    const install = provider.intentFor("install", request);
    const verify = provider.intentFor("verify", request);
    const uninstall = provider.intentFor("uninstall", request);

    assert.equal(install.platform, "macos");
    assert.equal(install.triggerId, "com.bedugan.AgentScheduler.local-wakeup");
    assert.deepEqual(install.commands[0]?.args, [
      "bootstrap",
      "gui/501",
      plistPath,
    ]);
    assert.equal(install.files.length, 1);
    assert.equal(install.files[0]?.path, plistPath);
    assert.match(
      install.files[0]?.contents ?? "",
      /<key>Label<\/key>\s*<string>com\.bedugan\.AgentScheduler\.local-wakeup<\/string>/,
    );
    assert.match(install.files[0]?.contents ?? "", /<integer>300<\/integer>/);
    assert.match(
      install.files[0]?.contents ?? "",
      /<string>\/opt\/homebrew\/bin\/node<\/string>/,
    );
    assert.match(
      install.files[0]?.contents ?? "",
      /<string>scan-due-work<\/string>/,
    );

    assert.deepEqual(verify.commands[0]?.args, [
      "print",
      "gui/501/com.bedugan.AgentScheduler.local-wakeup",
    ]);
    assert.deepEqual(uninstall.commands[0]?.args, [
      "bootout",
      "gui/501",
      plistPath,
    ]);
    assert.deepEqual(uninstall.commands[1], {
      executable: "rm",
      args: ["-f", plistPath],
      shellCommand: `rm -f ${plistPath}`,
    });
  });

  it("keeps automatic runs inactive while local scheduling is disabled without silently installing setup", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const provider = new RecordingWakeupProvider();
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Review bug branches while setup is disabled.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    assert.equal(schedule.status, "active");
    assert.equal(schedule.enabled, true);
    assert.equal(provider.installRequests.length, 0);

    clock.set("2026-07-07T17:00:00.000Z");
    const disabledScan = await lifecycle.scanDueWork();
    assert.deepEqual(disabledScan.startedRunIds, []);
    assert.deepEqual(disabledScan.diagnostics, {
      scannedAt: "2026-07-07T17:00:00.000Z",
      localScheduling: {
        enabled: false,
        message:
          "Automatic runs are inactive until local scheduling setup is enabled.",
      },
      wakeupProvider: {
        configured: false,
        platform: null,
        triggerId: null,
        status: "not-installed",
      },
      dueScheduleCount: 0,
      outcomes: {
        started: 0,
        completed: 0,
        blocked: 0,
        deferred: 0,
        approvalWaiting: 0,
        failed: 0,
      },
    });
    assert.equal(fakeHarness.startRequests.length, 0);
    assert.equal(provider.installRequests.length, 0);

    const manualRun = await lifecycle.startManualRun(schedule.id);

    assert.equal(manualRun.trigger, "manual");
    assert.equal(manualRun.status, "completed");
    assert.equal(fakeHarness.preflightRequests[0]?.localSchedulingEnabled, false);
    assert.equal(fakeHarness.startRequests.length, 1);
    assert.equal(provider.installRequests.length, 0);
  });

  it("exposes an editor action that confirms before installing the wakeup trigger", async () => {
    const provider = new RecordingWakeupProvider();
    const setupStore = new InMemoryLocalSchedulingSetupStore();
    const setup = new LocalSchedulingSetup({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      provider,
      store: setupStore,
      request: {
        triggerId: "com.bedugan.AgentScheduler.local-wakeup",
        workerExecutable: "/usr/local/bin/node",
        workerArguments: [
          "/Users/briandugan/.vscode/extensions/agent-scheduler/dist/src/workerCli.js",
          "scan-due-work",
        ],
        intervalMinutes: 5,
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const confirmationRequests: WakeupTriggerIntent[] = [];
    const editor = new EditorControlSurface(lifecycle, {
      localSchedulingSetup: setup,
      confirmEnableLocalScheduling: async (intent) => {
        confirmationRequests.push(intent);
        return true;
      },
    });

    const result = await editor.enableLocalScheduling();

    assert.equal(confirmationRequests.length, 1);
    assert.equal(confirmationRequests[0]?.operation, "install");
    assert.equal(provider.installRequests.length, 1);
    assert.equal(result.state.enabled, true);
    assert.equal(result.state.platform, "windows");
    assert.equal(result.state.triggerId, "com.bedugan.AgentScheduler.local-wakeup");
    assert.equal(result.state.installedAt, "2026-07-07T16:00:00.000Z");
    assert.deepEqual(await setupStore.getLocalSchedulingSetup(), result.state);
  });

  it("starts automatic due work only after local scheduling setup is enabled", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const setup = new LocalSchedulingSetup({
      clock,
      provider: new RecordingWakeupProvider(),
      store: new InMemoryLocalSchedulingSetupStore(),
      request: {
        triggerId: "AgentSchedulerLocalWakeup",
        workerExecutable: "/usr/local/bin/node",
        workerArguments: ["workerCli.js", "scan-due-work"],
        intervalMinutes: 5,
      },
    });
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingSetup: setup,
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });
    const editor = new EditorControlSurface(lifecycle, {
      localSchedulingSetup: setup,
      confirmEnableLocalScheduling: async () => true,
    });

    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Run only after setup is enabled.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    clock.set("2026-07-07T17:00:00.000Z");
    assert.deepEqual((await lifecycle.scanDueWork()).startedRunIds, []);
    assert.equal(fakeHarness.startRequests.length, 0);

    await editor.enableLocalScheduling();
    const enabledScan = await lifecycle.scanDueWork();
    assert.deepEqual(enabledScan.startedRunIds, ["run_2"]);
    assert.deepEqual(enabledScan.diagnostics.localScheduling, {
      enabled: true,
      message: "Automatic runs are active because local scheduling setup is enabled.",
    });
    assert.deepEqual(enabledScan.diagnostics.wakeupProvider, {
      configured: true,
      platform: "windows",
      triggerId: "AgentSchedulerLocalWakeup",
      status: "installed",
    });
    assert.equal(enabledScan.diagnostics.dueScheduleCount, 1);
    assert.deepEqual(enabledScan.diagnostics.outcomes, {
      started: 1,
      completed: 1,
      blocked: 0,
      deferred: 0,
      approvalWaiting: 0,
      failed: 0,
    });
    assert.equal(fakeHarness.preflightRequests[0]?.localSchedulingEnabled, true);
    assert.equal(fakeHarness.startRequests.length, 1);

    const detail = await lifecycle.openScheduleDetail(schedule.id);
    assert.equal(detail.lastRunAt, "2026-07-07T17:00:00.000Z");
  });

  it("honors lightweight local scheduling state sources in worker scans", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingSetup: {
        isLocalSchedulingEnabled: async () => true,
      },
      store: new InMemoryScheduleStore(),
      harnesses: [fakeHarness],
    });

    await lifecycle.createActiveSchedule({
      runInstructions: "Run from a lightweight setup source.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///tmp/agent-scheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    clock.set("2026-07-07T17:00:00.000Z");
    const scan = await lifecycle.scanDueWork();

    assert.deepEqual(scan.startedRunIds, ["run_2"]);
    assert.deepEqual(scan.diagnostics.wakeupProvider, {
      configured: false,
      platform: null,
      triggerId: null,
      status: "unknown",
    });
  });

  it("persists local scheduling setup state in the SQLite local store", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");

    try {
      const firstStore = new SqliteScheduleStore({ databasePath });
      const setup = new LocalSchedulingSetup({
        clock: new FakeClock("2026-07-07T16:00:00.000Z"),
        provider: new RecordingWakeupProvider(),
        store: firstStore,
        request: {
          triggerId: "AgentSchedulerLocalWakeup",
          workerExecutable: "/usr/local/bin/node",
          workerArguments: ["workerCli.js", "scan-due-work"],
          intervalMinutes: 5,
        },
      });

      await setup.install();
      await setup.verify();
      firstStore.close();

      const reopenedStore = new SqliteScheduleStore({ databasePath });
      const persisted = await reopenedStore.getLocalSchedulingSetup();

      assert.equal(persisted.enabled, true);
      assert.equal(persisted.platform, "windows");
      assert.equal(persisted.triggerId, "AgentSchedulerLocalWakeup");
      assert.equal(persisted.installedAt, "2026-07-07T16:00:00.000Z");
      assert.equal(persisted.verifiedAt, "2026-07-07T16:00:00.000Z");

      reopenedStore.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("routes worker CLI install, verify, and uninstall commands through local scheduling setup", async () => {
    const setup = new RecordingLocalSchedulingSetup();
    const stdout: string[] = [];
    const stderr: string[] = [];

    assert.equal(
      await runWorkerCli(
        ["local-scheduling", "install"],
        { stdout, stderr },
        { localSchedulingSetup: setup },
      ),
      0,
    );
    assert.equal(
      await runWorkerCli(
        ["local-scheduling", "verify"],
        { stdout, stderr },
        { localSchedulingSetup: setup },
      ),
      0,
    );
    assert.equal(
      await runWorkerCli(
        ["local-scheduling", "uninstall"],
        { stdout, stderr },
        { localSchedulingSetup: setup },
      ),
      0,
    );

    assert.deepEqual(setup.operations, ["install", "verify", "uninstall"]);
    assert.equal(stderr.length, 0);
    assert.deepEqual(
      stdout.map((line) => (JSON.parse(line) as { operation: string }).operation),
      ["install", "verify", "uninstall"],
    );
  });

  it("builds worker CLI local scheduling setup intent from command-line options", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
    const databasePath = join(tempDirectory, "schedules.sqlite");
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      assert.equal(
        await runWorkerCli(
          [
            "local-scheduling",
            "install",
            "--dry-run",
            "--platform",
            "windows",
            "--store",
            databasePath,
            "--node",
            "C:\\Program Files\\nodejs\\node.exe",
            "--worker",
            "C:\\Users\\Ada\\.vscode\\extensions\\agent-scheduler\\dist\\src\\workerCli.js",
            "--trigger-id",
            "AgentSchedulerLocalWakeup",
          ],
          { stdout, stderr },
        ),
        0,
      );

      assert.equal(stderr.length, 0);
      const result = JSON.parse(stdout[0] ?? "{}") as {
        operation: string;
        platform: string;
        dryRun: boolean;
        commands: Array<{ executable: string; args: string[] }>;
      };

      assert.equal(result.operation, "install");
      assert.equal(result.platform, "windows");
      assert.equal(result.dryRun, true);
      assert.equal(result.commands[0]?.executable, "schtasks.exe");
      assert.match(result.commands[0]?.args[8] ?? "", /scan-due-work --store /);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("keeps worker CLI no-due scans from starting Copilot CLI", async () => {
    await withWorkerStore(async (databasePath) => {
      await seedWorkerStore(databasePath, []);
      const runner = new RecordingCopilotCliCommandRunner({
        exitCode: 0,
        stdout: "GitHub Copilot CLI 1.0.69",
        stderr: "",
      });

      const scan = await runWorkerScan(databasePath, runner);

      assert.deepEqual(runner.calls, []);
      assert.deepEqual(scan.startedRunIds, []);
      assert.equal(scan.diagnostics.localScheduling.enabled, true);
      assert.equal(scan.diagnostics.dueScheduleCount, 0);
      assert.deepEqual(scan.diagnostics.outcomes, {
        started: 0,
        completed: 0,
        blocked: 0,
        deferred: 0,
        approvalWaiting: 0,
        failed: 0,
      });
    });
  });

  it("runs due worker schedules through Copilot CLI from the target workspace", async () => {
    await withWorkerStore(async (databasePath) => {
      await seedWorkerStore(databasePath, [
        workerSchedule({
          id: "schedule_due_from_cli",
          approvalMode: "bypass-approvals",
          runInstructions: "Run from the worker CLI due scan.",
        }),
      ]);
      const runner = new RecordingCopilotCliCommandRunner([
        {
          exitCode: 0,
          stdout: "GitHub Copilot CLI 1.0.69",
          stderr: "",
        },
        {
          exitCode: 0,
          stdout: [
            JSON.stringify({
              type: "assistant",
              message: {
                data: {
                  content: [
                    { type: "text", text: "Worker CLI run completed." },
                  ],
                },
              },
            }),
            JSON.stringify({
              type: "result",
              sessionId: "worker-cli-session",
              exitCode: 0,
            }),
          ].join("\n"),
          stderr: "",
        },
      ]);

      const scan = await runWorkerScan(databasePath, runner);

      assert.equal(scan.startedRunIds.length, 1);
      assert.equal(scan.diagnostics.dueScheduleCount, 1);
      assert.equal(scan.diagnostics.outcomes.completed, 1);
      assert.deepEqual(runner.calls, [
        {
          command: "/worker/bin/copilot",
          args: ["--version"],
          options: { timeoutMs: 5_000 },
        },
        {
          command: "/worker/bin/copilot",
          args: [
            "-C",
            "/tmp/agent-scheduler",
            "--model",
            "gpt-5",
            "--output-format",
            "json",
            "--no-color",
            "--no-ask-user",
            "--allow-all-tools",
            "-p",
            "Run from the worker CLI due scan.",
          ],
          options: { timeoutMs: 1_800_000 },
        },
      ]);

      const history = await workerHistory(databasePath, "schedule_due_from_cli");
      assert.equal(history.length, 1);
      assert.equal(history[0]?.trigger, "automatic");
      assert.equal(history[0]?.status, "completed");
      assert.equal(history[0]?.externalRunId, "worker-cli-session");
      assert.equal(history[0]?.summary, "Worker CLI run completed.");
      assert.equal(history[0]?.error, null);
      assert.deepEqual(history[0]?.resolvedHarnessPolicy, {
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
          unattended: true,
        },
      });
    });
  });

  it("blocks worker due runs with fetch guidance when Copilot CLI is missing from PATH", async () => {
    await withWorkerStore(async (databasePath) => {
      await seedWorkerStore(databasePath, [
        workerSchedule({
          id: "schedule_missing_cli",
          approvalMode: "bypass-approvals",
          runInstructions: "Run only if the worker can find Copilot CLI.",
        }),
      ]);
      const runner = new RecordingCopilotCliCommandRunner({
        exitCode: null,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
        errorMessage: "spawn copilot ENOENT",
      });

      const scan = await runWorkerScan(databasePath, runner);

      assert.deepEqual(scan.startedRunIds, []);
      assert.equal(scan.diagnostics.outcomes.blocked, 1);
      assert.deepEqual(runner.calls, [
        {
          command: "/worker/bin/copilot",
          args: ["--version"],
          options: { timeoutMs: 5_000 },
        },
      ]);

      const history = await workerHistory(databasePath, "schedule_missing_cli");
      assert.equal(history[0]?.status, "blocked");
      assert.equal(history[0]?.error, COPILOT_CLI_MISSING_REASON);
      assert.match(history[0]?.error ?? "", /gh copilot/);
      assert.match(history[0]?.error ?? "", /OS wakeup triggers/);
      assert.match(history[0]?.error ?? "", /COPILOT_CLI_PATH/);
    });
  });

  it("blocks worker due runs with unattended auth guidance when Copilot CLI cannot authenticate", async () => {
    await withWorkerStore(async (databasePath) => {
      await seedWorkerStore(databasePath, [
        workerSchedule({
          id: "schedule_missing_auth",
          approvalMode: "bypass-approvals",
          runInstructions: "Run only if the worker can authenticate Copilot CLI.",
        }),
      ]);
      const runner = new RecordingCopilotCliCommandRunner({
        exitCode: null,
        stdout: "",
        stderr: "ERROR: SecItemCopyMatching failed -50",
      });

      const scan = await runWorkerScan(databasePath, runner);

      assert.deepEqual(scan.startedRunIds, []);
      assert.equal(scan.diagnostics.outcomes.blocked, 1);
      const history = await workerHistory(databasePath, "schedule_missing_auth");
      assert.equal(history[0]?.status, "blocked");
      assert.equal(history[0]?.error, COPILOT_CLI_AUTH_UNAVAILABLE_REASON);
      assert.match(history[0]?.error ?? "", /copilot login/);
      assert.match(history[0]?.error ?? "", /COPILOT_GITHUB_TOKEN/);
    });
  });

  it("blocks unattended worker Default Approvals before starting Copilot CLI", async () => {
    await withWorkerStore(async (databasePath) => {
      await seedWorkerStore(databasePath, [
        workerSchedule({
          id: "schedule_default_approvals",
          approvalMode: "default-approvals",
          runInstructions: "Run only if approvals can be shown.",
        }),
      ]);
      const runner = new RecordingCopilotCliCommandRunner({
        exitCode: 0,
        stdout: "GitHub Copilot CLI 1.0.69",
        stderr: "",
      });

      const scan = await runWorkerScan(databasePath, runner);

      assert.deepEqual(scan.startedRunIds, []);
      assert.equal(scan.diagnostics.outcomes.blocked, 1);
      assert.deepEqual(runner.calls, [
        {
          command: "/worker/bin/copilot",
          args: ["--version"],
          options: { timeoutMs: 5_000 },
        },
      ]);

      const history = await workerHistory(
        databasePath,
        "schedule_default_approvals",
      );
      assert.equal(history[0]?.status, "blocked");
      assert.match(history[0]?.error ?? "", /Default Approvals/);
      assert.match(history[0]?.error ?? "", /approval surface/);
      assert.deepEqual(history[0]?.resolvedHarnessPolicy, {
        provider: "copilot",
        harnessMode: "local-copilot",
        approvalMode: "default-approvals",
        approvalModeLabel: "Default Approvals",
        localCopilotMode: {
          approvalPreset: "default",
          permissionBehavior: "uses-copilot-default-approvals",
          cli: {
            promptFlag: "-p",
            outputFormat: "json",
            permissionFlags: [],
          },
          requiresApprovalSurface: true,
          unattended: true,
        },
      });
    });
  });
});

async function withWorkerStore(
  testBody: (databasePath: string) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "agent-scheduler-"));
  const databasePath = join(tempDirectory, "schedules.sqlite");

  try {
    await testBody(databasePath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function seedWorkerStore(
  databasePath: string,
  schedules: readonly Schedule[],
): Promise<void> {
  const store = new SqliteScheduleStore({ databasePath });
  try {
    await store.saveLocalSchedulingSetup({
      enabled: true,
      platform: "windows",
      triggerId: "AgentSchedulerLocalWakeup",
      installedAt: "2026-07-07T16:00:00.000Z",
      verifiedAt: null,
      updatedAt: "2026-07-07T16:00:00.000Z",
    });
    for (const schedule of schedules) {
      await store.saveSchedule(schedule);
    }
  } finally {
    store.close();
  }
}

async function runWorkerScan(
  databasePath: string,
  runner: RecordingCopilotCliCommandRunner,
): Promise<DueWorkScanResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await runWorkerCli(
      ["scan-due-work", "--store", databasePath],
      { stdout, stderr },
      { createCopilotLocalHarness: () => workerCopilotHarness(runner) },
    ),
    0,
  );
  assert.equal(stderr.length, 0);
  return JSON.parse(stdout[0] ?? "{}") as DueWorkScanResult;
}

function workerCopilotHarness(
  runner: RecordingCopilotCliCommandRunner,
): CopilotLocalHarness {
  return new CopilotLocalHarness({
    client: new CopilotCliLocalClient({
      command: "/worker/bin/copilot",
      runner,
    }),
  });
}

async function workerHistory(
  databasePath: string,
  scheduleId: string,
): Promise<RunHistoryEntry[]> {
  const store = new SqliteScheduleStore({ databasePath });
  try {
    return await store.listRunHistory(scheduleId);
  } finally {
    store.close();
  }
}

function workerSchedule(input: {
  id: string;
  approvalMode: Schedule["approvalMode"];
  runInstructions: string;
}): Schedule {
  return {
    id: input.id,
    revision: 1,
    status: "active",
    enabled: true,
    runInstructions: input.runInstructions,
    cadence: { type: "cron", expression: "0 * * * *" },
    targetContext: {
      type: "workspace",
      uri: "file:///tmp/agent-scheduler",
    },
    harnessMode: "local-copilot",
    model: "gpt-5",
    approvalMode: input.approvalMode,
    runCounter: { completed: 0, limit: null },
    nextRunAt: "2000-01-01T00:00:00.000Z",
    lastRunAt: null,
    createdAt: "2026-07-07T16:00:00.000Z",
    updatedAt: "2026-07-07T16:00:00.000Z",
  };
}

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

class RecordingWakeupProvider implements WakeupProvider {
  readonly platform = "windows";
  readonly installRequests: WakeupTriggerRequest[] = [];

  intentFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerIntent {
    return {
      operation,
      platform: this.platform,
      triggerId: request.triggerId,
      intervalMinutes: request.intervalMinutes,
      workerCommand: [
        request.workerExecutable,
        ...request.workerArguments,
      ].join(" "),
      commands: [
        {
          executable: "schtasks.exe",
          args: ["/Create", "/TN", request.triggerId],
          shellCommand: `schtasks.exe /Create /TN ${request.triggerId}`,
        },
      ],
      files: [],
    };
  }

  async install(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    this.installRequests.push(structuredClone(request));
    return { intent: this.intentFor("install", request), applied: true };
  }

  async verify(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    return { intent: this.intentFor("verify", request), applied: true };
  }

  async uninstall(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    return { intent: this.intentFor("uninstall", request), applied: true };
  }
}

class RecordingLocalSchedulingSetup {
  readonly operations: WakeupTriggerOperation[] = [];

  async install(): Promise<LocalSchedulingSetupResult> {
    this.operations.push("install");
    return localSchedulingResult("install", true);
  }

  async verify(): Promise<LocalSchedulingSetupResult> {
    this.operations.push("verify");
    return localSchedulingResult("verify", true);
  }

  async uninstall(): Promise<LocalSchedulingSetupResult> {
    this.operations.push("uninstall");
    return localSchedulingResult("uninstall", false);
  }
}

function localSchedulingResult(
  operation: WakeupTriggerOperation,
  enabled: boolean,
): LocalSchedulingSetupResult {
  return {
    intent: {
      operation,
      platform: "windows",
      triggerId: "AgentSchedulerLocalWakeup",
      intervalMinutes: 5,
      workerCommand: "node workerCli.js scan-due-work",
      commands: [],
      files: [],
    },
    state: {
      enabled,
      platform: enabled ? "windows" : null,
      triggerId: enabled ? "AgentSchedulerLocalWakeup" : null,
      installedAt: enabled ? "2026-07-07T16:00:00.000Z" : null,
      verifiedAt: operation === "verify" ? "2026-07-07T16:00:00.000Z" : null,
      updatedAt: "2026-07-07T16:00:00.000Z",
    },
  };
}
