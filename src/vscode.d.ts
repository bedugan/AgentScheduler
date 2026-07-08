declare module "vscode" {
  export interface Disposable {
    dispose(): unknown;
  }

  export interface Event<T> {
    (listener: (event: T) => unknown): Disposable;
  }

  export class EventEmitter<T> implements Disposable {
    readonly event: Event<T>;
    fire(event: T): void;
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
    webview: Webview;
    reveal?(showOptions?: unknown): unknown;
    onDidDispose?(listener: () => unknown): Disposable;
  }

  export interface Webview {
    html: string;
    onDidReceiveMessage(
      listener: (message: unknown) => unknown,
    ): Disposable;
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
    registerTreeDataProvider?<T>(
      viewId: string,
      provider: TreeDataProvider<T>,
    ): Disposable;
    showInformationMessage?(message: string): Promise<unknown>;
    showErrorMessage?(message: string): Promise<unknown>;
  };
  export interface Command {
    command: string;
    title: string;
    arguments?: unknown[];
  }
  export interface TreeItem {
    label: string;
    description?: string;
    tooltip?: string;
    command?: Command;
    contextValue?: string;
  }
  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | undefined>;
    getChildren(element?: T): T[] | Promise<T[]>;
    getTreeItem(element: T): TreeItem;
  }
  export const workspace: {
    workspaceFolders?: readonly WorkspaceFolder[];
  };
  export const ViewColumn: {
    One: unknown;
  };
}
