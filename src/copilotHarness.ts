import type {
  ApprovalMode,
  ResolvedHarnessPolicy,
  Schedule,
  ScheduleHarnessModeAvailability,
} from "./domain.js";
import { HARNESS_MODE_LABELS, isActiveRunStatus } from "./domain.js";
import type { LocalRunExecutionStarted } from "./localRunExecution.js";
import type { ScheduleModelOption } from "./scheduleModelCatalog.js";
import type {
  AgentHarness,
  HarnessCancelRequest,
  HarnessCancelResult,
  HarnessOpenRequest,
  HarnessOpenResult,
  HarnessPreflightRequest,
  HarnessPreflightResult,
  HarnessStartRequest,
  HarnessStartResult,
  HarnessExecutionObserver,
  HarnessStatusRequest,
  HarnessStatusResult,
} from "./harness.js";

export const COPILOT_APPROVAL_MODE_LABELS = {
  "default-approvals": "Default Approvals",
  "bypass-approvals": "Bypass Approvals",
  autopilot: "Autopilot",
} as const satisfies Record<ApprovalMode, string>;

type CopilotApprovalPreset = "default" | "bypass" | "autopilot";

type CopilotPermissionBehavior =
  | "uses-copilot-default-approvals"
  | "bypasses-approval-prompts"
  | "runs-with-autopilot";

type CopilotCloudPermissionBehavior =
  | "uses-cloud-default-approvals"
  | "bypasses-cloud-approval-prompts"
  | "runs-with-cloud-autopilot";

export interface CopilotLocalResolvedHarnessPolicy
  extends ResolvedHarnessPolicy {
  provider: "copilot";
  harnessMode: "local-copilot";
  approvalMode: ApprovalMode;
  approvalModeLabel: (typeof COPILOT_APPROVAL_MODE_LABELS)[ApprovalMode];
  localCopilotMode: {
    approvalPreset: CopilotApprovalPreset;
    permissionBehavior: CopilotPermissionBehavior;
    cli: {
      promptFlag: "-p";
      outputFormat: "json";
      permissionFlags: readonly string[];
    };
    requiresApprovalSurface: boolean;
    unattended: boolean;
  };
}

export interface ResolveCopilotLocalHarnessPolicyInput {
  approvalMode: ApprovalMode;
  unattended: boolean;
}

export interface CopilotCloudResolvedHarnessPolicy
  extends ResolvedHarnessPolicy {
  provider: "copilot";
  harnessMode: "cloud-copilot";
  approvalMode: ApprovalMode;
  approvalModeLabel: (typeof COPILOT_APPROVAL_MODE_LABELS)[ApprovalMode];
  cloudCopilotMode: {
    approvalPreset: CopilotApprovalPreset;
    permissionBehavior: CopilotCloudPermissionBehavior;
    cloudSession: true;
    unattended: boolean;
  };
}

export interface ResolveCopilotCloudHarnessPolicyInput {
  approvalMode: ApprovalMode;
  unattended: boolean;
}

export type CopilotLocalClientAvailability =
  | {
      status: "available";
      approvalSurfaceAvailable: boolean;
      supportedPermissionFlags?: readonly string[];
    }
  | {
      status: "unavailable";
      reason: string;
    };

export interface CopilotLocalStartRequest extends HarnessStartRequest {
  resolvedHarnessPolicy: CopilotLocalResolvedHarnessPolicy;
}

export type CopilotCloudClientAvailability =
  | {
      status: "available";
    }
  | {
      status: "unavailable";
      reason: string;
    };

export interface CopilotCloudStartRequest extends HarnessStartRequest {
  resolvedHarnessPolicy: CopilotCloudResolvedHarnessPolicy;
}

export interface CopilotLocalClient {
  checkAvailability(
    schedule: Schedule,
  ): Promise<CopilotLocalClientAvailability>;
  refreshAvailability?(
    schedule?: Schedule,
  ): Promise<CopilotLocalClientAvailability>;
  start(
    request: CopilotLocalStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult>;
  status(request: HarnessStatusRequest): Promise<HarnessStatusResult>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
  open(request: HarnessOpenRequest): Promise<HarnessOpenResult>;
}

export interface CopilotCloudClient {
  checkAvailability(
    schedule: Schedule,
  ): Promise<CopilotCloudClientAvailability>;
  start(request: CopilotCloudStartRequest): Promise<HarnessStartResult>;
  status(request: HarnessStatusRequest): Promise<HarnessStatusResult>;
  cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult>;
  open(request: HarnessOpenRequest): Promise<HarnessOpenResult>;
}

export interface CopilotLocalHarnessOptions {
  client: CopilotLocalClient;
  availability?: () => ScheduleHarnessModeAvailability;
}

export interface CopilotCloudHarnessOptions {
  client: CopilotCloudClient;
}

export class CopilotLocalHarness implements AgentHarness {
  readonly mode = "local-copilot" as const;

  private readonly client: CopilotLocalClient;
  private readonly availabilityProvider:
    | (() => ScheduleHarnessModeAvailability)
    | undefined;
  private lastClientAvailability: CopilotLocalClientAvailability | undefined;

  constructor(options: CopilotLocalHarnessOptions) {
    this.client = options.client;
    this.availabilityProvider = options.availability;
  }

  async models(): Promise<readonly ScheduleModelOption[]> {
    return [{ id: "auto", displayName: "Auto", vendor: "GitHub Copilot" }];
  }

  availability(schedule?: Schedule): ScheduleHarnessModeAvailability {
    if (this.lastClientAvailability) {
      return this.availabilityProjection(this.lastClientAvailability, schedule);
    }
    return this.availabilityProvider?.() ?? {
      mode: this.mode,
      label: HARNESS_MODE_LABELS[this.mode],
      available: true,
    };
  }

  async refreshAvailability(
    schedule?: Schedule,
  ): Promise<ScheduleHarnessModeAvailability> {
    if (!this.client.refreshAvailability && !schedule) {
      return this.availability(schedule);
    }
    const availability = this.client.refreshAvailability
      ? await this.client.refreshAvailability(schedule)
      : await this.client.checkAvailability(schedule as Schedule);
    this.lastClientAvailability = availability;
    return this.availabilityProjection(availability, schedule);
  }

  private availabilityProjection(
    availability: CopilotLocalClientAvailability,
    schedule?: Schedule,
  ): ScheduleHarnessModeAvailability {
    const defaultApprovals = schedule?.approvalMode === "default-approvals";
    return availability.status === "available"
      ? {
          mode: this.mode,
          label: HARNESS_MODE_LABELS[this.mode],
          available: true,
          manualRunReady:
            !defaultApprovals || availability.approvalSurfaceAvailable,
          ...(defaultApprovals &&
            !availability.approvalSurfaceAvailable && {
              manualRunReason:
                "Manual Default Approvals needs the VS Code interactive Copilot task approval surface.",
            }),
          unattendedRunReady: !defaultApprovals,
          ...(defaultApprovals && {
            unattendedRunReason:
              "Unattended Default Approvals blocks before start because no approval surface is available to the background worker.",
          }),
          readinessNote:
            "Copilot authentication is verified when a run starts; Copilot CLI exposes no non-mutating authentication-status command.",
        }
      : {
          mode: this.mode,
          label: HARNESS_MODE_LABELS[this.mode],
          available: false,
          reason: availability.reason,
        };
  }

  async preflight(
    request: HarnessPreflightRequest,
  ): Promise<HarnessPreflightResult> {
    const resolvedHarnessPolicy = resolveCopilotLocalHarnessPolicy({
      approvalMode: request.schedule.approvalMode,
      unattended: isUnattendedRun(request),
    });
    const secondarySchedulerReason = secondarySchedulerPolicyReason(
      request.schedule.runInstructions,
    );
    if (secondarySchedulerReason) {
      return {
        status: "blocked",
        reason: secondarySchedulerReason,
        resolvedHarnessPolicy,
      };
    }

    if (request.schedule.model !== "auto") {
      return {
        status: "blocked",
        reason: `Model '${request.schedule.model}' is not a runnable Local Copilot Mode selector. Choose Auto.`,
        resolvedHarnessPolicy,
      };
    }

    const availability = await this.client.checkAvailability(request.schedule);

    if (availability.status === "unavailable") {
      return {
        status: "blocked",
        reason: availability.reason,
        resolvedHarnessPolicy,
      };
    }

    const unsupportedPermissionFlags = unsupportedRequiredPermissionFlags(
      resolvedHarnessPolicy.localCopilotMode.cli.permissionFlags,
      availability.supportedPermissionFlags,
    );
    if (unsupportedPermissionFlags.length > 0) {
      return {
        status: "blocked",
        reason: `Local Copilot Mode cannot verify the selected Approval Mode because GitHub Copilot CLI does not report support for required permission flag(s): ${unsupportedPermissionFlags.join(", ")}.`,
        resolvedHarnessPolicy,
      };
    }

    if (
      resolvedHarnessPolicy.localCopilotMode.requiresApprovalSurface &&
      (resolvedHarnessPolicy.localCopilotMode.unattended ||
        !availability.approvalSurfaceAvailable)
    ) {
      return {
        status: "blocked",
        reason: defaultApprovalsApprovalSurfaceReason(
          resolvedHarnessPolicy.localCopilotMode.unattended,
        ),
        resolvedHarnessPolicy,
      };
    }

    return {
      status: "ready",
      resolvedHarnessPolicy,
    };
  }

  async start(
    request: HarnessStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult> {
    let executionObserved = false;
    const observed = observer
      ? {
          started: async (execution: LocalRunExecutionStarted) => {
            executionObserved = true;
            await observer.started(execution);
          },
          heartbeat: () => observer.heartbeat(),
        }
      : undefined;
    const result = await this.client.start({
      ...request,
      resolvedHarnessPolicy:
        request.resolvedHarnessPolicy as CopilotLocalResolvedHarnessPolicy,
    }, observed);
    if (observer && !executionObserved && isActiveRunStatus(result.status)) {
      await observer.started({
        identity: result.externalRunId,
        capabilities: { cancel: true, open: true, heartbeat: false },
      });
    }
    return result;
  }

  async status(request: HarnessStatusRequest): Promise<HarnessStatusResult> {
    return this.client.status(request);
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    return this.client.cancel(request);
  }

  async open(request: HarnessOpenRequest): Promise<HarnessOpenResult> {
    return this.client.open(request);
  }
}

export class CopilotCloudHarness implements AgentHarness {
  readonly mode = "cloud-copilot" as const;

  private readonly client: CopilotCloudClient;

  constructor(options: CopilotCloudHarnessOptions) {
    this.client = options.client;
  }

  async preflight(
    request: HarnessPreflightRequest,
  ): Promise<HarnessPreflightResult> {
    const resolvedHarnessPolicy = resolveCopilotCloudHarnessPolicy({
      approvalMode: request.schedule.approvalMode,
      unattended: isUnattendedRun(request),
    });
    const availability = await this.client.checkAvailability(request.schedule);

    if (availability.status === "unavailable") {
      return {
        status: "blocked",
        reason: availability.reason,
        resolvedHarnessPolicy,
      };
    }

    return {
      status: "ready",
      resolvedHarnessPolicy,
    };
  }

  async start(
    request: HarnessStartRequest,
    observer?: HarnessExecutionObserver,
  ): Promise<HarnessStartResult> {
    const result = await this.client.start({
      ...request,
      resolvedHarnessPolicy:
        request.resolvedHarnessPolicy as CopilotCloudResolvedHarnessPolicy,
    });
    if (observer && isActiveRunStatus(result.status)) {
      await observer.started({
        identity: result.externalRunId,
        capabilities: { cancel: true, open: true, heartbeat: false },
      });
    }
    return result;
  }

  async status(request: HarnessStatusRequest): Promise<HarnessStatusResult> {
    return this.client.status(request);
  }

  async cancel(request: HarnessCancelRequest): Promise<HarnessCancelResult> {
    return this.client.cancel(request);
  }

  async open(request: HarnessOpenRequest): Promise<HarnessOpenResult> {
    return this.client.open(request);
  }
}

export function resolveCopilotLocalHarnessPolicy(
  input: ResolveCopilotLocalHarnessPolicyInput,
): CopilotLocalResolvedHarnessPolicy {
  const localCopilotMode = localCopilotModePolicyFor(input.approvalMode);

  return {
    provider: "copilot",
    harnessMode: "local-copilot",
    approvalMode: input.approvalMode,
    approvalModeLabel: COPILOT_APPROVAL_MODE_LABELS[input.approvalMode],
    localCopilotMode: {
      ...localCopilotMode,
      unattended: input.unattended,
    },
  };
}

export function resolveCopilotCloudHarnessPolicy(
  input: ResolveCopilotCloudHarnessPolicyInput,
): CopilotCloudResolvedHarnessPolicy {
  const cloudCopilotMode = cloudCopilotModePolicyFor(input.approvalMode);

  return {
    provider: "copilot",
    harnessMode: "cloud-copilot",
    approvalMode: input.approvalMode,
    approvalModeLabel: COPILOT_APPROVAL_MODE_LABELS[input.approvalMode],
    cloudCopilotMode: {
      ...cloudCopilotMode,
      cloudSession: true,
      unattended: input.unattended,
    },
  };
}

function localCopilotModePolicyFor(
  approvalMode: ApprovalMode,
): Omit<CopilotLocalResolvedHarnessPolicy["localCopilotMode"], "unattended"> {
  if (approvalMode === "bypass-approvals") {
    return {
      approvalPreset: "bypass",
      permissionBehavior: "bypasses-approval-prompts",
      cli: {
        promptFlag: "-p",
        outputFormat: "json",
        permissionFlags: ["--no-ask-user", "--allow-all-tools"],
      },
      requiresApprovalSurface: false,
    };
  }

  if (approvalMode === "autopilot") {
    return {
      approvalPreset: "autopilot",
      permissionBehavior: "runs-with-autopilot",
      cli: {
        promptFlag: "-p",
        outputFormat: "json",
        permissionFlags: ["--no-ask-user", "--autopilot", "--allow-all"],
      },
      requiresApprovalSurface: false,
    };
  }

  return {
    approvalPreset: "default",
    permissionBehavior: "uses-copilot-default-approvals",
    cli: {
      promptFlag: "-p",
      outputFormat: "json",
      permissionFlags: [],
    },
    requiresApprovalSurface: true,
  };
}

function cloudCopilotModePolicyFor(
  approvalMode: ApprovalMode,
): Omit<
  CopilotCloudResolvedHarnessPolicy["cloudCopilotMode"],
  "cloudSession" | "unattended"
> {
  if (approvalMode === "bypass-approvals") {
    return {
      approvalPreset: "bypass",
      permissionBehavior: "bypasses-cloud-approval-prompts",
    };
  }

  if (approvalMode === "autopilot") {
    return {
      approvalPreset: "autopilot",
      permissionBehavior: "runs-with-cloud-autopilot",
    };
  }

  return {
    approvalPreset: "default",
    permissionBehavior: "uses-cloud-default-approvals",
  };
}

function isUnattendedRun(request: HarnessPreflightRequest): boolean {
  return request.trigger === "automatic" && request.localSchedulingEnabled;
}

function defaultApprovalsApprovalSurfaceReason(unattended: boolean): string {
  return unattended
    ? "Default Approvals requires an approval surface for unattended Local Copilot Mode runs, but no approval surface is available."
    : "Default Approvals requires an approval surface for Local Copilot Mode, but no approval surface is available.";
}

function unsupportedRequiredPermissionFlags(
  requiredFlags: readonly string[],
  supportedFlags: readonly string[] | undefined,
): string[] {
  if (!supportedFlags) {
    return [];
  }

  const supported = new Set(supportedFlags);
  return requiredFlags.filter((flag) => !supported.has(flag));
}

function secondarySchedulerPolicyReason(
  runInstructions: string,
): string | undefined {
  if (!requestsSecondaryScheduler(runInstructions)) {
    return undefined;
  }

  return "Local Copilot Mode cannot run instructions that ask the harness to create scheduled tasks, cron entries, launch agents, timers, background loops, detached processes, or other secondary schedulers. AgentScheduler owns recurrence; move recurrence into the schedule cadence or use AgentScheduler Local Scheduling Setup.";
}

function requestsSecondaryScheduler(value: string): boolean {
  const normalized = value.toLowerCase();
  const requestsRecurringExecution =
    /\b(run|check|execute|perform)\s+every\s+(hour|day|week|[1-9]\d?\s+minutes?)\b/.test(
      normalized,
    );
  const requestsSchedulerCreation =
    /\b(create|register|install|configure|set\s+up|add|start|launch)\b[^.!?\n]{0,160}\b(task scheduler|scheduled task|scheduled job|schtasks|cron(?: entry)?|crontab|systemd timer|launch agent|launchd|background loop|detached process|daemon|watcher)\b/.test(
      normalized,
    );

  return requestsRecurringExecution || requestsSchedulerCreation;
}
