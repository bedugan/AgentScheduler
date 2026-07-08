import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  ScheduleHarnessModeAvailability,
  TargetContext,
} from "./domain.js";
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
import type {
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessOpenRequest,
  HarnessOpenResult,
  HarnessStartResult,
  HarnessStatusRequest,
  HarnessStatusResult,
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
}

export interface CopilotCliCommandRunOptions {
  timeoutMs?: number;
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
}

export interface CreateDefaultCopilotLocalHarnessOptions {
  detectAvailability?: boolean;
}

export class CopilotCliLocalClient implements CopilotLocalClient {
  private readonly command: string;
  private readonly runner: CopilotCliCommandRunner;
  private readonly runTimeoutMs: number;
  private cachedAvailability: CopilotLocalClientAvailability | undefined;

  constructor(options: CopilotCliLocalClientOptions = {}) {
    this.command =
      options.command ??
      process.env.COPILOT_CLI_PATH ??
      DEFAULT_COPILOT_CLI_COMMAND;
    this.runner = options.runner ?? new ExecFileCopilotCliCommandRunner();
    this.runTimeoutMs =
      options.runTimeoutMs ?? DEFAULT_COPILOT_CLI_RUN_TIMEOUT_MS;
    this.cachedAvailability = options.cachedAvailability;
  }

  currentAvailability(): CopilotLocalClientAvailability | undefined {
    return this.cachedAvailability;
  }

  async checkAvailability(): Promise<CopilotLocalClientAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    const result = await this.runner.run(this.command, ["--version"], {
      timeoutMs: DEFAULT_COPILOT_CLI_PROBE_TIMEOUT_MS,
    });
    this.cachedAvailability = classifyCopilotCliAvailability(result);
    return this.cachedAvailability;
  }

  async start(request: CopilotLocalStartRequest): Promise<HarnessStartResult> {
    const result = await this.runner.run(
      this.command,
      copilotPromptArgsFor(request),
      {
        timeoutMs: this.runTimeoutMs,
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
    return {
      status: "failed",
      completedAt: request.requestedAt,
      summary: null,
      error:
        "Copilot CLI cancellation is not available until Local Copilot Mode execution is wired.",
    };
  }

  async open(request: HarnessOpenRequest): Promise<HarnessOpenResult> {
    return {
      status: "blocked",
      reason: `Copilot CLI run '${request.externalRunId}' cannot be opened until Local Copilot Mode execution is wired.`,
    };
  }
}

export function createDefaultCopilotLocalHarness(
  options: CreateDefaultCopilotLocalHarnessOptions = {},
): CopilotLocalHarness {
  const cachedAvailability =
    options.detectAvailability === false
      ? undefined
      : detectCopilotCliAvailabilitySync();
  const client = new CopilotCliLocalClient(
    cachedAvailability ? { cachedAvailability } : {},
  );
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

class ExecFileCopilotCliCommandRunner implements CopilotCliCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CopilotCliCommandRunOptions = {},
  ): Promise<CopilotCliCommandResult> {
    return new Promise((resolve) => {
      execFile(
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
          };
          if (error?.message) {
            result.errorMessage = error.message;
          }
          const errorCode = (error as NodeJS.ErrnoException | null)?.code;
          if (typeof errorCode === "string") {
            result.errorCode = errorCode;
          }
          resolve(result);
        },
      );
    });
  }
}

function copilotPromptArgsFor(request: CopilotLocalStartRequest): string[] {
  const args: string[] = [];
  const workspaceDirectory = workspaceDirectoryFor(request.schedule.targetContext);
  if (workspaceDirectory) {
    args.push("-C", workspaceDirectory);
  }

  const model = request.schedule.model.trim();
  if (model) {
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
    completedAt: request.requestedAt,
    summary: summaryForCopilotCliCommand(status, result, parsed),
  };
}

interface ParsedCopilotJsonOutput {
  sessionId?: string;
  exitCode?: number;
  assistantSummary?: string;
  errorSummary?: string;
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
    ? property
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
