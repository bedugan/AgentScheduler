import * as vscode from "vscode";

import {
  createDefaultVsCodeSchedulerServices,
  registerVsCodeScheduleCommands,
  VsCodeTaskCopilotInteractiveExecutor,
} from "./vscodeExtensionAdapter.js";

export function activate(context: vscode.ExtensionContext): void {
  const interactiveExecutor = new VsCodeTaskCopilotInteractiveExecutor(
    vscode.tasks,
    {
      createCopilotTask: (name, command, args) => {
        const task = new vscode.Task(
          { type: "agentScheduler.copilot" },
          vscode.TaskScope.Workspace,
          name,
          "AgentScheduler",
          new vscode.ProcessExecution(command, [...args]),
        );
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          panel: vscode.TaskPanelKind.Dedicated,
          focus: true,
          clear: true,
        };
        return task;
      },
    },
  );
  const services = createDefaultVsCodeSchedulerServices(context, {
    window: vscode.window,
    interactiveExecutor,
  });

  registerVsCodeScheduleCommands({
    context,
    commands: vscode.commands,
    window: vscode.window,
    workspace: vscode.workspace,
    services,
    viewColumn: vscode.ViewColumn.One,
    eventEmitterFactory: {
      createEventEmitter: <T>() => new vscode.EventEmitter<T>(),
    },
    languageModel: vscode.lm,
    languageModelToolResultFactory: {
      createTextPart: (value) => new vscode.LanguageModelTextPart(value),
      createToolResult: (parts) =>
        new vscode.LanguageModelToolResult(
          parts as vscode.LanguageModelTextPart[],
        ),
    },
    chat: vscode.chat,
  });

  context.subscriptions.push({
    dispose: () => services.close?.(),
  });
}

export function deactivate(): void {}
