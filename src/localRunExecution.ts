import type { IsoTimestamp } from "./domain.js";

export const LOCAL_RUN_LEASE_MS = 2 * 60 * 1_000;
export const LOCAL_RUN_HEARTBEAT_MS = 30 * 1_000;
export const LEGACY_ACTIVE_RUN_GRACE_MS = LOCAL_RUN_LEASE_MS;
export const RECOVERY_CLAIM_LEASE_MS = LOCAL_RUN_LEASE_MS;
export const NON_HEARTBEATING_RUN_LEASE_MS = 24 * 60 * 60 * 1_000;

export interface LocalRunExecutionCapabilities {
  cancel: boolean;
  open: boolean;
  heartbeat?: boolean;
}

export interface LocalRunExecution {
  runId: string;
  identity: string;
  ownerId: string;
  startedAt: IsoTimestamp;
  heartbeatAt: IsoTimestamp;
  leaseExpiresAt: IsoTimestamp;
  capabilities: LocalRunExecutionCapabilities;
  handle: string | null;
  recoveryClaimedAt?: IsoTimestamp | null;
  cancellationRequestedAt?: IsoTimestamp | null;
}

export interface LocalRunExecutionStarted {
  identity: string;
  capabilities: LocalRunExecutionCapabilities;
}

export interface ExpiredExecutionClaim {
  runId: string;
  observedHeartbeatAt: IsoTimestamp | null;
  observedLeaseExpiresAt: IsoTimestamp | null;
  claimedAt: IsoTimestamp;
}

export function leaseExpiry(
  heartbeatAt: IsoTimestamp,
  leaseMs = LOCAL_RUN_LEASE_MS,
): IsoTimestamp {
  return new Date(new Date(heartbeatAt).getTime() + leaseMs).toISOString();
}

export function isExecutionLeaseExpired(
  execution: LocalRunExecution,
  now: IsoTimestamp,
): boolean {
  return execution.leaseExpiresAt <= now;
}
