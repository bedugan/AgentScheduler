import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EditorControlSurface,
  ScheduleLifecycle,
  type ScheduleDetailView,
} from "../src/index.js";
import {
  NEW_SCHEDULE_COMMAND,
  OPEN_SCHEDULE_COMMAND,
  SCHEDULE_DETAIL_VIEW_TYPE,
  SQLITE_LOCAL_STORE_FILENAME,
  buildNewDraftScheduleInput,
  registerVsCodeScheduleCommands,
  sqliteLocalStorePath,
  type VsCodeCommandsLike,
  type VsCodeDisposableLike,
  type VsCodeQuickPickItemLike,
  type VsCodeQuickPickOptionsLike,
  type VsCodeScheduleEditor,
  type VsCodeWebviewPanelLike,
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
      contributes?: { commands?: Array<{ command: string; title: string }> };
      extensionKind?: string[];
      engines?: { vscode?: string };
    };

    assert.equal(manifest.main, "./dist/src/vscodeExtension.js");
    assert.deepEqual(manifest.extensionKind, ["ui"]);
    assert.equal(typeof manifest.engines?.vscode, "string");
    assert.deepEqual(manifest.activationEvents, [
      `onCommand:${NEW_SCHEDULE_COMMAND}`,
      `onCommand:${OPEN_SCHEDULE_COMMAND}`,
    ]);
    assert.deepEqual(
      manifest.contributes?.commands?.map((command) => command.command),
      [NEW_SCHEDULE_COMMAND, OPEN_SCHEDULE_COMMAND],
    );
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
    assert.match(panel?.webview.html ?? "", /Editable Fields/);
    assert.match(panel?.webview.html ?? "", /name="model" value="gpt-5"/);
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
    assert.match(html, /name="approval-mode" value="default-approvals"/);
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
}

class RecordingWindow implements VsCodeWindowLike {
  readonly panels: RecordingPanel[] = [];
  readonly informationMessages: string[] = [];
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
      webview: { html: "" },
    };
    this.panels.push(panel);
    return panel;
  }

  async showQuickPick<T extends VsCodeQuickPickItemLike>(
    items: readonly T[],
    _options: VsCodeQuickPickOptionsLike,
  ): Promise<T | undefined> {
    this.quickPickItems = [...items];
    return items[0];
  }

  async showInformationMessage(message: string): Promise<undefined> {
    this.informationMessages.push(message);
    return undefined;
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

  async listSchedules(): Promise<[]> {
    return [];
  }
}
