import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  Schedule,
  ScheduleHarnessModeAvailability,
  TargetContext,
} from "./domain.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import {
  HARNESS_MODE_LABELS,
} from "./domain.js";
import type {
  CopilotLocalClient,
  CopilotLocalClientAvailability,
  CopilotLocalStartRequest,
} from "./copilotHarness.js";
import {
  CopilotLocalHarness,
} from "./copilotHarness.js";
import { LOCAL_RUN_HEARTBEAT_MS } from "./localRunExecution.js";
import type {
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessOpenRequest,
  HarnessOpenResult,
  HarnessStartResult,
  HarnessStatusRequest,
  HarnessStatusResult,
  HarnessExecutionObserver,
} from "./harness.js";

export const DEFAULT_COPILOT_CLI_COMMAND = "copilot";
export const DEFAULT_COPILOT_CLI_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS = 5_000;

export const COPILOT_CLI_MISSING_REASON =
  "GitHub Copilot CLI was not found. Install GitHub Copilot CLI, or run `gh copilot` to download it through GitHub CLI, then ensure `copilot` is on PATH. OS wakeup triggers can use a different PATH than your interactive shell; set COPILOT_CLI_PATH or install `copilot` in a worker-visible path.";

export const COPILOT_CLI_AUTH_UNAVAILABLE_REASON =
  "GitHub Copilot CLI is installed but not authenticated. Run `copilot login` in an interactive shell, or configure `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` for unattended worker contexts.";

export interface CopilotCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt?: string;
}

export interface CopilotCliCommandRunOptions {
  timeoutMs?: number;
  onStarted?: (identity: string) => Promise<void>;
  onHeartbeat?: () => Promise<void>;
  heartbeatMs?: number;
}

export interface CopilotCliCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CopilotCliCommandRunOptions,
  ): Promise<CopilotCliCommandResult>;
}

export interface CopilotCliLocalClientOptions {
  command?: string;
  runner?: CopilotCliCommandRunner;
  cachedAvailability?: CopilotLocalClientAvailability;
  runTimeoutMs?: number;
  interactiveExecutor?: CopilotInteractiveExecutor;
}

export interface CopilotInteractiveExecutor {
  run(
    command: string,
    args: readonly string[],
    request: CopilotLocalStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult>;
  cancel?(identity: string): Promise<HarnessCancelResult | undefined>;
}

export interface CreateDefaultCopilotLocalHarnessOptions {
  detectAvailability?: boolean;
  interactiveExecutor?: CopilotInteractiveExecutor;
}

export class CopilotCliLocalClient implements CopilotLocalClient {
  private readonly command: string;
  private readonly runner: CopilotCliCommandRunner;
  private readonly runTimeoutMs: number;
  private readonly interactiveExecutor: CopilotInteractiveExecutor | undefined;
  private cachedAvailability: CopilotLocalClientAvailability | undefined;
  private cachedModelOptions: readonly ScheduleModelOption[] | undefined;

  constructor(options: CopilotCliLocalClientOptions = {}) {
    this.command =
      options.command ??
      process.env.COPILOT_CLI_PATH ??
      DEFAULT_COPILOT_CLI_COMMAND;
    this.runner = options.runner ?? new ExecFileCopilotCliCommandRunner();
    this.runTimeoutMs =
      options.runTimeoutMs ?? DEFAULT_COPILOT_CLI_RUN_TIMEOUT_MS;
    this.cachedAvailability = options.cachedAvailability;
    this.interactiveExecutor = options.interactiveExecutor;
  }

  currentAvailability(): CopilotLocalClientAvailability | undefined {
    return this.cachedAvailability;
  }

  async models(): Promise<readonly ScheduleModelOption[]> {
    if (this.cachedModelOptions) {
      return this.cachedModelOptions;
    }
    const result = await this.runner.run(this.command, ["help", "config"], {
      timeoutMs: DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
    });
    this.cachedModelOptions = copilotCliModelOptionsFromConfigHelp(
      `${result.stdout}\n${result.stderr}`,
    );
    return this.cachedModelOptions;
  }

  async checkAvailability(
    schedule?: Schedule,
  ): Promise<CopilotLocalClientAvailability> {
    if (this.cachedAvailability) {
      return this.availabilityWithPermissionFlagSupport(schedule);
    }
    return this.refreshAvailability(schedule);
  }

  async refreshAvailability(
    schedule?: Schedule,
  ): Promise<CopilotLocalClientAvailability> {
    const result = await this.runner.run(this.command, ["--version"], {
      timeoutMs: DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
    });
    const detected = classifyCopilotCliAvailability(result);
    this.cachedAvailability =
      detected.status === "available"
        ? {
            ...detected,
            approvalSurfaceAvailable: this.interactiveExecutor !== undefined,
          }
        : detected;
    return this.availabilityWithPermissionFlagSupport(schedule);
  }

  async start(
    request: CopilotLocalStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult> {
    if (
      request.resolvedHarnessPolicy.localCopilotMode.requiresApprovalSurface &&
      !request.resolvedHarnessPolicy.localCopilotMode.unattended
    ) {
      if (!this.interactiveExecutor) {
        throw new Error(
          "Manual Default Approvals requires an interactive Copilot approval surface.",
        );
      }
      return this.interactiveExecutor.run(
        this.command,
        copilotInteractiveArgsFor(request),
        request,
        observer,
      );
    }
    const result = await this.runner.run(
      this.command,
      copilotPromptArgsFor(request),
      {
        timeoutMs: this.runTimeoutMs,
        ...(observer && {
          onStarted: (identity: string) =>
            observer.started({
              identity,
              capabilities: { cancel: false, open: false, heartbeat: true },
            }),
        }),
        ...(observer && {
          onHeartbeat: () => observer.heartbeat(),
        }),
        heartbeatMs: LOCAL_RUN_HEARTBEAT_MS,
      },
    );
    return harnessStartResultForCopilotCliCommand(request, result);
  }

  async status(request: HarnessStatusRequest): Promise<HarnessStatusResult> {
    return {
      status: "failed",
      completedAt: request.requestedAt,
      summary: null,
      error:
        "Copilot CLI status polling is not available until Local Copilot Mode execution is wired.",
    };
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    if (request.executionIdentity && this.interactiveExecutor?.cancel) {
      const canceled = await this.interactiveExecutor.cancel(
        request.executionIdentity,
      );
      if (canceled) {
        return canceled;
      }
      throw new Error(
        "Cancellation did not reach a matching active Local Copilot execution.",
      );
    }
    return {
      status: "failed",
      completedAt: request.requestedAt,
      summary: null,
      error:
        "Cancellation is unavailable because this Local Copilot execution is not owned by the active editor process.",
    };
  }

  async open(request: HarnessOpenRequest): Promise<HarnessOpenResult> {
    return {
      status: "blocked",
      reason: `Copilot CLI run '${request.externalRunId}' cannot be opened until Local Copilot Mode execution is wired.`,
    };
  }

  private async availabilityWithPermissionFlagSupport(
    schedule: Schedule | undefined,
  ): Promise<CopilotLocalClientAvailability> {
    const availability = this.cachedAvailability;
    if (!availability) {
      throw new Error("Copilot CLI availability has not been checked.");
    }
    if (
      availability.status !== "available" ||
      !scheduleRequiresPermissionFlags(schedule) ||
      availability.supportedPermissionFlags
    ) {
      return availability;
    }

    const helpResult = await this.runner.run(this.command, ["--help"], {
      timeoutMs: DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
    });
    this.cachedAvailability = {
      ...availability,
      supportedPermissionFlags:
        helpResult.exitCode === 0
          ? supportedPermissionFlagsFromHelp(
              `${helpResult.stdout}\n${helpResult.stderr}`,
            )
          : [],
    };
    return this.cachedAvailability;
  }
}

export function copilotCliModelOptionsFromConfigHelp(
  output: string,
): ScheduleModelOption[] {
  const modelSection = /(?:^|\n)  `model`:[\s\S]*?(?=\n\n  `|$)/.exec(output)?.[0] ?? "";
  const ids = [...modelSection.matchAll(/^    - "([^"]+)"\s*$/gm)]
    .map((match) => match[1]?.trim())
    .filter((id): id is string => Boolean(id));
  return ["auto", ...new Set(ids)].map((id) => ({
    id,
    displayName: id === "auto" ? "Auto" : copilotModelDisplayName(id),
    vendor: "GitHub Copilot",
  }));
}

function copilotModelDisplayName(id: string): string {
  return id
    .split("-")
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

export function createDefaultCopilotLocalHarness(
  options: CreateDefaultCopilotLocalHarnessOptions = {},
): CopilotLocalHarness {
  const cachedAvailability =
    options.detectAvailability === false
      ? undefined
      : detectCopilotCliAvailabilitySync();
  const client = new CopilotCliLocalClient({
    ...(cachedAvailability ? { cachedAvailability } : {}),
    ...(options.interactiveExecutor
      ? { interactiveExecutor: options.interactiveExecutor }
      : {}),
  });
  return new CopilotLocalHarness({
    client,
    availability: () =>
      copilotLocalHarnessAvailabilityFor(client.currentAvailability()),
  });
}

export function detectCopilotCliAvailabilitySync(
  command = process.env.COPILOT_CLI_PATH ?? DEFAULT_COPILOT_CLI_COMMAND,
): CopilotLocalClientAvailability {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
  });

  const commandResult: CopilotCliCommandResult = {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (typeof result.error?.message === "string") {
    commandResult.errorMessage = result.error.message;
  }
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errorCode === "string") {
    commandResult.errorCode = errorCode;
  }

  return classifyCopilotCliAvailability(commandResult);
}

export function classifyCopilotCliAvailability(
  result: CopilotCliCommandResult,
): CopilotLocalClientAvailability {
  if (result.exitCode === 0) {
    return {
      status: "available",
      approvalSurfaceAvailable: false,
    };
  }

  if (result.errorCode === "ENOENT") {
    return {
      status: "unavailable",
      reason: COPILOT_CLI_MISSING_REASON,
    };
  }

  const output = [
    result.errorCode,
    result.errorMessage,
    result.stderr,
    result.stdout,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

  if (isAuthenticationFailure(output)) {
    return {
      status: "unavailable",
      reason: COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
    };
  }

  const detail =
    firstNonEmptyLine(result.stderr) ??
    firstNonEmptyLine(result.stdout) ??
    result.errorMessage ??
    "unknown error";
  return {
    status: "unavailable",
    reason: `GitHub Copilot CLI could not be used: ${detail}`,
  };
}

export function copilotLocalHarnessAvailabilityFor(
  availability: CopilotLocalClientAvailability | undefined,
): ScheduleHarnessModeAvailability {
  if (!availability) {
    return {
      mode: "local-copilot",
      label: HARNESS_MODE_LABELS["local-copilot"],
      available: true,
    };
  }

  if (availability.status === "available") {
    return {
      mode: "local-copilot",
      label: HARNESS_MODE_LABELS["local-copilot"],
      available: true,
    };
  }

  return {
    mode: "local-copilot",
    label: HARNESS_MODE_LABELS["local-copilot"],
    available: false,
    reason: availability.reason,
  };
}

function scheduleRequiresPermissionFlags(schedule: Schedule | undefined): boolean {
  return (
    schedule?.approvalMode === "bypass-approvals" ||
    schedule?.approvalMode === "autopilot"
  );
}

function supportedPermissionFlagsFromHelp(helpOutput: string): string[] {
  const supportedFlags = new Set<string>();
  for (const match of helpOutput.matchAll(/--[a-z][a-z0-9-]*/gi)) {
    supportedFlags.add(match[0]);
  }
  return [...supportedFlags].sort();
}

export class ExecFileCopilotCliCommandRunner implements CopilotCliCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CopilotCliCommandRunOptions = {},
  ): Promise<CopilotCliCommandResult> {
    return new Promise((resolve, reject) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let started = Promise.resolve();
      const child = execFile(
        command,
        [...args],
        {
          timeout: options.timeoutMs ?? DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const result: CopilotCliCommandResult = {
            exitCode: exitCodeFor(error),
            stdout,
            stderr,
            completedAt: new Date().toISOString(),
          };
          if (error?.message) {
            result.errorMessage = error.message;
          }
          const errorCode = (error as NodeJS.ErrnoException | null)?.code;
          if (typeof errorCode === "string") {
            result.errorCode = errorCode;
          }
          if (heartbeat) {
            clearInterval(heartbeat);
          }
          void started.then(() => resolve(result), reject);
        },
      );
      if (child.pid !== undefined && options.onStarted) {
        started = options.onStarted(`process:${child.pid}`);
        if (options.onHeartbeat) {
          heartbeat = setInterval(() => {
            void options.onHeartbeat?.().catch(() => {});
          }, options.heartbeatMs ?? LOCAL_RUN_HEARTBEAT_MS);
          heartbeat.unref();
        }
      }
    });
  }
}

function copilotPromptArgsFor(request: CopilotLocalStartRequest): string[] {
  const args: string[] = [];
  const workspaceDirectory = workspaceDirectoryFor(request.schedule.targetContext);
  if (workspaceDirectory) {
    args.push("-C", workspaceDirectory);
  }

  const agentProfile = request.schedule.agentProfile?.trim();
  if (agentProfile) {
    args.push("--agent", agentProfile);
  }

  const model = request.schedule.model.trim();
  if (model && model !== "auto") {
    args.push("--model", model);
  }

  args.push(
    "--output-format",
    request.resolvedHarnessPolicy.localCopilotMode.cli.outputFormat,
    "--no-color",
    ...request.resolvedHarnessPolicy.localCopilotMode.cli.permissionFlags,
    request.resolvedHarnessPolicy.localCopilotMode.cli.promptFlag,
    copilotExecutionPromptFor(request.runInstructions),
  );

  return args;
}

function copilotInteractiveArgsFor(request: CopilotLocalStartRequest): string[] {
  const args: string[] = [];
  const workspaceDirectory = workspaceDirectoryFor(request.schedule.targetContext);
  if (workspaceDirectory) {
    args.push("-C", workspaceDirectory);
  }
  const agentProfile = request.schedule.agentProfile?.trim();
  if (agentProfile) {
    args.push("--agent", agentProfile);
  }
  const model = request.schedule.model.trim();
  if (model && model !== "auto") {
    args.push("--model", model);
  }
  args.push("-i", copilotExecutionPromptFor(request.runInstructions));
  return args;
}

function copilotExecutionPromptFor(runInstructions: string): string {
  return [
    "AgentScheduler execution frame:",
    "This is one occurrence of an AgentScheduler run.",
    "AgentScheduler owns recurrence, run caps, and local scheduling for this schedule.",
    "Perform the current run once in the target context, report the result through the normal Copilot CLI response, and obey the resolved harness policy.",
    "Do not create or register OS scheduled tasks, scheduled jobs, launch agents, systemd timers, cron entries, background loops, detached processes, daemons, timers, watchers, or files solely to implement recurrence.",
    "",
    "User Run Instructions:",
    runInstructions,
  ].join("\n");
}

function harnessStartResultForCopilotCliCommand(
  request: CopilotLocalStartRequest,
  result: CopilotCliCommandResult,
): HarnessStartResult {
  const parsed = parseCopilotJsonOutput(result.stdout);
  const processSucceeded = result.exitCode === 0;
  const copilotSucceeded =
    parsed.exitCode === undefined || parsed.exitCode === 0;
  const status = processSucceeded && copilotSucceeded ? "completed" : "failed";

  return {
    externalRunId:
      parsed.sessionId ?? `copilot-cli:${request.schedule.id}:${request.requestedAt}`,
    status,
    completedAt: result.completedAt ?? request.requestedAt,
    summary: summaryForCopilotCliCommand(status, result, parsed),
    executedModel: parsed.executedModel ?? null,
  };
}

interface ParsedCopilotJsonOutput {
  sessionId?: string;
  exitCode?: number;
  assistantSummary?: string;
  errorSummary?: string;
  executedModel?: string;
}

function parseCopilotJsonOutput(output: string): ParsedCopilotJsonOutput {
  const parsed: ParsedCopilotJsonOutput = {};

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const event = parseJsonObject(trimmed);
    if (!event) {
      continue;
    }

    const assistantSummary = assistantSummaryFromEvent(event);
    if (assistantSummary) {
      parsed.assistantSummary = assistantSummary;
    }

    const errorSummary = errorSummaryFromEvent(event);
    if (errorSummary) {
      parsed.errorSummary = errorSummary;
    }

    const executedModel = executedModelFromEvent(event);
    if (executedModel) {
      parsed.executedModel = executedModel;
    }

    if (event.type === "result") {
      const sessionId = stringProperty(event, "sessionId");
      if (sessionId) {
        parsed.sessionId = sessionId;
      }
      const exitCode = numberProperty(event, "exitCode");
      if (exitCode !== undefined) {
        parsed.exitCode = exitCode;
      }
    }
  }

  return parsed;
}

function executedModelFromEvent(
  event: Record<string, unknown>,
): string | undefined {
  return (
    stringProperty(event, "model") ??
    stringProperty(event, "modelId") ??
    stringProperty(event, "resolvedModel") ??
    stringPropertyFromNested(event, ["data", "model"]) ??
    stringPropertyFromNested(event, ["data", "modelId"]) ??
    stringPropertyFromNested(event, ["data", "resolvedModel"]) ??
    stringPropertyFromNested(event, ["response", "model"]) ??
    stringPropertyFromNested(event, ["message", "model"])
  );
}

function stringPropertyFromNested(
  value: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return typeof current === "string" && current.trim().length > 0
    ? current.trim()
    : undefined;
}

function summaryForCopilotCliCommand(
  status: HarnessStartResult["status"],
  result: CopilotCliCommandResult,
  parsed: ParsedCopilotJsonOutput,
): string | null {
  if (parsed.assistantSummary) {
    return parsed.assistantSummary;
  }

  if (status === "failed") {
    return (
      parsed.errorSummary ??
      firstNonEmptyLine(result.stderr) ??
      result.errorMessage ??
      firstNonEmptyLine(result.stdout) ??
      "Copilot CLI run failed."
    );
  }

  return firstNonEmptyLine(result.stdout) ?? "Copilot CLI run completed.";
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function assistantSummaryFromEvent(
  event: Record<string, unknown>,
): string | undefined {
  if (event.type !== "assistant") {
    return undefined;
  }

  return textFromContent(event.message) ?? textFromContent(event.data);
}

function errorSummaryFromEvent(
  event: Record<string, unknown>,
): string | undefined {
  if (event.type !== "error") {
    return undefined;
  }

  return (
    stringProperty(event, "message") ??
    textFromContent(event.error) ??
    textFromContent(event.data)
  );
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizedText(value);
  }

  if (Array.isArray(value)) {
    return normalizedText(
      value
        .map((entry) => textFromContent(entry))
        .filter((entry): entry is string => Boolean(entry))
        .join("\n"),
    );
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return (
    textFromContent(value.content) ??
    textFromContent(value.text) ??
    textFromContent(value.data) ??
    textFromContent(value.message)
  );
}

function normalizedText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringProperty(
  value: Record<string, unknown>,
  propertyName: string,
): string | undefined {
  const property = value[propertyName];
  return typeof property === "string" && property.trim().length > 0
    ? property.trim()
    : undefined;
}

function numberProperty(
  value: Record<string, unknown>,
  propertyName: string,
): number | undefined {
  const property = value[propertyName];
  return typeof property === "number" ? property : undefined;
}

function workspaceDirectoryFor(targetContext: TargetContext | null): string | null {
  if (!targetContext || targetContext.type !== "workspace") {
    return null;
  }

  try {
    const targetUrl = new URL(targetContext.uri);
    return targetUrl.protocol === "file:" ? fileURLToPath(targetUrl) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exitCodeFor(error: Error | null): number | null {
  if (!error) {
    return 0;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "number" ? code : null;
}

function isAuthenticationFailure(output: string): boolean {
  return [
    "auth",
    "credential",
    "keychain",
    "login",
    "secitem",
    "token",
  ].some((pattern) => output.includes(pattern));
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}
