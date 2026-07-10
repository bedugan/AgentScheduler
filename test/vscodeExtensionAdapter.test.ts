import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  LocalSchedulingSetup,
  MacOsLaunchdWakeupProvider,
  ScheduleLifecycle,
  SqliteScheduleStore,
  type WakeupProvider,
  type WakeupTriggerOperation,
  type WakeupTriggerRequest,
  type NaturalLanguageScheduleCreationResult,
  type LocalSchedulingSetupResult,
  type ScheduleDetailView,
} from "../src/index.js";
import {
  CREATE_SCHEDULE_CHAT_PARTICIPANT_ID,
  CREATE_SCHEDULE_CHAT_SLASH_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  CREATE_SCHEDULE_TOOL_NAME,
  DELETE_SCHEDULE_COMMAND,
  ENABLE_LOCAL_SCHEDULING_ACTION,
  NEW_SCHEDULE_COMMAND,
  OPEN_SCHEDULE_COMMAND,
  RUN_HISTORY_DETAIL_VIEW_TYPE,
  SCHEDULE_DETAIL_VIEW_TYPE,
  SCHEDULE_LIST_VIEW_ID,
  SQLITE_LOCAL_STORE_FILENAME,
  ScheduleTreeDataProvider,
  SqliteDataVersionMonitor,
  VisiblePanelRefreshMonitor,
  VsCodeTaskCopilotInteractiveExecutor,
  buildNewDraftScheduleInput,
  registerVsCodeScheduleCommands,
  renderScheduleDetailWebviewHtml,
  confirmEnableLocalScheduling,
  createDefaultVsCodeSchedulerServices,
  deployPackagedWorker,
  localSchedulingWakeupRequestForVsCode,
  resolveNodeRuntimeExecutable,
  renderRunHistoryDetailHtml,
  scheduleTreeItemForSummary,
  sqliteLocalStorePath,
  type VsCodeCommandsLike,
  type VsCodeDisposableLike,
  type VsCodeEventEmitterFactory,
  type VsCodeEventEmitterLike,
  type VsCodeEventLike,
  type VsCodeChatLike,
  type VsCodeChatRequestLike,
  type VsCodeChatResponseStreamLike,
  type VsCodeLanguageModelLike,
  type VsCodeLanguageModelToolLike,
  type VsCodeQuickPickItemLike,
  type VsCodeQuickPickOptionsLike,
  type VsCodeScheduleEditor,
  type ScheduleModelOption,
  type ScheduleTreeNode,
  type VsCodeTreeDataProviderLike,
  type VsCodeWebviewPanelLike,
  type VsCodeWebviewLike,
  type VsCodeWindowLike,
  type VsCodeTasksLike,
} from "../src/vscodeExtensionAdapter.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryLocalSchedulingSetupStore,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("VS Code extension adapter", () => {
  it("renders auditable Run History Detail snapshots and supported actions", () => {
    const html = renderRunHistoryDetailHtml({
      run: {
        id: "run_1",
        scheduleId: "schedule_1",
        scheduleRevision: 3,
        trigger: "manual",
        status: "running",
        startedAt: "2026-07-07T16:00:00.000Z",
        completedAt: null,
        runInstructionsSnapshot: "Review the workspace.",
        approvalModeSnapshot: "default-approvals",
        resolvedHarnessPolicy: { provider: "copilot" },
        harnessMode: "local-copilot",
        model: "auto",
        executedModel: null,
        targetContext: { type: "workspace", uri: "file:///tmp/project" },
        externalRunId: "copilot-session",
        summary: "Running.",
        error: null,
      },
      scheduleId: "schedule_1",
      scheduleRevision: 3,
      resolvedRunInstructions: "Review the workspace.",
      approvalMode: "default-approvals",
      selectedModel: "auto",
      executedModel: null,
      resolvedHarnessPolicy: { provider: "copilot" },
      outcome: {
        status: "running",
        completedAt: null,
        summary: "Running.",
        error: null,
        description: "Running.",
      },
      execution: {
        runId: "run_1",
        identity: "vscode-task:run_1",
        ownerId: "extension:current",
        startedAt: "2026-07-07T16:00:00.000Z",
        heartbeatAt: "2026-07-07T16:00:30.000Z",
        leaseExpiresAt: "2026-07-07T16:02:30.000Z",
        capabilities: { cancel: true, open: false, heartbeat: true },
        handle: "task-handle",
      },
      actions: {
        cancel: { kind: "cancel", label: "Cancel Run", enabled: true },
        open: {
          kind: "open",
          label: "Open Run",
          enabled: false,
          disabledReason: "Opening this execution is unsupported.",
        },
      },
    });

    assert.equal(RUN_HISTORY_DETAIL_VIEW_TYPE, "agentScheduler.runHistoryDetail");
    assert.match(html, /Review the workspace\./);
    assert.match(html, /vscode-task:run_1/);
    assert.match(html, /data-run-action="cancel"/);
    assert.match(html, /data-run-action="refresh"/);
    assert.match(html, /Last refreshed/);
    assert.match(html, /default-approvals/);
  });

  it("opens Run History Detail from a Previous Runs row", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const created = await editor.createDraftSchedule({
      runInstructions: "Create a reviewable run.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/history" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "bypass-approvals",
    });
    const run = await editor.runScheduleNow(created.schedule.id);
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor },
      viewColumn: 1,
    });
    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(created.schedule.id);

    await requiredPanel(window).webview.postMessageFromWebview({
      type: "open-run-history",
      runId: run.id,
    });

    assert.equal(window.panels[1]?.viewType, RUN_HISTORY_DETAIL_VIEW_TYPE);
    assert.match(window.panels[1]?.webview.html ?? "", /Create a reviewable run/);
  });

  it("refreshes an open Schedule Detail on demand without changing run state", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:00:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const created = await editor.createDraftSchedule({
      runInstructions: "Original instructions.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/refresh" },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor },
      viewColumn: 1,
    });
    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(created.schedule.id);
    const panel = requiredPanel(window);

    await editor.saveScheduleDetailEdits(created.schedule.id, {
      runInstructions: "Instructions changed by the extension.",
    });
    assert.doesNotMatch(panel.webview.html, /Instructions changed by the extension/);

    await panel.webview.postMessageFromWebview({
      type: "refresh",
      scheduleId: created.schedule.id,
    });

    assert.match(panel.webview.html, /Instructions changed by the extension/);
    assert.match(panel.webview.html, /data-action="refresh"/);
    assert.match(panel.webview.html, /Last refreshed/);
    assert.equal((await editor.openScheduleDetail(created.schedule.id)).overview.status, "draft");
  });

  it("detects worker writes through SQLite data_version for open-state refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-scheduler-version-"));
    const databasePath = join(directory, "schedules.sqlite");
    const reader = new SqliteScheduleStore({ databasePath });
    const worker = new SqliteScheduleStore({ databasePath });
    let refreshes = 0;
    const monitor = new SqliteDataVersionMonitor(
      () => reader.dataVersion(),
      () => {
        refreshes += 1;
      },
    );
    try {
      assert.equal(await worker.createSchedule({
        id: "schedule_worker_write",
        revision: 1,
        status: "draft",
        enabled: false,
        runInstructions: "Refresh the editor after worker changes.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: { type: "workspace", uri: "file:///tmp/refresh" },
        harnessMode: "local-copilot",
        model: "auto",
        approvalMode: "bypass-approvals",
        runCounter: { completed: 0, limit: null },
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2026-07-07T16:00:00.000Z",
        updatedAt: "2026-07-07T16:00:00.000Z",
      }), true);

      assert.equal(await monitor.poll(), true);
      assert.equal(refreshes, 1);
      assert.equal(await monitor.poll(), false);
    } finally {
      reader.close();
      worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes data_version refreshes, coalesces dirtiness, and stops queued work on dispose", async () => {
    let version = 1;
    let refreshes = 0;
    let release!: () => void;
    let refreshStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const monitor = new SqliteDataVersionMonitor(
      () => version,
      async () => {
        refreshes += 1;
        if (refreshes === 1) {
          refreshStarted();
          await gate;
        }
      },
    );

    version = 2;
    const firstRefresh = monitor.poll();
    await started;
    version = 3;
    assert.equal(await monitor.poll(), true);
    release();
    await firstRefresh;

    assert.equal(refreshes, 2);
    monitor.dispose();
    version = 4;
    assert.equal(await monitor.poll(), false);

    let disposedVersion = 1;
    let disposedRefreshes = 0;
    let releaseDisposed!: () => void;
    let disposedStarted!: () => void;
    const disposedGate = new Promise<void>((resolve) => {
      releaseDisposed = resolve;
    });
    const disposedStart = new Promise<void>((resolve) => {
      disposedStarted = resolve;
    });
    const disposedMonitor = new SqliteDataVersionMonitor(
      () => disposedVersion,
      async () => {
        disposedRefreshes += 1;
        disposedStarted();
        await disposedGate;
      },
    );
    disposedVersion = 2;
    const disposingRefresh = disposedMonitor.poll();
    await disposedStart;
    disposedVersion = 3;
    await disposedMonitor.poll();
    disposedMonitor.dispose();
    releaseDisposed();
    await disposingRefresh;
    assert.equal(disposedRefreshes, 1);
  });

  it("refreshes live metadata only for visible panels and coalesces overlapping polls", async () => {
    let visible = false;
    let refreshes = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const monitor = new VisiblePanelRefreshMonitor(
      () => visible,
      async () => {
        refreshes += 1;
        if (refreshes === 1) {
          started();
          await gate;
        }
      },
    );

    assert.equal(await monitor.poll(), false);
    visible = true;
    const firstPoll = monitor.poll();
    await refreshStarted;
    assert.equal(await monitor.poll(), true);
    release();
    await firstPoll;
    assert.equal(refreshes, 2);

    monitor.dispose();
    assert.equal(await monitor.poll(), false);
    assert.equal(refreshes, 2);
  });
  it("runs interactive Copilot through a VS Code Task terminal and waits for completion", async () => {
    const tasks = new RecordingTasks();
    const created: Array<{ name: string; command: string; args: readonly string[] }> = [];
    const executor = new VsCodeTaskCopilotInteractiveExecutor(tasks, {
      createCopilotTask: (name, command, args) => {
        created.push({ name, command, args });
        return { name };
      },
    });

    const resultPromise = executor.run("copilot", ["-i", "Review once."], {
      schedule: {
        id: "schedule_1",
        revision: 1,
        status: "draft",
        enabled: false,
        runInstructions: "Review once.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: { type: "workspace", uri: "file:///tmp/project" },
        harnessMode: "local-copilot",
        model: "auto",
        approvalMode: "default-approvals",
        runCounter: { completed: 0, limit: null },
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2026-07-07T16:00:00.000Z",
        updatedAt: "2026-07-07T16:00:00.000Z",
      },
      trigger: "manual",
      requestedAt: "2026-07-07T16:05:00.000Z",
      runInstructions: "Review once.",
      resolvedHarnessPolicy: {} as never,
    });
    await new Promise((resolve) => setImmediate(resolve));
    tasks.finish(0);

    assert.equal((await resultPromise).status, "completed");
    assert.deepEqual(created, [
      {
        name: "AgentScheduler: schedule_1",
        command: "copilot",
        args: ["-i", "Review once."],
      },
    ]);
  });

  it("captures an interactive task exit emitted before executeTask resolves", async () => {
    const tasks = new RecordingTasks();
    tasks.exitDuringExecute = 0;
    const executor = new VsCodeTaskCopilotInteractiveExecutor(tasks, {
      createCopilotTask: (name) => ({ name }),
    });

    const result = await Promise.race([
      executor.run("copilot", ["-i", "Review once."], interactiveTaskRequest()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Interactive Task completion was missed.")), 50),
      ),
    ]);

    assert.equal(result.status, "completed");
  });

  it("terminates an owned active VS Code Task when cancellation is supported", async () => {
    const tasks = new RecordingTasks();
    const executor = new VsCodeTaskCopilotInteractiveExecutor(tasks, {
      createCopilotTask: (name) => ({ name }),
    });
    let identity = "";
    const runPromise = executor.run(
      "copilot",
      ["-i", "Review once."],
      interactiveTaskRequest(),
      {
        started: async (execution) => {
          assert.match(execution.identity, /^vscode-task:/);
          identity = "execution:test";
          assert.equal(execution.capabilities.cancel, true);
        },
        heartbeat: async () => {},
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    const cancelPromise = executor.cancel(identity);
    assert.equal(tasks.terminations, 1);
    tasks.finish(130);
    assert.equal((await cancelPromise)?.status, "canceled");
    await runPromise;
  });

  it("keeps cancellation pending until Task end and times out without releasing it", async () => {
    const tasks = new RecordingTasks();
    const executor = new VsCodeTaskCopilotInteractiveExecutor(
      tasks,
      { createCopilotTask: (name) => ({ name }) },
      10,
    );
    let identity = "";
    const runPromise = executor.run(
      "copilot",
      ["-i", "Review once."],
      interactiveTaskRequest(),
      {
        started: async (execution) => {
          identity = "execution:test";
        },
        heartbeat: async () => {},
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      () => executor.cancel(identity),
      /Timed out waiting for the canceled VS Code Task to exit/,
    );
    tasks.finish(130);
    await runPromise;
  });

  it("reports completion when Task success wins a cancellation race", async () => {
    const tasks = new RecordingTasks();
    const executor = new VsCodeTaskCopilotInteractiveExecutor(tasks, {
      createCopilotTask: (name) => ({ name }),
    });
    let identity = "";
    const runPromise = executor.run(
      "copilot",
      ["-i", "Review once."],
      interactiveTaskRequest(),
      {
        started: async (execution) => {
          identity = "execution:test";
        },
        heartbeat: async () => {},
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const cancelPromise = executor.cancel(identity);
    tasks.finish(0);

    assert.equal((await cancelPromise)?.status, "completed");
    assert.equal((await runPromise).status, "completed");
  });

  it("does not start heartbeats when Task ends while start persistence is pending", async () => {
    const tasks = new RecordingTasks();
    const executor = new VsCodeTaskCopilotInteractiveExecutor(
      tasks,
      { createCopilotTask: (name) => ({ name }) },
      50,
      5,
    );
    let release!: () => void;
    let persistenceStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    let heartbeats = 0;
    const runPromise = executor.run(
      "copilot",
      ["-i", "Review once."],
      interactiveTaskRequest(),
      {
        started: async () => {
          persistenceStarted();
          await gate;
        },
        heartbeat: async () => {
          heartbeats += 1;
        },
      },
    );
    await started;
    tasks.finish(0);
    release();
    await runPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(heartbeats, 0);
  });
  it("registers the root package as a local UI extension with schedule commands", async () => {
    const manifest = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as {
      main?: string;
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command: string; title: string }>;
        chatParticipants?: Array<{
          id: string;
          name: string;
          commands?: Array<{ name: string; description: string }>;
        }>;
        languageModelTools?: Array<{
          name: string;
          toolReferenceName: string;
          inputSchema: Record<string, unknown>;
        }>;
        views?: Record<string, Array<{ id: string; name: string }>>;
        menus?: Record<string, Array<{ command: string; when?: string }>>;
      };
      extensionKind?: string[];
      engines?: { vscode?: string };
      scripts?: { "vscode:prepublish"?: string };
    };

    assert.equal(manifest.main, "./dist/src/vscodeExtension.js");
    assert.equal(manifest.scripts?.["vscode:prepublish"], "npm run build");
    assert.deepEqual(manifest.extensionKind, ["ui"]);
    assert.equal(typeof manifest.engines?.vscode, "string");
    assert.deepEqual(manifest.activationEvents, [
      `onCommand:${NEW_SCHEDULE_COMMAND}`,
      `onCommand:${OPEN_SCHEDULE_COMMAND}`,
      `onCommand:${DELETE_SCHEDULE_COMMAND}`,
      `onCommand:${CREATE_SCHEDULE_COMMAND}`,
      `onView:${SCHEDULE_LIST_VIEW_ID}`,
      `onLanguageModelTool:${CREATE_SCHEDULE_TOOL_NAME}`,
      `onChatParticipant:${CREATE_SCHEDULE_CHAT_PARTICIPANT_ID}`,
    ]);
    assert.deepEqual(
      manifest.contributes?.commands?.map((command) => command.command),
      [
        NEW_SCHEDULE_COMMAND,
        OPEN_SCHEDULE_COMMAND,
        DELETE_SCHEDULE_COMMAND,
        CREATE_SCHEDULE_COMMAND,
      ],
    );
    assert.deepEqual(manifest.contributes?.menus?.["view/item/context"], [
      {
        command: DELETE_SCHEDULE_COMMAND,
        when: `view == ${SCHEDULE_LIST_VIEW_ID} && viewItem == agentScheduler.schedule`,
        group: "inline",
      },
    ]);
    const toolContribution = manifest.contributes?.languageModelTools?.[0];
    assert.equal(toolContribution?.name, CREATE_SCHEDULE_TOOL_NAME);
    assert.equal(toolContribution?.toolReferenceName, "createSchedule");
    assert.deepEqual(
      toolContribution?.inputSchema,
      {
        type: "object",
        additionalProperties: false,
        required: ["naturalLanguageRequest"],
        properties: {
          naturalLanguageRequest: {
            type: "string",
            description: "The user's natural-language schedule creation request.",
          },
          runInstructions: {
            type: "string",
            description: "Inline instructions to run each time the schedule fires.",
          },
          cadence: {
            type: "object",
            additionalProperties: false,
            required: ["type", "expression"],
            properties: {
              type: { const: "cron" },
              expression: { type: "string" },
            },
          },
          targetContext: {
            type: "object",
            additionalProperties: false,
            required: ["type", "uri"],
            properties: {
              type: { const: "workspace" },
              uri: { type: "string" },
              label: { type: "string" },
            },
          },
          harnessMode: {
            type: "string",
            enum: ["local-copilot", "cloud-copilot"],
          },
          model: { type: "string" },
          approvalMode: {
            type: "string",
            enum: ["default-approvals", "bypass-approvals", "autopilot"],
          },
          runCap: {
            type: "object",
            additionalProperties: false,
            required: ["maxRuns"],
            properties: {
              maxRuns: { type: "integer", minimum: 1 },
            },
          },
          riskWarnings: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    );
    assert.deepEqual(manifest.contributes?.chatParticipants?.[0], {
      id: CREATE_SCHEDULE_CHAT_PARTICIPANT_ID,
      name: "agentScheduler",
      fullName: "AgentScheduler",
      description: "Create and review recurring agent schedules.",
      isSticky: false,
      commands: [
        {
          name: CREATE_SCHEDULE_CHAT_SLASH_COMMAND,
          description: "Create an AgentScheduler schedule from natural language.",
        },
      ],
    });
    assert.deepEqual(manifest.contributes?.views?.explorer, [
      {
        id: SCHEDULE_LIST_VIEW_ID,
        name: "AgentScheduler",
      },
    ]);
  });

  it("selects the SQLite Local Store under VS Code global storage", () => {
    const globalStoragePath = join(
      "/Users/ada/Library/Application Support/Code/User/globalStorage",
      "bedugan.agent-scheduler",
    );

    assert.equal(
      sqliteLocalStorePath({
        globalStorageUri: { fsPath: globalStoragePath },
      }),
      join(globalStoragePath, SQLITE_LOCAL_STORE_FILENAME),
    );
  });

  it("builds packaged Windows and macOS wakeup requests from installed paths", async () => {
    const extensionRoot = "/extensions/bedugan.agent-scheduler-0.1.0";
    const globalStoragePath = "/user/globalStorage/bedugan.agent-scheduler";
    const context = {
      globalStorageUri: { fsPath: globalStoragePath },
      extensionUri: { fsPath: extensionRoot },
    };

    const windows = localSchedulingWakeupRequestForVsCode(context, {
      platform: "win32",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    });
    assert.deepEqual(windows, {
      triggerId: "AgentSchedulerLocalWakeup",
      workerExecutable: "C:\\Program Files\\nodejs\\node.exe",
      workerArguments: [
        join(extensionRoot, "dist", "src", "workerCli.js"),
        "scan-due-work",
        "--store",
        join(globalStoragePath, SQLITE_LOCAL_STORE_FILENAME),
      ],
      intervalMinutes: 5,
    });

    const macos = localSchedulingWakeupRequestForVsCode(context, {
      platform: "darwin",
      nodeExecutable: "/opt/homebrew/bin/node",
      userId: 501,
      homeDirectory: "/Users/ada",
    });
    assert.equal(macos.workerArguments[0], join(extensionRoot, "dist", "src", "workerCli.js"));
    assert.equal(macos.triggerId, "com.bedugan.AgentScheduler.local-wakeup");
    assert.equal(
      macos.launchdPlistPath,
      join(
        "/Users/ada",
        "Library",
        "LaunchAgents",
        "com.bedugan.AgentScheduler.local-wakeup.plist",
      ),
    );
    assert.equal(macos.userId, 501);

    const vscodeIgnore = await readFile(".vscodeignore", "utf8");
    assert.equal(
      vscodeIgnore.split(/\r?\n/).some((pattern) => pattern === "dist/**"),
      false,
    );
    await readFile("dist/src/workerCli.js", "utf8");
  });

  it("resolves an absolute Node runtime without accepting Electron", () => {
    assert.equal(
      resolveNodeRuntimeExecutable({
        configuredPath: "/opt/homebrew/bin/node",
        processExecutable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
        searchPath: "/usr/bin:/opt/homebrew/bin",
        platform: "darwin",
        fileExists: (path) => path === "/opt/homebrew/bin/node",
        probeRuntime: () => true,
      }),
      "/opt/homebrew/bin/node",
    );
    assert.equal(
      resolveNodeRuntimeExecutable({
        processExecutable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
        searchPath: "/usr/bin:/opt/homebrew/bin",
        platform: "darwin",
        fileExists: (path) => path === "/opt/homebrew/bin/node",
        probeRuntime: () => true,
      }),
      "/opt/homebrew/bin/node",
    );
    assert.throws(
      () =>
        resolveNodeRuntimeExecutable({
          processExecutable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
          searchPath: "/usr/bin",
          platform: "darwin",
          fileExists: () => false,
          probeRuntime: () => true,
        }),
      /absolute Node\.js executable/,
    );
  });

  it("deploys the packaged worker to an immutable fingerprinted global-storage path", async () => {
    const globalStoragePath = await mkdtemp(join(tmpdir(), "agent-scheduler-worker-"));
    try {
      const context = {
        globalStorageUri: { fsPath: globalStoragePath },
        extensionUri: { fsPath: process.cwd() },
      };
      const first = deployPackagedWorker(context);
      const second = deployPackagedWorker(context);

      assert.deepEqual(second, first);
      assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(first.workerPath.startsWith(globalStoragePath), true);
      await readFile(first.workerPath, "utf8");
      const marker = JSON.parse(
        await readFile(
          join(globalStoragePath, "worker", first.fingerprint, "deployment.json"),
          "utf8",
        ),
      ) as { fingerprint: string };
      assert.equal(marker.fingerprint, first.fingerprint);

      await writeFile(first.workerPath, "corrupted worker", "utf8");
      const repaired = deployPackagedWorker(context);
      assert.deepEqual(repaired, first);
      assert.doesNotMatch(await readFile(repaired.workerPath, "utf8"), /corrupted worker/);
    } finally {
      await rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  it("converges simultaneous first installs and corruption repairs", async () => {
    const globalStoragePath = await mkdtemp(
      join(tmpdir(), "agent-scheduler-race-"),
    );
    try {
      const firstBarrier = join(globalStoragePath, "start-first");
      const firstResults = await runConcurrentWorkerDeployments(
        process.cwd(),
        globalStoragePath,
        firstBarrier,
      );
      assert.deepEqual(firstResults[0], firstResults[1]);

      await writeFile(firstResults[0]!.workerPath, "corrupted worker", "utf8");
      const repairBarrier = join(globalStoragePath, "start-repair");
      const repairedResults = await runConcurrentWorkerDeployments(
        process.cwd(),
        globalStoragePath,
        repairBarrier,
      );
      assert.deepEqual(repairedResults[0], repairedResults[1]);
      assert.deepEqual(repairedResults[0], firstResults[0]);
      assert.doesNotMatch(
        await readFile(repairedResults[0]!.workerPath, "utf8"),
        /corrupted worker/,
      );
      const workerEntries = await readdir(join(globalStoragePath, "worker"));
      assert.equal(
        workerEntries.some((entry) =>
          /\.(?:tmp|corrupt|claim)(?:\.|$)/.test(entry),
        ),
        false,
      );
    } finally {
      await rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  it("wires Local Scheduling into the shipped default service composition", async () => {
    const globalStoragePath = await mkdtemp(join(tmpdir(), "agent-scheduler-vscode-"));
    const provider = new TestWakeupProvider();
    const window = new RecordingWindow();
    window.warningMessageResponses.push(ENABLE_LOCAL_SCHEDULING_ACTION);
    const services = createDefaultVsCodeSchedulerServices(
      {
        globalStorageUri: { fsPath: globalStoragePath },
        extensionUri: { fsPath: process.cwd() },
      },
      {
        window,
        platform: process.platform === "win32" ? "win32" : "darwin",
        nodeExecutable: process.execPath,
        userId: 501,
        provider,
      },
    );

    try {
      assert.equal(typeof services.dataVersion, "function");
      assert.equal(Object.hasOwn(services, "lifecycle"), false);
      const intent = services.editor.previewEnableLocalScheduling?.();
      assert.match(
        intent?.workerCommand ?? "",
        /[/\\]worker[/\\][a-f0-9]{64}[/\\]workerCli\.js/,
      );
      assert.equal(intent?.workerCommand.includes(SQLITE_LOCAL_STORE_FILENAME), true);
      await services.editor.enableLocalScheduling?.();
      assert.deepEqual(provider.operations, ["install"]);
      assert.equal(window.warningMessages.length, 1);
    } finally {
      services.close?.();
      await rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  it("keeps the extension available when Local Scheduling prerequisites are unavailable", async () => {
    const globalStoragePath = await mkdtemp(join(tmpdir(), "agent-scheduler-linux-"));
    const services = createDefaultVsCodeSchedulerServices(
      {
        globalStorageUri: { fsPath: globalStoragePath },
        extensionUri: { fsPath: process.cwd() },
      },
      {
        window: new RecordingWindow(),
        platform: "linux",
      },
    );

    try {
      assert.equal(services.localSchedulingSetupAvailability?.available, false);
      assert.match(
        services.localSchedulingSetupAvailability?.reason ?? "",
        /not supported on linux/,
      );
      const draft = await services.editor.createDraftSchedule({
        runInstructions: "Editing still works without Local Scheduling.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: { type: "workspace", uri: "file:///tmp/project" },
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
      });
      assert.equal(draft.schedule.status, "draft");
    } finally {
      services.close?.();
      await rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  it("keeps editing available when Node exists but fails the worker capability probe", async () => {
    const globalStoragePath = await mkdtemp(join(tmpdir(), "agent-scheduler-node-"));
    const seededStore = new SqliteScheduleStore({
      databasePath: join(globalStoragePath, SQLITE_LOCAL_STORE_FILENAME),
    });
    await seededStore.saveLocalSchedulingSetup({
      enabled: true,
      platform: "windows",
      triggerId: "com.bedugan.AgentScheduler.local-wakeup",
      installedAt: "2026-07-07T16:00:00.000Z",
      verifiedAt: null,
      updatedAt: "2026-07-07T16:00:00.000Z",
    });
    seededStore.close();
    const provider = new TestWakeupProvider();
    const services = createDefaultVsCodeSchedulerServices(
      {
        globalStorageUri: { fsPath: globalStoragePath },
        extensionUri: { fsPath: process.cwd() },
      },
      {
        window: new RecordingWindow(),
        platform: "darwin",
        nodeExecutable: process.execPath,
        userId: 501,
        runtimeProbe: () => false,
        provider,
      },
    );

    try {
      assert.equal(services.localSchedulingSetupAvailability?.available, false);
      assert.match(
        services.localSchedulingSetupAvailability?.reason ?? "",
        /absolute Node\.js executable/,
      );
      assert.deepEqual(await services.editor.listSchedules(), []);
      const draft = await services.editor.createDraftSchedule({
        runInstructions: "Manage persisted setup after Node disappears.",
        cadence: { type: "cron", expression: "0 * * * *" },
        targetContext: { type: "workspace", uri: "file:///tmp/project" },
        harnessMode: "local-copilot",
        model: "auto",
        approvalMode: "default-approvals",
      });
      assert.equal(draft.localScheduling.enabled, true);
      assert.equal(services.localSchedulingSetupAvailability?.canManage, true);
      await assert.rejects(
        () => services.editor.enableLocalScheduling!(),
        /absolute Node\.js executable/,
      );
      const disabled = await services.editor.disableLocalScheduling!();
      assert.equal(disabled.state.enabled, false);
      assert.deepEqual(provider.operations, ["uninstall"]);
    } finally {
      services.close?.();
      await rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  it("builds New Schedule draft defaults from the current workspace", () => {
    const input = buildNewDraftScheduleInput({
      workspaceFolders: [
        {
          name: "AgentScheduler",
          uri: {
            toString: () => "file:///Users/ada/src/AgentScheduler",
          },
        },
      ],
    });

    assert.deepEqual(input, {
      runInstructions: "",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "auto",
      approvalMode: "default-approvals",
    });
    assert.equal(Object.hasOwn(input, "runCap"), false);

    assert.equal(
      buildNewDraftScheduleInput({ workspaceFolders: [] }).targetContext,
      null,
    );
  });

  it("renders catalog models and defaults new schedules to an available Copilot model", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel([
      {
        id: "openai-gpt-5",
        vendor: "openai",
        family: "gpt-5",
        version: "2026-01",
        displayName: "OpenAI GPT-5",
        maxInputTokens: 128000,
      },
      {
        id: "copilot-gpt-4.1",
        vendor: "copilot",
        family: "gpt-4.1",
        version: "2026-02",
        displayName: "Copilot GPT-4.1",
        maxInputTokens: 128000,
      },
    ]);

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      languageModel,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;

    assert.equal(detail.schedule.model, "copilot-gpt-4.1");
    assert.match(
      requiredPanel(window).webview.html,
      /<select id="model" name="model">/,
    );
    assert.match(
      requiredPanel(window).webview.html,
      /value="copilot-gpt-4\.1" selected/,
    );

    const legacySchedule = await lifecycle.createDraftSchedule({
      runInstructions: "Keep this legacy model editable.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "legacy-model",
      approvalMode: "default-approvals",
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(legacySchedule.id);
    assert.match(
      requiredPanel(window).webview.html,
      /legacy-model \(unavailable or legacy\)/,
    );
    assert.match(
      requiredPanel(window).webview.html,
      /Saved model is unavailable or legacy for the selected harness\./,
    );
  });

  it("prefers Local Copilot harness model selectors over VS Code chat model ids", async () => {
    class ModelAwareHarness extends FakeHarness {
      async models() {
        return [{ id: "auto", displayName: "Auto", vendor: "GitHub Copilot" }];
      }
    }
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new ModelAwareHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      languageModel: new RecordingLanguageModel([
        { id: "vscode-chat-model", displayName: "VS Code Chat Model" },
      ]),
    });

    const detail = (await commandCallback(commands, NEW_SCHEDULE_COMMAND)()) as ScheduleDetailView;
    assert.equal(detail.schedule.model, "auto");
    assert.match(requiredPanel(window).webview.html, /value="auto" selected/);
    assert.doesNotMatch(requiredPanel(window).webview.html, /vscode-chat-model/);
  });

  it("keeps a manual model input fallback when VS Code reports no chat models", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      languageModel: new RecordingLanguageModel([]),
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;

    assert.equal(detail.schedule.model, "auto");
    assert.match(
      requiredPanel(window).webview.html,
      /name="model"[^>]*value="auto"/,
    );
    assert.match(
      requiredPanel(window).webview.html,
      /selected harness reported no model choices/,
    );
  });

  it("does not expose unavailable Copilot harness modes as runnable choices", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const html = requiredPanel(window).webview.html;

    assert.equal(detail.schedule.harnessMode, null);
    assert.doesNotMatch(html, /value="local-copilot"/);
    assert.doesNotMatch(html, /value="cloud-copilot"/);
    assert.match(
      html,
      /No Copilot harness modes are available in this VS Code environment\./,
    );
    assert.match(html, /data-action="activate" data-state="disabled" disabled/);
    assert.match(html, /data-action="run-now" data-state="disabled" disabled/);
  });

  it("shows Copilot CLI setup guidance for unavailable registered Local Copilot Mode", async () => {
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
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const html = requiredPanel(window).webview.html;

    assert.equal(detail.schedule.harnessMode, null);
    assert.doesNotMatch(html, /value="local-copilot"/);
    assert.match(html, /gh copilot/);
    assert.match(html, /copilot.+PATH/);
    assert.match(html, /data-action="activate" data-state="disabled" disabled/);
    assert.match(html, /data-action="run-now" data-state="disabled" disabled/);
  });

  it("renders local and cloud harness modes only when registered", async () => {
    const localOnlyLifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const localCommands = new RecordingCommands();
    const localWindow = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: localCommands,
      window: localWindow,
      workspace: {},
      services: { editor: new EditorControlSurface(localOnlyLifecycle) },
      viewColumn: 1,
    });

    const localDetail = (await commandCallback(
      localCommands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    assert.equal(localDetail.schedule.harnessMode, "local-copilot");
    assert.match(requiredPanel(localWindow).webview.html, /value="local-copilot"/);
    assert.doesNotMatch(
      requiredPanel(localWindow).webview.html,
      /value="cloud-copilot"/,
    );

    const cloudOnlyLifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "cloud-copilot" })],
    });
    const cloudCommands = new RecordingCommands();
    const cloudWindow = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: cloudCommands,
      window: cloudWindow,
      workspace: {},
      services: { editor: new EditorControlSurface(cloudOnlyLifecycle) },
      viewColumn: 1,
    });

    const cloudDetail = (await commandCallback(
      cloudCommands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    assert.equal(cloudDetail.schedule.harnessMode, "cloud-copilot");
    assert.match(requiredPanel(cloudWindow).webview.html, /value="cloud-copilot"/);
    assert.doesNotMatch(
      requiredPanel(cloudWindow).webview.html,
      /value="local-copilot"/,
    );
  });

  it("maps schedules and the empty state into Schedule List tree items", async () => {
    const provider = new ScheduleTreeDataProvider(
      new StaticScheduleEditor([]),
      new RecordingEventEmitterFactory(),
    );
    const emptyChildren = await provider.getChildren();

    assert.deepEqual(emptyChildren, [{ kind: "empty" }]);
    assert.deepEqual(provider.getTreeItem(emptyChildren[0]!), {
      label: "No schedules yet",
      description: "Create a Draft Schedule",
      tooltip: "Run AgentScheduler: New Schedule to create a Draft Schedule.",
      command: {
        command: NEW_SCHEDULE_COMMAND,
        title: "New Schedule",
      },
      contextValue: "agentScheduler.emptyScheduleList",
    });

    const item = scheduleTreeItemForSummary({
      id: "schedule_1",
      status: "active",
      enabled: true,
      nextRunAt: "2026-07-07T17:00:00.000Z",
      lastRunAt: null,
      runCounter: { completed: 0, limit: 3 },
      runInstructions:
        "Review all open release blockers and summarize the highest-risk follow-up items.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    assert.equal(
      item.label,
      "Review all open release blockers and summarize the highes...",
    );
    assert.equal(
      item.description,
      "active / next: 2026-07-07T17:00:00.000Z",
    );
    assert.match(item.tooltip ?? "", /Status: active/);
    assert.deepEqual(item.command, {
      command: OPEN_SCHEDULE_COMMAND,
      title: "Open Schedule",
      arguments: ["schedule_1"],
    });

    const inactiveAutomaticRunsItem = scheduleTreeItemForSummary({
      id: "schedule_2",
      status: "active",
      enabled: true,
      automaticRuns: "inactive",
      nextRunAt: "2026-07-07T18:00:00.000Z",
      lastRunAt: null,
      runCounter: { completed: 0, limit: null },
      runInstructions: "Review inactive automatic scheduling display.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    assert.equal(
      inactiveAutomaticRunsItem.description,
      "active / automatic runs inactive until Local Scheduling is enabled",
    );
    assert.match(
      inactiveAutomaticRunsItem.tooltip ?? "",
      /Automatic runs inactive until Local Scheduling is enabled/,
    );
  });

  it("registers editor-backed schedule commands at the adapter boundary", () => {
    const context = recordingContext();
    const commands = new RecordingCommands();

    registerVsCodeScheduleCommands({
      context,
      commands,
      window: new RecordingWindow(),
      workspace: {},
      services: { editor: new EmptyScheduleEditor() },
      viewColumn: 1,
    });

    assert.deepEqual([...commands.registrations.keys()], [
      NEW_SCHEDULE_COMMAND,
      OPEN_SCHEDULE_COMMAND,
      DELETE_SCHEDULE_COMMAND,
      CREATE_SCHEDULE_COMMAND,
    ]);
    assert.equal(context.subscriptions.length, 5);
  });

  it("registers natural-language creation surfaces and activates complete tool requests after confirmation", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel();
    const chat = new RecordingChat();
    window.informationMessageResponses.push("Create Active Schedule");

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      eventEmitterFactory: new RecordingEventEmitterFactory(),
      languageModel,
      chat,
    });

    assert.ok(commands.registrations.has(CREATE_SCHEDULE_COMMAND));
    assert.ok(languageModel.tools.has(CREATE_SCHEDULE_TOOL_NAME));
    assert.ok(chat.participants.has(CREATE_SCHEDULE_CHAT_PARTICIPANT_ID));

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest: "run every hour to review bug branches",
          runCap: { maxRuns: 2 },
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "activated");
    assert.equal(result.source, "language-model-tool");
    assert.equal(result.schedule.status, "active");
    assert.equal(result.schedule.enabled, true);
    assert.equal(result.schedule.runInstructions, "Review bug branches.");
    assert.deepEqual(result.schedule.targetContext, {
      type: "workspace",
      uri: "file:///Users/ada/src/AgentScheduler",
      label: "AgentScheduler",
    });
    assert.equal(result.schedule.harnessMode, "local-copilot");
    assert.equal(result.schedule.model, "auto");
    assert.equal(result.schedule.approvalMode, "default-approvals");
    assert.deepEqual(result.schedule.runCounter, { completed: 0, limit: 2 });
    assert.equal(window.informationMessages.length, 1);
    assert.match(window.informationMessages[0] ?? "", /Create active/);
    assert.equal(window.panels.length, 1);
    assert.match(window.panels[0]?.webview.html ?? "", /Review bug branches\./);
  });

  it("uses an available catalog model during natural-language schedule creation", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const languageModel = new RecordingLanguageModel([
      {
        id: "copilot-gpt-4.1",
        vendor: "copilot",
        family: "gpt-4.1",
        displayName: "Copilot GPT-4.1",
      },
    ]);
    const window = new RecordingWindow();
    window.informationMessageResponses.push("Create Active Schedule");

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: new RecordingCommands(),
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      languageModel,
    });

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest: "run every hour to review bug branches",
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "activated");
    assert.equal(result.schedule.model, "copilot-gpt-4.1");
    assert.match(
      requiredPanel(window).webview.html,
      /value="copilot-gpt-4\.1" selected/,
    );
  });

  it("strips recurrence wording from VS Code tool-created run instructions", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const languageModel = new RecordingLanguageModel();
    const window = new RecordingWindow();
    window.informationMessageResponses.push("Create Active Schedule");

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: new RecordingCommands(),
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      languageModel,
    });

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest: "Run every hour and check the current time",
          runInstructions: "Run every hour and check the current time",
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "activated");
    assert.deepEqual(result.schedule.cadence, {
      type: "cron",
      expression: "0 * * * *",
    });
    assert.equal(result.schedule.runInstructions, "Check the current time.");
    assert.doesNotMatch(result.schedule.runInstructions, /run every hour/i);
    assert.match(requiredPanel(window).webview.html, /Check the current time\./);
  });

  it("creates a draft from natural language when the requested harness is unavailable", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [],
    });
    const editor = new EditorControlSurface(lifecycle);
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: new RecordingCommands(),
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      languageModel,
    });

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest: "run every hour to review bug branches",
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "draft");
    assert.equal(result.schedule.status, "draft");
    assert.equal(result.schedule.enabled, false);
    assert.deepEqual(result.validationMessages, [
      "Local Copilot Mode is unavailable in this VS Code environment because no Local Copilot Mode harness is registered. Install or enable the matching Copilot integration, or choose another available harness mode.",
    ]);
    assert.equal(window.informationMessages.length, 0);
    assert.match(
      requiredPanel(window).webview.html,
      /Local Copilot Mode is unavailable in this VS Code environment/,
    );
  });

  it("creates a draft and opens Schedule Detail when creation confirmation is declined", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel();
    window.informationMessageResponses.push(undefined);

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: new RecordingCommands(),
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      languageModel,
    });

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest: "run every hour to review bug branches",
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "draft");
    assert.deepEqual(result.validationMessages, ["Activation was not confirmed."]);
    assert.equal(result.schedule.status, "draft");
    assert.equal(result.schedule.enabled, false);
    assert.equal(window.informationMessages.length, 1);
    assert.equal(window.panels.length, 1);
    assert.match(window.panels[0]?.webview.html ?? "", /Review bug branches\./);
  });

  it("creates a draft fallback for risky requests without asking for activation confirmation", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands: new RecordingCommands(),
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      languageModel,
    });

    const result = (await languageModel
      .requiredTool(CREATE_SCHEDULE_TOOL_NAME)
      .invoke({
        input: {
          naturalLanguageRequest:
            "run every hour to delete stale release branches",
        },
      })) as NaturalLanguageScheduleCreationResult;

    assert.equal(result.outcome, "draft");
    assert.deepEqual(result.validationMessages, [
      "Request includes potentially destructive work and must be reviewed before automatic recurrence.",
    ]);
    assert.equal(result.schedule.status, "draft");
    assert.equal(result.schedule.enabled, false);
    assert.equal(window.informationMessages.length, 0);
    assert.equal(window.panels.length, 1);
  });

  it("routes chat, slash-command, and command fallback schedule creation through Schedule Detail", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [
        new FakeHarness({ mode: "local-copilot" }),
        new FakeHarness({ mode: "cloud-copilot" }),
      ],
    });
    const editor = new EditorControlSurface(lifecycle);
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const chat = new RecordingChat();
    window.informationMessageResponses.push(
      "Create Active Schedule",
      "Create Active Schedule",
      "Create Active Schedule",
    );
    window.inputBoxResponses.push(
      "run every hour to review security advisories",
    );

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor },
      viewColumn: 1,
      chat,
    });
    const participant = chat.requiredParticipant(CREATE_SCHEDULE_CHAT_PARTICIPANT_ID);
    const stream = new RecordingChatResponseStream();

    const chatResult = await participant.handleRequest(
      {
        prompt: "run every hour in Cloud Copilot Mode to review release branches",
      },
      stream,
    );
    const slashResult = await participant.handleRequest(
      {
        command: CREATE_SCHEDULE_CHAT_SLASH_COMMAND,
        prompt: "run every hour to delete stale release branches",
      },
      stream,
    );
    const commandResult = (await commandCallback(commands, CREATE_SCHEDULE_COMMAND)({
      naturalLanguageRequest: "run every hour to review dependency updates",
    })) as Awaited<ReturnType<RecordingChatParticipant["handleRequest"]>>;
    const promptedCommandResult = (await commandCallback(
      commands,
      CREATE_SCHEDULE_COMMAND,
    )()) as Awaited<ReturnType<RecordingChatParticipant["handleRequest"]>>;

    assert.equal(chatResult.source, "chat-participant");
    assert.equal(chatResult.outcome, "activated");
    assert.equal(chatResult.schedule.harnessMode, "cloud-copilot");
    assert.equal(slashResult.source, "slash-command");
    assert.equal(slashResult.outcome, "draft");
    assert.equal(commandResult.source, "slash-command");
    assert.equal(commandResult.outcome, "activated");
    assert.equal(promptedCommandResult.source, "slash-command");
    assert.equal(promptedCommandResult.outcome, "activated");
    assert.equal(window.inputBoxPrompts.length, 1);
    assert.equal(window.panels.length, 4);
    assert.match(
      window.panels.at(-1)?.webview.html ?? "",
      /Review security advisories\./,
    );
    assert.equal(stream.markdownMessages.length, 2);
    assert.match(stream.markdownMessages[0] ?? "", /Created active schedule/);
    assert.match(stream.markdownMessages[1] ?? "", /Created draft schedule/);
  });

  it("registers the Schedule List tree and refreshes it after schedule mutations", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const eventEmitterFactory = new RecordingEventEmitterFactory();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      eventEmitterFactory,
    });
    const provider = window.requiredTreeProvider(SCHEDULE_LIST_VIEW_ID);
    const refreshes: Array<ScheduleTreeNode | undefined> = [];
    provider.onDidChangeTreeData?.((event) => {
      refreshes.push(event);
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const panel = requiredPanel(window);

    await panel.webview.postMessageFromWebview({
      type: "save",
      scheduleId: detail.schedule.id,
      fields: {
        runInstructions: "Exercise tree refresh triggers.",
        cadenceExpression: "0 * * * *",
        targetContextUri: "file:///Users/ada/src/AgentScheduler",
        targetContextLabel: "AgentScheduler",
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
        runCapMaxRuns: "1",
      },
    });
    await panel.webview.postMessageFromWebview({
      type: "activate",
      scheduleId: detail.schedule.id,
    });
    await panel.webview.postMessageFromWebview({
      type: "pause",
      scheduleId: detail.schedule.id,
    });
    await panel.webview.postMessageFromWebview({
      type: "resume",
      scheduleId: detail.schedule.id,
    });
    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: detail.schedule.id,
    });
    await panel.webview.postMessageFromWebview({
      type: "restart",
      scheduleId: detail.schedule.id,
    });

    assert.equal(refreshes.length, 7);
    assert.deepEqual(refreshes, [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const children = await provider.getChildren();
    assert.equal(children[0]?.kind, "schedule");
  });

  it("confirms and deletes schedules from detail and list actions", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const eventEmitterFactory = new RecordingEventEmitterFactory();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      eventEmitterFactory,
    });
    const provider = window.requiredTreeProvider(SCHEDULE_LIST_VIEW_ID);
    const refreshes: Array<ScheduleTreeNode | undefined> = [];
    provider.onDidChangeTreeData?.((event) => {
      refreshes.push(event);
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const panel = requiredPanel(window);
    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: detail.schedule.id,
    });
    assert.equal((await store.listRunHistory(detail.schedule.id)).length, 1);

    window.warningMessageResponses.push("Delete Schedule");
    await panel.webview.postMessageFromWebview({
      type: "delete",
      scheduleId: detail.schedule.id,
    });

    assert.equal(window.warningMessages[0], "Delete AgentScheduler schedule?");
    assert.equal(panel.disposeCalls, 1);
    assert.deepEqual(await store.listSchedules(), []);
    assert.deepEqual(await store.listRunHistory(detail.schedule.id), []);

    const second = await lifecycle.createDraftSchedule({
      runInstructions: "Delete this schedule from the tree.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    window.warningMessageResponses.push("Delete Schedule");
    await commandCallback(commands, DELETE_SCHEDULE_COMMAND)({
      kind: "schedule",
      schedule: {
        id: second.id,
      },
    });

    assert.equal(await store.getSchedule(second.id), undefined);
    assert.ok(refreshes.length >= 3);
  });

  it("refreshes open Schedule Detail model choices when VS Code chat models change", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Refresh model choices.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "copilot-gpt-4.1",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    const languageModel = new RecordingLanguageModel([
      {
        id: "copilot-gpt-4.1",
        vendor: "copilot",
        family: "gpt-4.1",
        displayName: "Copilot GPT-4.1",
      },
    ]);

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      languageModel,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);
    assert.match(panel.webview.html, /value="copilot-gpt-4\.1" selected/);

    languageModel.setModels([
      {
        id: "copilot-gpt-5",
        vendor: "copilot",
        family: "gpt-5",
        displayName: "Copilot GPT-5",
      },
    ]);
    await settleAsyncWork();

    assert.match(
      panel.webview.html,
      /copilot-gpt-4\.1 \(unavailable or legacy\)/,
    );
    assert.match(panel.webview.html, /value="copilot-gpt-5"/);
  });

  it("creates a real draft schedule and opens its Schedule Detail webview", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const schedules = await store.listSchedules();

    assert.equal(schedules.length, 1);
    assert.equal(detail.schedule.id, schedules[0]?.id);
    assert.equal(detail.schedule.status, "draft");
    assert.equal(detail.schedule.enabled, false);
    assert.equal(detail.schedule.nextRunAt, null);
    assert.deepEqual(detail.schedule.cadence, {
      type: "cron",
      expression: "0 * * * *",
    });
    assert.deepEqual(detail.schedule.targetContext, {
      type: "workspace",
      uri: "file:///Users/ada/src/AgentScheduler",
      label: "AgentScheduler",
    });
    assert.equal(detail.schedule.harnessMode, "local-copilot");
    assert.equal(detail.schedule.model, "auto");
    assert.equal(detail.schedule.approvalMode, "default-approvals");
    assert.deepEqual(detail.schedule.runCounter, { completed: 0, limit: null });

    const panel = window.panels[0];
    assert.equal(panel?.viewType, SCHEDULE_DETAIL_VIEW_TYPE);
    assert.equal(panel?.title, "AgentScheduler Schedule");
    assert.deepEqual(panel?.options, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    assert.match(panel?.webview.html ?? "", /Editable Fields/);
    assert.match(panel?.webview.html ?? "", /name="model"[^>]*value="auto"/);
    assert.match(panel?.webview.html ?? "", /data-action="activate"/);
    assert.match(
      panel?.webview.html ?? "",
      /Automatic runs are inactive until local scheduling setup is enabled\./,
    );
  });

  it("renders active next-run and cadence display from Local Scheduling state", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: true,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const active = await lifecycle.createActiveSchedule({
      runInstructions: "Show active automatic scheduling.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const customCron = await lifecycle.createDraftSchedule({
      runInstructions: "Show custom cron cadence.",
      cadence: { type: "cron", expression: "15,45 9-17 * * 1-5" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(active.id);
    assert.match(
      requiredPanel(window).webview.html,
      /2026-07-07T17:00:00\.000Z/,
    );
    assert.match(requiredPanel(window).webview.html, /Every hour/);

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(customCron.id);
    assert.match(
      requiredPanel(window).webview.html,
      /custom cron: 15,45 9-17 \* \* 1-5/,
    );
  });

  it("opens a Schedule Detail webview from the real view model without browser DOM tests", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Review issue #23 and report open risks.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    clock.set("2026-07-07T16:10:00.000Z");
    await editor.runScheduleNow(schedule.id);

    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);

    const html = window.panels.at(-1)?.webview.html ?? "";
    assert.match(html, /Review issue #23 and report open risks\./);
    assert.match(html, /Previous Runs/);
    assert.match(html, /Fake harness completed the draft run\./);
    assert.match(html, /data-action="run-now" data-state="enabled"/);
    assert.match(html, /Local Scheduling/);
    assert.match(html, /name="approvalMode"/);
    assert.match(html, /value="default-approvals" selected/);
    assert.match(html, /VS Code Task terminal \(managed Copilot CLI fallback\)/);
  });

  it("suppresses repeated Run Now clicks and marks the button busy before backend response", async () => {
    const lifecycle = new ScheduleLifecycle({
      clock: new FakeClock("2026-07-07T16:05:00.000Z"),
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const detail = await editor.createDraftSchedule({
      runInstructions: "Review issue #55 and report open risks.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const html = renderScheduleDetailWebviewHtml(detail);
    const script = scriptContentFrom(html);
    const postedMessages: unknown[] = [];
    const form = {
      dataset: { scheduleId: detail.schedule.id },
      elements: { namedItem: () => ({ value: "" }) },
      addEventListener: () => undefined,
    };
    const runNowButton = new FakeWebviewButton("run-now", "Run Now");
    const document = {
      querySelector: (selector: string) =>
        selector === "#schedule-detail-form" ? form : null,
      querySelectorAll: (selector: string) =>
        selector === 'button[data-action]:not([data-action="save"])'
          ? [runNowButton]
          : [],
    };

    Function("acquireVsCodeApi", "document", script)(
      () => ({
        postMessage: (message: unknown) => {
          postedMessages.push(message);
        },
      }),
      document,
    );

    runNowButton.click();
    runNowButton.click();
    runNowButton.click();

    assert.deepEqual(postedMessages, [
      {
        type: "run-now",
        scheduleId: detail.schedule.id,
        fields: {
          runInstructions: "",
          cadenceExpression: "",
          targetContextUri: "",
          targetContextLabel: "",
          harnessMode: "",
          agentProfile: "",
          model: "",
          approvalMode: "",
          runCapMaxRuns: "",
        },
      },
    ]);
    assert.equal(runNowButton.disabled, true);
    assert.equal(runNowButton.dataset.state, "busy");
    assert.equal(runNowButton.attributes.get("aria-busy"), "true");
    assert.equal(runNowButton.attributes.get("aria-live"), "polite");
    assert.equal(runNowButton.textContent, "Starting...");
  });

  it("routes Schedule List selections through Open Schedule and focuses an existing detail panel", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const detail = await editor.createDraftSchedule({
      runInstructions: "Open this schedule from the tree.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor },
      viewColumn: 1,
      eventEmitterFactory: new RecordingEventEmitterFactory(),
    });
    const treeItem = scheduleTreeItemForSummary({
      id: detail.schedule.id,
      status: detail.schedule.status,
      enabled: detail.schedule.enabled,
      nextRunAt: detail.schedule.nextRunAt,
      lastRunAt: detail.schedule.lastRunAt,
      runCounter: detail.schedule.runCounter,
      runInstructions: detail.schedule.runInstructions,
      cadence: detail.schedule.cadence,
      targetContext: detail.schedule.targetContext,
      harnessMode: detail.schedule.harnessMode,
      model: detail.schedule.model,
      approvalMode: detail.schedule.approvalMode,
    });

    await commandCallback(commands, treeItem.command?.command ?? "")(
      ...(treeItem.command?.arguments ?? []),
    );
    await commandCallback(commands, treeItem.command?.command ?? "")(
      ...(treeItem.command?.arguments ?? []),
    );

    assert.equal(window.panels.length, 1);
    assert.equal(window.panels[0]?.revealCalls, 1);
    assert.match(
      window.panels[0]?.webview.html ?? "",
      /Open this schedule from the tree\./,
    );
  });

  it("saves Schedule Detail edits through the Editor Control Surface and refreshes the panel", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "cloud-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const panel = requiredPanel(window);

    await panel.webview.postMessageFromWebview({
      type: "save",
      scheduleId: detail.schedule.id,
      fields: {
        runInstructions: "Review issue #24 and update the schedule.",
        cadenceExpression: "*/15 * * * *",
        targetContextUri: "file:///Users/ada/src/AgentScheduler",
        targetContextLabel: "AgentScheduler",
        harnessMode: "cloud-copilot",
        agentProfile: "triage",
        model: "gpt-5.1",
        approvalMode: "autopilot",
        runCapMaxRuns: "3",
      },
    });

    const saved = await store.getSchedule(detail.schedule.id);
    assert.equal(saved?.revision, 2);
    assert.equal(
      saved?.runInstructions,
      "Review issue #24 and update the schedule.",
    );
    assert.deepEqual(saved?.cadence, {
      type: "cron",
      expression: "*/15 * * * *",
    });
    assert.deepEqual(saved?.targetContext, {
      type: "workspace",
      uri: "file:///Users/ada/src/AgentScheduler",
      label: "AgentScheduler",
    });
    assert.equal(saved?.harnessMode, "cloud-copilot");
    assert.equal(saved?.agentProfile, "triage");
    assert.equal(saved?.model, "gpt-5.1");
    assert.equal(saved?.approvalMode, "autopilot");
    assert.deepEqual(saved?.runCounter, { completed: 0, limit: 3 });

    assert.match(panel.webview.html, /Review issue #24 and update the schedule\./);
    assert.match(panel.webview.html, /name="model"[^>]*value="gpt-5\.1"/);
    assert.match(panel.webview.html, /name="agentProfile"[^>]*value="triage"/);
    assert.match(panel.webview.html, /name="runCapMaxRuns"[^>]*value="3"/);
    assert.doesNotMatch(panel.webview.html, /role="alert"/);
  });

  it("runs Run Now with the current Schedule Detail approval mode fields", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const fakeHarness = new FakeHarness({ mode: "local-copilot" });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [fakeHarness],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Run with the current form values.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);
    clock.set("2026-07-07T17:05:00.000Z");
    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: schedule.id,
      fields: {
        runInstructions: "Run with bypass approvals.",
        cadenceExpression: "0 * * * *",
        targetContextUri: "file:///Users/ada/src/AgentScheduler",
        targetContextLabel: "AgentScheduler",
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "bypass-approvals",
        runCapMaxRuns: "",
      },
    });

    const runs = await store.listRunHistory(schedule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.approvalModeSnapshot, "bypass-approvals");
    assert.equal(runs[0]?.runInstructionsSnapshot, "Run with bypass approvals.");
    assert.deepEqual(runs[0]?.resolvedHarnessPolicy, {
      harnessMode: "local-copilot",
      approvalMode: "bypass-approvals",
      sandbox: "fake",
    });
    assert.equal(fakeHarness.startRequests.length, 1);
    const updatedSchedule = await store.getSchedule(schedule.id);
    assert.equal(updatedSchedule?.revision, 2);
    assert.equal(updatedSchedule?.nextRunAt, "2026-07-07T17:00:00.000Z");
    assert.equal(
      fakeHarness.startRequests[0]?.schedule.approvalMode,
      "bypass-approvals",
    );
    assert.match(panel.webview.html, /Bypass Approvals/);

    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: schedule.id,
      fields: {
        runInstructions: "Run with bypass approvals.",
        cadenceExpression: "0 * * * *",
        targetContextUri: "file:///Users/ada/src/AgentScheduler",
        targetContextLabel: "AgentScheduler",
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "bypass-approvals",
        runCapMaxRuns: "",
      },
    });

    const unchangedSchedule = await store.getSchedule(schedule.id);
    assert.equal(unchangedSchedule?.revision, 2);
    assert.equal(unchangedSchedule?.nextRunAt, "2026-07-07T17:00:00.000Z");
  });

  it("activates a draft schedule from the Schedule Detail panel and refreshes action state", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const panel = requiredPanel(window);

    await panel.webview.postMessageFromWebview({
      type: "save",
      scheduleId: detail.schedule.id,
      fields: {
        runInstructions: "Run the activation smoke test.",
        cadenceExpression: "0 * * * *",
        targetContextUri: "file:///Users/ada/src/AgentScheduler",
        targetContextLabel: "AgentScheduler",
        harnessMode: "local-copilot",
        model: "gpt-5",
        approvalMode: "default-approvals",
        runCapMaxRuns: "",
      },
    });
    await panel.webview.postMessageFromWebview({
      type: "activate",
      scheduleId: detail.schedule.id,
    });

    const activated = await store.getSchedule(detail.schedule.id);
    assert.equal(activated?.status, "active");
    assert.equal(activated?.enabled, true);
    assert.equal(activated?.nextRunAt, "2026-07-07T17:00:00.000Z");
    assert.equal(activated?.runCounter.limit, null);

    assert.match(panel.webview.html, /<dd>active<\/dd>/);
    assert.match(
      panel.webview.html,
      /data-action="activate" data-state="disabled" disabled/,
    );
    assert.match(
      panel.webview.html,
      /Automatic runs are inactive until local scheduling setup is enabled\./,
    );
    assert.match(
      panel.webview.html,
      /Automatic runs inactive until Local Scheduling is enabled/,
    );
    assert.doesNotMatch(panel.webview.html, /2026-07-07T17:00:00\.000Z/);
    assert.match(panel.webview.html, /Every hour/);
    assert.match(panel.webview.html, /Cron Expression/);
  });

  it("offers explicit Local Scheduling setup actions from Schedule Detail", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const editor = new EditorControlSurface(lifecycle);
    const detail = await editor.createDraftSchedule({
      runInstructions: "Exercise Local Scheduling setup actions.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });

    const disabledHtml = renderScheduleDetailWebviewHtml(detail);
    assert.match(
      disabledHtml,
      /data-action="enable-local-scheduling"[^>]*>Enable Local Scheduling<\/button>/,
    );
    assert.doesNotMatch(disabledHtml, /data-action="verify-local-scheduling"/);
    assert.doesNotMatch(disabledHtml, /data-action="disable-local-scheduling"/);

    const unavailableHtml = renderScheduleDetailWebviewHtml(detail, {
      localSchedulingSetupAvailability: {
        available: false,
        reason: "Install a supported Node.js runtime to enable automatic runs.",
      },
    });
    assert.match(
      unavailableHtml,
      /data-action="enable-local-scheduling"[^>]*disabled/,
    );
    assert.match(unavailableHtml, /Install a supported Node\.js runtime/);

    const manageableHtml = renderScheduleDetailWebviewHtml(
      {
        ...detail,
        localScheduling: {
          enabled: true,
          automaticRuns: "active",
          message: "Persisted setup is enabled.",
        },
      },
      {
        localSchedulingSetupAvailability: {
          available: false,
          canManage: true,
          reason: "Node is unavailable; automatic runs may fail.",
        },
      },
    );
    assert.match(manageableHtml, /data-action="verify-local-scheduling"/);
    assert.match(manageableHtml, /data-action="disable-local-scheduling"/);

    const enabledHtml = renderScheduleDetailWebviewHtml({
      ...detail,
      localScheduling: {
        enabled: true,
        automaticRuns: "active",
        message: "Automatic runs are active.",
      },
    });
    assert.match(enabledHtml, /data-action="verify-local-scheduling"/);
    assert.match(enabledHtml, /data-action="disable-local-scheduling"/);
    assert.doesNotMatch(enabledHtml, /data-action="enable-local-scheduling"/);
  });

  it("confirms the exact wakeup intent, enables setup, and refreshes every view", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const setupStore = new InMemoryLocalSchedulingSetupStore();
    const provider = new TestWakeupProvider();
    const setup = new LocalSchedulingSetup({
      clock,
      provider,
      store: setupStore,
      request: {
        triggerId: "AgentSchedulerLocalWakeup",
        workerExecutable: "/usr/local/bin/node",
        workerArguments: [
          "/extensions/agent-scheduler/dist/src/workerCli.js",
          "scan-due-work",
          "--store",
          "/global/agent-scheduler.sqlite",
        ],
        intervalMinutes: 5,
      },
    });
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingSetup: setup,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    window.warningMessageResponses.push("Enable Local Scheduling");
    const editor = new EditorControlSurface(lifecycle, {
      localSchedulingSetup: setup,
      confirmEnableLocalScheduling: (intent) =>
        confirmEnableLocalScheduling(window, intent),
    });

    const first = await editor.createDraftSchedule({
      runInstructions: "First setup view.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///first" },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const second = await editor.createDraftSchedule({
      runInstructions: "Second setup view.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///second" },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor },
      viewColumn: 1,
      eventEmitterFactory: new RecordingEventEmitterFactory(),
    });
    const tree = window.requiredTreeProvider(SCHEDULE_LIST_VIEW_ID);
    const refreshes: Array<ScheduleTreeNode | undefined> = [];
    tree.onDidChangeTreeData?.((event) => refreshes.push(event));
    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(first.schedule.id);
    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(second.schedule.id);

    await window.panels[0]?.webview.postMessageFromWebview({
      type: "enable-local-scheduling",
      scheduleId: first.schedule.id,
    });

    assert.equal(provider.operations[0], "install");
    assert.match(window.warningMessages[0] ?? "", /Enable Local Scheduling/);
    assert.deepEqual(window.warningMessageItems[0]?.[0], {
      modal: true,
      detail: [
        "One per-user OS wakeup trigger will be installed.",
        "Platform: windows",
        "Trigger: AgentSchedulerLocalWakeup",
        "Interval: every 5 minutes",
        "Worker: /usr/local/bin/node /extensions/agent-scheduler/dist/src/workerCli.js scan-due-work --store /global/agent-scheduler.sqlite",
        "Command: install-test-trigger",
      ].join("\n"),
    });
    assert.equal(refreshes.length, 1);
    assert.match(window.panels[0]?.webview.html ?? "", /<strong>Enabled<\/strong>/);
    assert.match(window.panels[1]?.webview.html ?? "", /<strong>Enabled<\/strong>/);

    await window.panels[1]?.webview.postMessageFromWebview({
      type: "verify-local-scheduling",
      scheduleId: second.schedule.id,
    });
    await window.panels[0]?.webview.postMessageFromWebview({
      type: "disable-local-scheduling",
      scheduleId: first.schedule.id,
    });

    assert.deepEqual(provider.operations, ["install", "verify", "uninstall"]);
    assert.deepEqual(window.informationMessages, [
      "AgentScheduler Local Scheduling is enabled.",
      "AgentScheduler Local Scheduling trigger was verified.",
      "AgentScheduler Local Scheduling is disabled.",
    ]);
    assert.equal(refreshes.length, 3);
    assert.match(window.panels[0]?.webview.html ?? "", /<strong>Disabled<\/strong>/);
    assert.match(window.panels[1]?.webview.html ?? "", /<strong>Disabled<\/strong>/);
  });

  it("includes generated launchd plist contents in the exact confirmation", async () => {
    const window = new RecordingWindow();
    window.warningMessageResponses.push(ENABLE_LOCAL_SCHEDULING_ACTION);
    const intent = new MacOsLaunchdWakeupProvider().intentFor("install", {
      triggerId: "com.bedugan.AgentScheduler.local-wakeup",
      workerExecutable: "/opt/homebrew/bin/node",
      workerArguments: ["/stable/worker/workerCli.js", "scan-due-work"],
      intervalMinutes: 5,
      launchdPlistPath:
        "/Users/ada/Library/LaunchAgents/com.bedugan.AgentScheduler.local-wakeup.plist",
      userId: 501,
    });

    assert.equal(await confirmEnableLocalScheduling(window, intent), true);
    const detail = JSON.stringify(window.warningMessageItems[0]?.[0]);
    assert.match(detail, /Contents:/);
    assert.match(detail, /&lt;\?xml|<\?xml/);
    assert.match(detail, /ProgramArguments/);
    assert.match(detail, /stable\/worker\/workerCli\.js/);
  });

  it("does not report Local Scheduling success when the provider did not apply the change", async () => {
    const detail = await new EditorControlSurface(
      new ScheduleLifecycle({
        store: new InMemoryScheduleStore(),
        harnesses: [new FakeHarness({ mode: "local-copilot" })],
      }),
    ).createDraftSchedule({
      runInstructions: "Keep setup failures visible.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: { type: "workspace", uri: "file:///tmp/project" },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const failedResult: LocalSchedulingSetupResult = {
      applied: false,
      intent: new TestWakeupProvider().intentFor("install", {
        triggerId: "AgentSchedulerLocalWakeup",
        workerExecutable: process.execPath,
        workerArguments: ["workerCli.js", "scan-due-work"],
        intervalMinutes: 5,
      }),
      state: {
        enabled: false,
        platform: null,
        triggerId: null,
        installedAt: null,
        verifiedAt: null,
        updatedAt: "2026-07-07T16:00:00.000Z",
      },
    };
    const commands = new RecordingCommands();
    const window = new RecordingWindow();
    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new FailedSetupEditor(detail, failedResult) },
      viewColumn: 1,
    });
    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(detail.schedule.id);
    await requiredPanel(window).webview.postMessageFromWebview({
      type: "enable-local-scheduling",
      scheduleId: detail.schedule.id,
    });

    assert.deepEqual(window.informationMessages, []);
    assert.match(requiredPanel(window).webview.html, /trigger was not installed/);
  });

  it("shows lifecycle validation failures inline in the Schedule Detail panel", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {
        workspaceFolders: [
          {
            name: "AgentScheduler",
            uri: {
              toString: () => "file:///Users/ada/src/AgentScheduler",
            },
          },
        ],
      },
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    const detail = (await commandCallback(
      commands,
      NEW_SCHEDULE_COMMAND,
    )()) as ScheduleDetailView;
    const panel = requiredPanel(window);

    await panel.webview.postMessageFromWebview({
      type: "activate",
      scheduleId: detail.schedule.id,
    });

    const draft = await store.getSchedule(detail.schedule.id);
    assert.equal(draft?.status, "draft");
    assert.match(panel.webview.html, /role="alert"/);
    assert.match(
      panel.webview.html,
      /Run instructions are required before activation\./,
    );
    assert.equal(window.errorMessages.length, 0);
  });

  it("blocks draft activation when the selected harness is unavailable", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [],
    });
    const draft = await lifecycle.createDraftSchedule({
      runInstructions: "Try to activate without a registered harness.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(draft.id);
    await requiredPanel(window).webview.postMessageFromWebview({
      type: "activate",
      scheduleId: draft.id,
    });

    assert.equal((await store.getSchedule(draft.id))?.status, "draft");
    assert.match(requiredPanel(window).webview.html, /role="alert"/);
    assert.match(
      requiredPanel(window).webview.html,
      /Local Copilot Mode is unavailable in this VS Code environment/,
    );
    assert.match(
      requiredPanel(window).webview.html,
      /data-action="activate" data-state="disabled" disabled/,
    );
  });

  it("runs schedules through the lifecycle and refreshes previous run history", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [
        new FakeHarness({
          mode: "local-copilot",
          startResult: (request) => ({
            externalRunId: "history-model-run",
            status: "completed",
            completedAt: request.requestedAt,
            summary: "Fake harness completed the draft run.",
            executedModel: "claude-haiku-4.5",
          }),
        }),
      ],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Run the history refresh smoke test.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);
    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: schedule.id,
    });

    const completed = await store.getSchedule(schedule.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.enabled, false);
    assert.deepEqual(completed?.runCounter, { completed: 1, limit: 1 });
    assert.match(panel.webview.html, /Previous Runs/);
    assert.match(panel.webview.html, /<th>Details<\/th>/);
    assert.match(panel.webview.html, /<th>Executed Model<\/th>/);
    assert.match(panel.webview.html, /claude-haiku-4\.5/);
    assert.match(panel.webview.html, /completed/);
    assert.match(panel.webview.html, /Fake harness completed the draft run\./);
  });

  it("records and displays a blocked run when the selected harness is unavailable", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Try the unavailable harness path.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);
    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: schedule.id,
    });

    const runs = await store.listRunHistory(schedule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "blocked");
    assert.match(
      runs[0]?.error ?? "",
      /Local Copilot Mode is unavailable in this VS Code environment/,
    );
    assert.match(panel.webview.html, /blocked/);
    assert.match(
      panel.webview.html,
      /Local Copilot Mode is unavailable in this VS Code environment/,
    );
    assert.match(
      panel.webview.html,
      /Blocked: Local Copilot Mode is unavailable in this VS Code environment/,
    );
    assert.match(
      panel.webview.html,
      /Manual Run Now can still run from the editor when the harness is available\./,
    );
  });

  it("blocks activation and manual runs when the selected model is unavailable", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const draft = await lifecycle.createDraftSchedule({
      runInstructions: "Try to activate with a stale model.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "legacy-model",
      approvalMode: "default-approvals",
    });
    const active = await lifecycle.createActiveSchedule({
      runInstructions: "Try to run with a stale model.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "legacy-model",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
      languageModel: new RecordingLanguageModel([
        {
          id: "copilot-gpt-4.1",
          vendor: "copilot",
          family: "gpt-4.1",
          displayName: "Copilot GPT-4.1",
        },
      ]),
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(draft.id);
    await requiredPanel(window).webview.postMessageFromWebview({
      type: "activate",
      scheduleId: draft.id,
    });

    assert.equal((await store.getSchedule(draft.id))?.status, "draft");
    assert.match(requiredPanel(window).webview.html, /role="alert"/);
    assert.match(
      requiredPanel(window).webview.html,
      /Selected model &#39;legacy-model&#39; is not runnable by the selected harness\./,
    );

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(active.id);
    await requiredPanel(window).webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: active.id,
    });

    assert.deepEqual(await store.listRunHistory(active.id), []);
    assert.match(
      requiredPanel(window).webview.html,
      /Selected model &#39;legacy-model&#39; is not runnable by the selected harness\./,
    );
  });

  it("pauses, resumes, and restarts schedules through Schedule Detail actions", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const store = new InMemoryScheduleStore();
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store,
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createActiveSchedule({
      runInstructions: "Exercise action state transitions.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
      runCap: { maxRuns: 1 },
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);

    await panel.webview.postMessageFromWebview({
      type: "pause",
      scheduleId: schedule.id,
    });
    assert.equal((await store.getSchedule(schedule.id))?.status, "paused");
    assert.match(panel.webview.html, /<dd>paused<\/dd>/);

    await panel.webview.postMessageFromWebview({
      type: "resume",
      scheduleId: schedule.id,
    });
    assert.equal((await store.getSchedule(schedule.id))?.status, "active");
    assert.match(panel.webview.html, /<dd>active<\/dd>/);

    await panel.webview.postMessageFromWebview({
      type: "run-now",
      scheduleId: schedule.id,
    });
    assert.equal((await store.getSchedule(schedule.id))?.status, "completed");

    await panel.webview.postMessageFromWebview({
      type: "restart",
      scheduleId: schedule.id,
    });
    const restarted = await store.getSchedule(schedule.id);
    assert.equal(restarted?.status, "active");
    assert.deepEqual(restarted?.runCounter, { completed: 0, limit: 1 });
    assert.match(panel.webview.html, /data-action="pause" data-state="enabled"/);
  });

  it("shows lifecycle errors from Schedule Detail actions inline", async () => {
    const clock = new FakeClock("2026-07-07T16:05:00.000Z");
    const lifecycle = new ScheduleLifecycle({
      clock,
      idGenerator: new SequentialIdGenerator(),
      localSchedulingEnabled: false,
      store: new InMemoryScheduleStore(),
      harnesses: [new FakeHarness({ mode: "local-copilot" })],
    });
    const schedule = await lifecycle.createDraftSchedule({
      runInstructions: "Stay a draft.",
      cadence: { type: "cron", expression: "0 * * * *" },
      targetContext: {
        type: "workspace",
        uri: "file:///Users/ada/src/AgentScheduler",
        label: "AgentScheduler",
      },
      harnessMode: "local-copilot",
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    const commands = new RecordingCommands();
    const window = new RecordingWindow();

    registerVsCodeScheduleCommands({
      context: recordingContext(),
      commands,
      window,
      workspace: {},
      services: { editor: new EditorControlSurface(lifecycle) },
      viewColumn: 1,
    });

    await commandCallback(commands, OPEN_SCHEDULE_COMMAND)(schedule.id);
    const panel = requiredPanel(window);
    await panel.webview.postMessageFromWebview({
      type: "pause",
      scheduleId: schedule.id,
    });

    assert.match(panel.webview.html, /role="alert"/);
    assert.match(
      panel.webview.html,
      /Only active schedules can be paused\./,
    );
  });
});

async function runConcurrentWorkerDeployments(
  extensionRoot: string,
  globalStoragePath: string,
  barrierPath: string,
): Promise<Array<{ workerPath: string; fingerprint: string }>> {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "dist", "src", "vscodeExtensionAdapter.js"),
  ).href;
  const script = `
    import { existsSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { deployPackagedWorker } from ${JSON.stringify(moduleUrl)};
    const [extensionRoot, globalStoragePath, barrierPath] = process.argv.slice(1);
    while (!existsSync(barrierPath)) await delay(2);
    const result = deployPackagedWorker({
      extensionUri: { fsPath: extensionRoot },
      globalStorageUri: { fsPath: globalStoragePath },
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const children = [0, 1].map(
    () =>
      new Promise<{ workerPath: string; fingerprint: string }>(
        (resolveChild, rejectChild) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              script,
              extensionRoot,
              globalStoragePath,
              barrierPath,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", rejectChild);
          child.on("exit", (code) => {
            if (code === 0) {
              resolveChild(JSON.parse(stdout));
            } else {
              rejectChild(
                new Error(`Worker deployment child failed: ${stderr}`),
              );
            }
          });
        },
      ),
  );
  await writeFile(barrierPath, "start", "utf8");
  return Promise.all(children);
}

function recordingContext(): {
  globalStorageUri: { fsPath: string };
  subscriptions: VsCodeDisposableLike[];
} {
  return {
    globalStorageUri: { fsPath: "/tmp/agent-scheduler-global-storage" },
    subscriptions: [],
  };
}

function commandCallback(
  commands: RecordingCommands,
  command: string,
): (...args: unknown[]) => unknown {
  const callback = commands.registrations.get(command);
  assert.ok(callback, `Expected ${command} to be registered.`);
  return callback;
}

function requiredPanel(window: RecordingWindow): RecordingPanel {
  const panel = window.panels.at(-1);
  assert.ok(panel, "Expected a Schedule Detail panel.");
  return panel;
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function scriptContentFrom(html: string): string {
  const match = /<script\b[^>]*>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match?.[1], "Expected rendered Schedule Detail HTML to include a script.");
  return match[1];
}

class FakeWebviewButton {
  readonly dataset: { action: string; state?: string };
  readonly attributes = new Map<string, string>();
  disabled = false;
  textContent: string;
  private clickListener: (() => void) | undefined;

  constructor(action: string, textContent: string) {
    this.dataset = { action };
    this.textContent = textContent;
  }

  addEventListener(eventName: string, listener: () => void): void {
    if (eventName === "click") {
      this.clickListener = listener;
    }
  }

  hasAttribute(name: string): boolean {
    return name === "disabled" ? this.disabled : this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  click(): void {
    this.clickListener?.();
  }
}

class RecordingCommands implements VsCodeCommandsLike {
  readonly registrations = new Map<string, (...args: unknown[]) => unknown>();

  registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown,
  ): VsCodeDisposableLike {
    this.registrations.set(command, callback);
    return {
      dispose: () => {
        this.registrations.delete(command);
      },
    };
  }
}

class RecordingTasks implements VsCodeTasksLike {
  private readonly execution = { terminate: () => { this.terminations += 1; } };
  private listener: ((event: { execution: object; exitCode: number }) => unknown) | undefined;
  exitDuringExecute: number | undefined;
  terminations = 0;

  async executeTask(): Promise<object> {
    if (this.exitDuringExecute !== undefined) {
      this.finish(this.exitDuringExecute);
    }
    return this.execution;
  }

  onDidEndTaskProcess(listener: (event: { execution: object; exitCode: number }) => unknown) {
    this.listener = listener;
    return { dispose: () => { this.listener = undefined; } };
  }

  finish(exitCode: number): void {
    this.listener?.({ execution: this.execution, exitCode });
  }
}

function interactiveTaskRequest() {
  return {
    schedule: {
      id: "schedule_early_exit",
      revision: 1,
      status: "draft" as const,
      enabled: false,
      runInstructions: "Review once.",
      cadence: { type: "cron" as const, expression: "0 * * * *" },
      targetContext: { type: "workspace" as const, uri: "file:///tmp/project" },
      harnessMode: "local-copilot" as const,
      model: "auto",
      approvalMode: "default-approvals" as const,
      runCounter: { completed: 0, limit: null },
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-07-07T16:00:00.000Z",
      updatedAt: "2026-07-07T16:00:00.000Z",
    },
    trigger: "manual" as const,
    requestedAt: "2026-07-07T16:05:00.000Z",
    runInstructions: "Review once.",
    resolvedHarnessPolicy: {} as never,
    executionIdentity: "execution:test",
  };
}

class TestWakeupProvider implements WakeupProvider {
  readonly platform = "windows" as const;
  readonly operations: WakeupTriggerOperation[] = [];

  intentFor(operation: WakeupTriggerOperation, request: WakeupTriggerRequest) {
    return {
      operation,
      platform: this.platform,
      triggerId: request.triggerId,
      intervalMinutes: request.intervalMinutes,
      workerCommand: [request.workerExecutable, ...request.workerArguments].join(" "),
      commands: [
        {
          executable: "test-trigger",
          args: [operation],
          shellCommand: `${operation}-test-trigger`,
        },
      ],
      files: [],
    };
  }

  async install(request: WakeupTriggerRequest) {
    this.operations.push("install");
    return { intent: this.intentFor("install", request), applied: true };
  }

  async verify(request: WakeupTriggerRequest) {
    this.operations.push("verify");
    return { intent: this.intentFor("verify", request), applied: true };
  }

  async uninstall(request: WakeupTriggerRequest) {
    this.operations.push("uninstall");
    return { intent: this.intentFor("uninstall", request), applied: true };
  }
}
interface RecordingPanel extends VsCodeWebviewPanelLike {
  viewType: string;
  showOptions: unknown;
  options: unknown;
  webview: RecordingWebview;
  revealCalls: number;
  disposeCalls: number;
  reveal(showOptions?: unknown): void;
  dispose(): void;
}

class RecordingEventEmitter<T> implements VsCodeEventEmitterLike<T> {
  private readonly listeners: Array<(event: T) => unknown> = [];
  readonly event: VsCodeEventLike<T> = (listener) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.splice(0);
  }
}

class RecordingEventEmitterFactory implements VsCodeEventEmitterFactory {
  createEventEmitter<T>(): VsCodeEventEmitterLike<T> {
    return new RecordingEventEmitter<T>();
  }
}

class RecordingLanguageModel implements VsCodeLanguageModelLike {
  readonly tools = new Map<string, VsCodeLanguageModelToolLike>();
  private readonly changeEmitter = new RecordingEventEmitter<unknown>();

  readonly onDidChangeChatModels = this.changeEmitter.event;

  constructor(private models: ScheduleModelOption[] = []) {}

  registerTool(
    name: string,
    tool: VsCodeLanguageModelToolLike,
  ): VsCodeDisposableLike {
    this.tools.set(name, tool);
    return {
      dispose: () => {
        this.tools.delete(name);
      },
    };
  }

  requiredTool(name: string): VsCodeLanguageModelToolLike {
    const tool = this.tools.get(name);
    assert.ok(tool, `Expected language model tool ${name} to be registered.`);
    return tool;
  }

  async selectChatModels(): Promise<readonly ScheduleModelOption[]> {
    return this.models;
  }

  setModels(models: ScheduleModelOption[]): void {
    this.models = models;
    this.changeEmitter.fire({});
  }
}

class RecordingChatResponseStream implements VsCodeChatResponseStreamLike {
  readonly markdownMessages: string[] = [];
  readonly progressMessages: string[] = [];

  markdown(message: string): void {
    this.markdownMessages.push(message);
  }

  progress(message: string): void {
    this.progressMessages.push(message);
  }
}

class RecordingChatParticipant implements VsCodeDisposableLike {
  constructor(
    readonly handleRequest: (
      request: VsCodeChatRequestLike,
      stream: VsCodeChatResponseStreamLike,
    ) => Promise<NaturalLanguageScheduleCreationResult>,
  ) {}

  dispose(): void {}
}

class RecordingChat implements VsCodeChatLike {
  readonly participants = new Map<string, RecordingChatParticipant>();

  createChatParticipant(
    id: string,
    handler: (
      request: VsCodeChatRequestLike,
      context: unknown,
      stream: VsCodeChatResponseStreamLike,
      token: unknown,
    ) => unknown,
  ): RecordingChatParticipant {
    const participant = new RecordingChatParticipant(async (request, stream) => {
      return (await handler(request, {}, stream, {})) as Awaited<
        ReturnType<RecordingChatParticipant["handleRequest"]>
      >;
    });
    this.participants.set(id, participant);
    return participant;
  }

  requiredParticipant(id: string): RecordingChatParticipant {
    const participant = this.participants.get(id);
    assert.ok(participant, `Expected chat participant ${id} to be registered.`);
    return participant;
  }
}

class RecordingWebview implements VsCodeWebviewLike {
  html = "";
  private readonly messageHandlers: Array<(message: unknown) => unknown> = [];

  onDidReceiveMessage(
    listener: (message: unknown) => unknown,
  ): VsCodeDisposableLike {
    this.messageHandlers.push(listener);
    return {
      dispose: () => {
        const index = this.messageHandlers.indexOf(listener);
        if (index !== -1) {
          this.messageHandlers.splice(index, 1);
        }
      },
    };
  }

  async postMessageFromWebview(message: unknown): Promise<void> {
    await Promise.all(this.messageHandlers.map((handler) => handler(message)));
  }
}

class RecordingWindow implements VsCodeWindowLike {
  readonly panels: RecordingPanel[] = [];
  readonly treeProviders = new Map<string, VsCodeTreeDataProviderLike<unknown>>();
  readonly informationMessages: string[] = [];
  readonly informationMessageItems: unknown[][] = [];
  readonly informationMessageResponses: unknown[] = [];
  readonly warningMessages: string[] = [];
  readonly warningMessageItems: unknown[][] = [];
  readonly warningMessageResponses: unknown[] = [];
  readonly inputBoxPrompts: string[] = [];
  readonly inputBoxResponses: Array<string | undefined> = [];
  readonly errorMessages: string[] = [];
  quickPickItems: VsCodeQuickPickItemLike[] = [];

  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: {
      enableScripts: boolean;
      retainContextWhenHidden: boolean;
    },
  ): RecordingPanel {
    const panel = {
      viewType,
      title,
      showOptions,
      options,
      webview: new RecordingWebview(),
      revealCalls: 0,
      disposeCalls: 0,
      reveal: () => {
        panel.revealCalls += 1;
      },
      dispose: () => {
        panel.disposeCalls += 1;
      },
    };
    this.panels.push(panel);
    return panel;
  }

  registerTreeDataProvider<T>(
    viewId: string,
    provider: VsCodeTreeDataProviderLike<T>,
  ): VsCodeDisposableLike {
    this.treeProviders.set(
      viewId,
      provider as VsCodeTreeDataProviderLike<unknown>,
    );
    return {
      dispose: () => {
        this.treeProviders.delete(viewId);
      },
    };
  }

  requiredTreeProvider(viewId: string): ScheduleTreeDataProvider {
    const provider = this.treeProviders.get(viewId);
    assert.ok(provider, `Expected tree provider ${viewId} to be registered.`);
    return provider as ScheduleTreeDataProvider;
  }

  async showQuickPick<T extends VsCodeQuickPickItemLike>(
    items: readonly T[],
    _options: VsCodeQuickPickOptionsLike,
  ): Promise<T | undefined> {
    this.quickPickItems = [...items];
    return items[0];
  }

  async showInformationMessage(
    message: string,
    ...items: unknown[]
  ): Promise<unknown> {
    this.informationMessages.push(message);
    this.informationMessageItems.push(items);
    return this.informationMessageResponses.shift();
  }

  async showWarningMessage(
    message: string,
    ...items: unknown[]
  ): Promise<unknown> {
    this.warningMessages.push(message);
    this.warningMessageItems.push(items);
    return this.warningMessageResponses.shift();
  }

  async showInputBox(options: { prompt: string }): Promise<string | undefined> {
    this.inputBoxPrompts.push(options.prompt);
    return this.inputBoxResponses.shift();
  }

  async showErrorMessage(message: string): Promise<undefined> {
    this.errorMessages.push(message);
    return undefined;
  }
}

class EmptyScheduleEditor implements VsCodeScheduleEditor {
  async createDraftSchedule(): Promise<ScheduleDetailView> {
    throw new Error("createDraftSchedule should not be called.");
  }

  async createActiveSchedule(): Promise<ScheduleDetailView> {
    throw new Error("createActiveSchedule should not be called.");
  }

  async openScheduleDetail(): Promise<ScheduleDetailView> {
    throw new Error("openScheduleDetail should not be called.");
  }

  async saveScheduleDetailEdits(): Promise<ScheduleDetailView> {
    throw new Error("saveScheduleDetailEdits should not be called.");
  }

  async activateSchedule(): Promise<ScheduleDetailView> {
    throw new Error("activateSchedule should not be called.");
  }

  async runScheduleNow(): Promise<never> {
    throw new Error("runScheduleNow should not be called.");
  }

  async pauseSchedule(): Promise<ScheduleDetailView> {
    throw new Error("pauseSchedule should not be called.");
  }

  async resumeSchedule(): Promise<ScheduleDetailView> {
    throw new Error("resumeSchedule should not be called.");
  }

  async restartCompletedSchedule(): Promise<ScheduleDetailView> {
    throw new Error("restartCompletedSchedule should not be called.");
  }

  async deleteSchedule(): Promise<void> {
    throw new Error("deleteSchedule should not be called.");
  }

  async listSchedules(): Promise<
    Awaited<ReturnType<VsCodeScheduleEditor["listSchedules"]>>
  > {
    return [];
  }

  async listHarnessModeAvailability(): Promise<
    Awaited<ReturnType<VsCodeScheduleEditor["listHarnessModeAvailability"]>>
  > {
    return [];
  }
}

class FailedSetupEditor extends EmptyScheduleEditor {
  constructor(
    private readonly detail: ScheduleDetailView,
    private readonly result: LocalSchedulingSetupResult,
  ) {
    super();
  }

  override async openScheduleDetail(): Promise<ScheduleDetailView> {
    return this.detail;
  }

  async enableLocalScheduling(): Promise<LocalSchedulingSetupResult> {
    return this.result;
  }
}

class StaticScheduleEditor extends EmptyScheduleEditor {
  constructor(
    private readonly schedules: Awaited<
      ReturnType<VsCodeScheduleEditor["listSchedules"]>
    >,
  ) {
    super();
  }

  override async listSchedules(): Promise<
    Awaited<ReturnType<VsCodeScheduleEditor["listSchedules"]>>
  > {
    return this.schedules;
  }
}
