import type {
  ApprovalMode,
  ResolvedHarnessPolicy,
  Schedule,
} from "./domain.js";
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
  start(request: CopilotLocalStartRequest): Promise<HarnessStartResult>;
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
}

export interface CopilotCloudHarnessOptions {
  client: CopilotCloudClient;
}

export class CopilotLocalHarness implements AgentHarness {
  readonly mode = "local-copilot" as const;

  private readonly client: CopilotLocalClient;

  constructor(options: CopilotLocalHarnessOptions) {
    this.client = options.client;
  }

  async preflight(
    request: HarnessPreflightRequest,
  ): Promise<HarnessPreflightResult> {
    const resolvedHarnessPolicy = resolveCopilotLocalHarnessPolicy({
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

    if (
      resolvedHarnessPolicy.localCopilotMode.requiresApprovalSurface &&
      !availability.approvalSurfaceAvailable
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

  async start(request: HarnessStartRequest): Promise<HarnessStartResult> {
    return this.client.start({
      ...request,
      resolvedHarnessPolicy:
        request.resolvedHarnessPolicy as CopilotLocalResolvedHarnessPolicy,
    });
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

  async start(request: HarnessStartRequest): Promise<HarnessStartResult> {
    return this.client.start({
      ...request,
      resolvedHarnessPolicy:
        request.resolvedHarnessPolicy as CopilotCloudResolvedHarnessPolicy,
    });
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
      requiresApprovalSurface: false,
    };
  }

  if (approvalMode === "autopilot") {
    return {
      approvalPreset: "autopilot",
      permissionBehavior: "runs-with-autopilot",
      requiresApprovalSurface: false,
    };
  }

  return {
    approvalPreset: "default",
    permissionBehavior: "uses-copilot-default-approvals",
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
