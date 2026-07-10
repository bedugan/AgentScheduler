import { randomBytes } from "node:crypto";

import type { CopilotInteractiveExecutor } from "./copilotCliClient.js";
import type {
  HarnessCancelResult,
  HarnessExecutionObserver,
} from "./harness.js";
import { LOCAL_RUN_HEARTBEAT_MS } from "./localRunExecution.js";

interface DisposableLike {
  dispose(): unknown;
}

export interface VsCodeTaskExecutionLike {
  terminate?(): void;
}

export interface VsCodeTaskProcessEndEventLike {
  execution: VsCodeTaskExecutionLike;
  exitCode: number | undefined;
}

export interface VsCodeTasksLike {
  executeTask(task: unknown): Promise<VsCodeTaskExecutionLike>;
  onDidEndTaskProcess(
    listener: (event: VsCodeTaskProcessEndEventLike) => unknown,
  ): DisposableLike;
}

export interface VsCodeCopilotTaskFactory {
  createCopilotTask(
    name: string,
    command: string,
    args: readonly string[],
  ): unknown;
}

export class VsCodeTaskCopilotInteractiveExecutor
  implements CopilotInteractiveExecutor
{
  private readonly activeExecutions = new Map<
    string,
    {
      execution: VsCodeTaskExecutionLike;
      cancelRequested: boolean;
      cancelCompletion: Promise<HarnessCancelResult>;
      resolveCancel(result: HarnessCancelResult): void;
    }
  >();

  constructor(
    private readonly tasks: VsCodeTasksLike,
    private readonly taskFactory: VsCodeCopilotTaskFactory,
    private readonly cancelTimeoutMs = 5_000,
    private readonly heartbeatMs = LOCAL_RUN_HEARTBEAT_MS,
  ) {}

  async run(
    command: string,
    args: readonly string[],
    request: Parameters<CopilotInteractiveExecutor["run"]>[2],
    observer?: HarnessExecutionObserver,
  ) {
    const name = `AgentScheduler: ${request.schedule.id}`;
    const task = this.taskFactory.createCopilotTask(name, command, args);
    const identity =
      request.executionIdentity ??
      `execution:${randomBytes(16).toString("hex")}`;
    const taskHandle = `vscode-task:${request.schedule.id}:${request.requestedAt}`;
    let heartbeat: NodeJS.Timeout | undefined;
    let execution: VsCodeTaskExecutionLike | undefined;
    let hasCompleted = false;
    const earlyEvents: VsCodeTaskProcessEndEventLike[] = [];
    let resolveCompletion:
      | ((result: Awaited<ReturnType<CopilotInteractiveExecutor["run"]>>) => void)
      | undefined;
    const completion = new Promise<
      Awaited<ReturnType<CopilotInteractiveExecutor["run"]>>
    >((resolve) => {
      resolveCompletion = resolve;
    });
    const complete = (event: VsCodeTaskProcessEndEventLike): void => {
      hasCompleted = true;
      subscription.dispose();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      const processCompleted = event.exitCode === 0;
      const activeExecution = this.activeExecutions.get(identity);
      if (activeExecution?.cancelRequested) {
        activeExecution.resolveCancel({
          status: processCompleted ? "completed" : "canceled",
          completedAt: new Date().toISOString(),
          summary: processCompleted
            ? "Interactive Copilot task completed before cancellation took effect."
            : "Interactive Copilot task was canceled.",
          error: null,
        });
      }
      resolveCompletion?.({
        externalRunId: identity,
        status: processCompleted ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        summary: processCompleted
          ? "Interactive Copilot task completed in the VS Code terminal."
          : `Interactive Copilot task exited with code ${event.exitCode ?? "unknown"}.`,
        executedModel: null,
      });
      this.activeExecutions.delete(identity);
    };
    const subscription = this.tasks.onDidEndTaskProcess((event) => {
      if (!execution) {
        earlyEvents.push(event);
        return;
      }
      if (event.execution === execution) {
        complete(event);
      }
    });

    try {
      execution = await this.tasks.executeTask(task);
      let resolveCancel!: (result: HarnessCancelResult) => void;
      const cancelCompletion = new Promise<HarnessCancelResult>((resolve) => {
        resolveCancel = resolve;
      });
      this.activeExecutions.set(identity, {
        execution,
        cancelRequested: false,
        cancelCompletion,
        resolveCancel,
      });
      await observer?.started({
        identity: taskHandle,
        capabilities: {
          cancel: execution.terminate !== undefined,
          open: false,
          heartbeat: true,
        },
      });
      if (observer && !hasCompleted) {
        heartbeat = setInterval(() => {
          void observer.heartbeat().catch(() => {});
        }, this.heartbeatMs);
        heartbeat.unref();
      }
    } catch (error) {
      subscription.dispose();
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      this.activeExecutions.delete(identity);
      throw error;
    }

    const earlyCompletion = earlyEvents.find(
      (event) => event.execution === execution,
    );
    if (earlyCompletion) {
      complete(earlyCompletion);
    }
    return completion;
  }

  async cancel(identity: string): Promise<HarnessCancelResult | undefined> {
    const active = this.activeExecutions.get(identity);
    if (!active?.execution.terminate) {
      return undefined;
    }
    active.cancelRequested = true;
    active.execution.terminate();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        active.cancelCompletion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Timed out waiting for the canceled VS Code Task to exit.",
                ),
              ),
            this.cancelTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
