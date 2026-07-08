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
  });

  context.subscriptions.push({
    dispose: () => services.close?.(),
  });
}

export function deactivate(): void {}
