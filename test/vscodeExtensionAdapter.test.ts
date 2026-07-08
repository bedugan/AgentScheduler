import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  ScheduleLifecycle,
  type NaturalLanguageScheduleCreationResult,
  type ScheduleDetailView,
} from "../src/index.js";
import {
  CREATE_SCHEDULE_CHAT_PARTICIPANT_ID,
  CREATE_SCHEDULE_CHAT_SLASH_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  CREATE_SCHEDULE_TOOL_NAME,
  NEW_SCHEDULE_COMMAND,
  OPEN_SCHEDULE_COMMAND,
  SCHEDULE_DETAIL_VIEW_TYPE,
  SCHEDULE_LIST_VIEW_ID,
  SQLITE_LOCAL_STORE_FILENAME,
  ScheduleTreeDataProvider,
  buildNewDraftScheduleInput,
  registerVsCodeScheduleCommands,
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
  type ScheduleTreeNode,
  type VsCodeTreeDataProviderLike,
  type VsCodeWebviewPanelLike,
  type VsCodeWebviewLike,
  type VsCodeWindowLike,
} from "../src/vscodeExtensionAdapter.js";
import {
  FakeClock,
  FakeHarness,
  InMemoryScheduleStore,
  SequentialIdGenerator,
} from "../src/testing.js";

describe("VS Code extension adapter", () => {
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
      };
      extensionKind?: string[];
      engines?: { vscode?: string };
    };

    assert.equal(manifest.main, "./dist/src/vscodeExtension.js");
    assert.deepEqual(manifest.extensionKind, ["ui"]);
    assert.equal(typeof manifest.engines?.vscode, "string");
    assert.deepEqual(manifest.activationEvents, [
      `onCommand:${NEW_SCHEDULE_COMMAND}`,
      `onCommand:${OPEN_SCHEDULE_COMMAND}`,
      `onCommand:${CREATE_SCHEDULE_COMMAND}`,
      `onView:${SCHEDULE_LIST_VIEW_ID}`,
      `onLanguageModelTool:${CREATE_SCHEDULE_TOOL_NAME}`,
      `onChatParticipant:${CREATE_SCHEDULE_CHAT_PARTICIPANT_ID}`,
    ]);
    assert.deepEqual(
      manifest.contributes?.commands?.map((command) => command.command),
      [NEW_SCHEDULE_COMMAND, OPEN_SCHEDULE_COMMAND, CREATE_SCHEDULE_COMMAND],
    );
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
      model: "gpt-5",
      approvalMode: "default-approvals",
    });
    assert.equal(Object.hasOwn(input, "runCap"), false);

    assert.equal(
      buildNewDraftScheduleInput({ workspaceFolders: [] }).targetContext,
      null,
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
  });

  it("registers create and open commands at the adapter boundary", () => {
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
    ]);
    assert.equal(context.subscriptions.length, 2);
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
      services: { editor, lifecycle },
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
    assert.equal(result.schedule.model, "gpt-5");
    assert.equal(result.schedule.approvalMode, "default-approvals");
    assert.deepEqual(result.schedule.runCounter, { completed: 0, limit: 2 });
    assert.equal(window.informationMessages.length, 1);
    assert.match(window.informationMessages[0] ?? "", /Create active/);
    assert.equal(window.panels.length, 1);
    assert.match(window.panels[0]?.webview.html ?? "", /Review bug branches\./);
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
      services: { editor, lifecycle },
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
      services: { editor, lifecycle },
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
      services: { editor, lifecycle },
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
    assert.equal(detail.schedule.model, "gpt-5");
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
    assert.match(panel?.webview.html ?? "", /name="model"[^>]*value="gpt-5"/);
    assert.match(panel?.webview.html ?? "", /data-action="activate"/);
    assert.match(
      panel?.webview.html ?? "",
      /Automatic runs are inactive until local scheduling setup is enabled\./,
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
    assert.equal(saved?.model, "gpt-5.1");
    assert.equal(saved?.approvalMode, "autopilot");
    assert.deepEqual(saved?.runCounter, { completed: 0, limit: 3 });

    assert.match(panel.webview.html, /Review issue #24 and update the schedule\./);
    assert.match(panel.webview.html, /name="model"[^>]*value="gpt-5\.1"/);
    assert.match(panel.webview.html, /name="runCapMaxRuns"[^>]*value="3"/);
    assert.doesNotMatch(panel.webview.html, /role="alert"/);
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

  it("runs schedules through the lifecycle and refreshes previous run history", async () => {
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
    assert.equal(
      runs[0]?.error,
      "Harness mode 'local-copilot' is unavailable.",
    );
    assert.match(panel.webview.html, /blocked/);
    assert.match(
      panel.webview.html,
      /Harness mode &#39;local-copilot&#39; is unavailable\./,
    );
    assert.match(
      panel.webview.html,
      /Blocked: Harness mode &#39;local-copilot&#39; is unavailable\./,
    );
    assert.match(
      panel.webview.html,
      /Manual Run Now can still run from the editor when the harness is available\./,
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

interface RecordingPanel extends VsCodeWebviewPanelLike {
  viewType: string;
  showOptions: unknown;
  options: unknown;
  webview: RecordingWebview;
  revealCalls: number;
  reveal(showOptions?: unknown): void;
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
      reveal: () => {
        panel.revealCalls += 1;
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

  async listSchedules(): Promise<
    Awaited<ReturnType<VsCodeScheduleEditor["listSchedules"]>>
  > {
    return [];
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
