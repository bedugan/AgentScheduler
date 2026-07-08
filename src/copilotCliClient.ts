import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";

import type {
  ScheduleHarnessModeAvailability,
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

export const COPILOT_CLI_MISSING_REASON =
  "GitHub Copilot CLI was not found. Install GitHub Copilot CLI, or run `gh copilot` to download it through GitHub CLI, then ensure `copilot` is on PATH.";

export const COPILOT_CLI_AUTH_UNAVAILABLE_REASON =
  "GitHub Copilot CLI is installed but not authenticated. Run `copilot login` in an interactive shell, or configure `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` for unattended worker contexts.";

export interface CopilotCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CopilotCliCommandRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<CopilotCliCommandResult>;
}

export interface CopilotCliLocalClientOptions {
  command?: string;
  runner?: CopilotCliCommandRunner;
  cachedAvailability?: CopilotLocalClientAvailability;
}

export interface CreateDefaultCopilotLocalHarnessOptions {
  detectAvailability?: boolean;
}

export class CopilotCliLocalClient implements CopilotLocalClient {
  private readonly command: string;
  private readonly runner: CopilotCliCommandRunner;
  private cachedAvailability: CopilotLocalClientAvailability | undefined;

  constructor(options: CopilotCliLocalClientOptions = {}) {
    this.command =
      options.command ??
      process.env.COPILOT_CLI_PATH ??
      DEFAULT_COPILOT_CLI_COMMAND;
    this.runner = options.runner ?? new ExecFileCopilotCliCommandRunner();
    this.cachedAvailability = options.cachedAvailability;
  }

  currentAvailability(): CopilotLocalClientAvailability | undefined {
    return this.cachedAvailability;
  }

  async checkAvailability(): Promise<CopilotLocalClientAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    const result = await this.runner.run(this.command, ["--version"]);
    this.cachedAvailability = classifyCopilotCliAvailability(result);
    return this.cachedAvailability;
  }

  async start(request: CopilotLocalStartRequest): Promise<HarnessStartResult> {
    return {
      externalRunId: `copilot-cli-unimplemented:${request.schedule.id}`,
      status: "failed",
      completedAt: request.requestedAt,
      summary:
        "Copilot CLI is available, but Local Copilot Mode execution is not wired yet.",
    };
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
    timeout: 5_000,
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
  ): Promise<CopilotCliCommandResult> {
    return new Promise((resolve) => {
      execFile(command, [...args], { timeout: 5_000 }, (error, stdout, stderr) => {
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
      });
    });
  }
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
