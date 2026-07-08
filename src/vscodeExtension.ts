import * as vscode from "vscode";

import {
  createDefaultVsCodeSchedulerServices,
  registerVsCodeScheduleCommands,
} from "./vscodeExtensionAdapter.js";

export function activate(context: vscode.ExtensionContext): void {
  const services = createDefaultVsCodeSchedulerServices(context);

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
