declare module "vscode" {
  export interface Disposable {
    dispose(): unknown;
  }

  export interface Uri {
    fsPath: string;
    toString(): string;
  }

  export interface ExtensionContext {
    globalStorageUri: Uri;
    subscriptions: Disposable[];
  }

  export interface WorkspaceFolder {
    name: string;
    uri: Uri;
  }

  export interface WebviewPanel {
    title: string;
    webview: {
      html: string;
    };
    reveal?(): unknown;
  }

  export const commands: {
    registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
    ): Disposable;
  };

  export const window: {
    createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: unknown,
      options: {
        enableScripts: boolean;
        retainContextWhenHidden: boolean;
      },
    ): WebviewPanel;
    showQuickPick?<T extends { label: string }>(
      items: readonly T[],
      options: { placeHolder: string },
    ): Promise<T | undefined>;
    showInformationMessage?(message: string): Promise<unknown>;
    showErrorMessage?(message: string): Promise<unknown>;
  };
  export const workspace: {
    workspaceFolders?: readonly WorkspaceFolder[];
  };
  export const ViewColumn: {
    One: unknown;
  };
}
