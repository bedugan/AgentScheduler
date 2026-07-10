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

  export class MarkdownString {
    constructor(value?: string);
  }

  export class LanguageModelTextPart {
    constructor(value: string);
  }

  export class LanguageModelToolResult {
    constructor(parts: LanguageModelTextPart[]);
  }

  export interface Uri {
    fsPath: string;
    toString(): string;
  }

  export interface ExtensionContext {
    extensionUri: { fsPath: string };
    globalStorageUri: Uri;
    subscriptions: Disposable[];
  }

  export interface TaskExecution {
    terminate(): void;
  }
  export interface TaskProcessEndEvent {
    execution: TaskExecution;
    exitCode: number | undefined;
  }
  export class ProcessExecution {
    constructor(process: string, args?: string[]);
  }
  export class Task {
    constructor(
      definition: { type: string },
      scope: unknown,
      name: string,
      source: string,
      execution: ProcessExecution,
    );
    presentationOptions: {
      reveal?: unknown;
      panel?: unknown;
      focus?: boolean;
      clear?: boolean;
    };
  }
  export const TaskScope: { Workspace: unknown };
  export const TaskRevealKind: { Always: unknown };
  export const TaskPanelKind: { Dedicated: unknown };
  export const tasks: {
    executeTask(task: Task): Promise<TaskExecution>;
    onDidEndTaskProcess(
      listener: (event: TaskProcessEndEvent) => unknown,
    ): Disposable;
  };

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

  export interface LanguageModelToolInvocationOptions<T> {
    input: T;
  }
  export interface LanguageModelTool<T> {
    invoke(
      options: LanguageModelToolInvocationOptions<T>,
      token: unknown,
    ): Promise<LanguageModelToolResult>;
  }
  export const lm: {
    registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable;
  };

  export interface ChatRequest {
    prompt: string;
    command?: string;
  }
  export interface ChatResponseStream {
    markdown(value: string | MarkdownString): void;
    progress?(value: string): void;
  }
  export interface ChatParticipant extends Disposable {}
  export const chat: {
    createChatParticipant(
      id: string,
      handler: (
        request: ChatRequest,
        context: unknown,
        stream: ChatResponseStream,
        token: unknown,
      ) => unknown,
    ): ChatParticipant;
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
    showInputBox?(options: {
      prompt: string;
      placeHolder?: string;
    }): Promise<string | undefined>;
    registerTreeDataProvider?<T>(
      viewId: string,
      provider: TreeDataProvider<T>,
    ): Disposable;
    showInformationMessage?(message: string, ...items: unknown[]): Promise<unknown>;
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
