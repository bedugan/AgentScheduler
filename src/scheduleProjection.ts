import type {
  HarnessMode,
  RunHistoryDetailView,
  RunHistoryEntry,
  RunOutcomeView,
  Schedule,
  ScheduleDetailPreviousRun,
  ScheduleDetailView,
  ScheduleHarnessModeAvailability,
} from "./domain.js";
import { HARNESS_MODE_LABELS, isActiveRunStatus } from "./domain.js";
import type { LocalRunExecution } from "./localRunExecution.js";

export class ScheduleProjection {
  constructor(
    private readonly executionOwnerId: string,
    private readonly listHarnessModes: () => ScheduleHarnessModeAvailability[],
    private readonly harnessAvailabilityFor: (
      mode: HarnessMode,
      schedule?: Schedule,
    ) => ScheduleHarnessModeAvailability,
  ) {}

  runHistoryDetail(
    run: RunHistoryEntry,
    execution: LocalRunExecution | undefined,
  ): RunHistoryDetailView {
    const active = isActiveRunStatus(run.status) && run.completedAt === null;
    const cancelReady =
      active &&
      execution?.ownerId === this.executionOwnerId &&
      execution.capabilities.cancel &&
      !execution.cancellationRequestedAt;

    return {
      run,
      scheduleId: run.scheduleId,
      scheduleRevision: run.scheduleRevision,
      resolvedRunInstructions: run.runInstructionsSnapshot,
      approvalMode: run.approvalModeSnapshot,
      selectedModel: run.model,
      ...(run.agentProfile && { selectedAgentProfile: run.agentProfile }),
      executedModel: run.executedModel,
      resolvedHarnessPolicy: run.resolvedHarnessPolicy,
      outcome: this.runOutcomeViewFor(run),
      execution: execution ?? null,
      actions: {
        cancel: {
          kind: "cancel",
          label: "Cancel Run",
          enabled: cancelReady,
          ...(!cancelReady && {
            disabledReason: active
              ? execution
                ? execution.cancellationRequestedAt
                  ? "Cancellation was requested and AgentScheduler is waiting for the execution to exit."
                  : "Cancellation is unsupported from this process or execution type."
                : "Cancellation is unavailable because this active run has no recoverable execution identity."
              : "Only active runs can be canceled.",
          }),
        },
        open: {
          kind: "open",
          label: "Open Run",
          enabled:
            run.externalRunId !== null &&
            execution?.capabilities.open === true,
          ...((run.externalRunId === null ||
            execution?.capabilities.open !== true) && {
            disabledReason:
              run.externalRunId === null
                ? "This run has no external harness identity to open."
                : "Opening this execution is unsupported.",
          }),
        },
      },
    };
  }

  scheduleDetail(
    schedule: Schedule,
    previousRuns: RunHistoryEntry[],
    localSchedulingEnabled: boolean,
  ): ScheduleDetailView {
    return {
      schedule,
      runInstructions: {
        value: schedule.runInstructions,
        editable: true,
        scheduleRevision: schedule.revision,
      },
      overview: {
        status: schedule.status,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
        lastRunAt: schedule.lastRunAt,
        targetContext: schedule.targetContext,
        cadence: schedule.cadence,
        harnessMode: schedule.harnessMode,
        model: schedule.model,
        ...(schedule.agentProfile && { agentProfile: schedule.agentProfile }),
        approvalMode: schedule.approvalMode,
        runCounter: this.runCounterViewFor(schedule),
      },
      actions: this.scheduleActionsFor(schedule, previousRuns),
      previousRuns: previousRuns.map((run) => this.previousRunViewFor(run)),
      runCounter: schedule.runCounter,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      notificationState: {
        runOutcomes: "quiet-in-app",
        desktopNotifications: "off",
      },
      localScheduling: this.localSchedulingViewFor(localSchedulingEnabled),
      harnessAvailability: this.harnessAvailabilityViewFor(schedule),
    };
  }
  private runCounterViewFor(schedule: Schedule): {
    completed: number;
    limit: number | null;
    label: string;
  } {
    return {
      ...schedule.runCounter,
      label:
        schedule.runCounter.limit === null
          ? String(schedule.runCounter.completed)
          : `${schedule.runCounter.completed}/${schedule.runCounter.limit}`,
    };
  }

  private scheduleActionsFor(
    schedule: Schedule,
    previousRuns: RunHistoryEntry[] = [],
  ): ScheduleDetailView["actions"] {
    const runNowStatusEnabled = schedule.status === "draft" || schedule.enabled;
    const harnessUnavailableReason = this.selectedHarnessUnavailableReason(schedule);
    const runNowEnabled = runNowStatusEnabled && !harnessUnavailableReason;
    const activeRunBlocksDeletion = previousRuns.some(
      (run) => isActiveRunStatus(run.status) && run.completedAt === null,
    );
    return {
      activate: {
        kind: "activate",
        label: "Activate Schedule",
        enabled: schedule.status === "draft" && !harnessUnavailableReason,
        ...(schedule.status !== "draft" && {
          disabledReason: "Only draft schedules can be activated.",
        }),
        ...(schedule.status === "draft" &&
          harnessUnavailableReason && {
            disabledReason: harnessUnavailableReason,
          }),
      },
      runNow: {
        kind: "run-now",
        label: "Run Now",
        enabled: runNowEnabled,
        ...(!runNowStatusEnabled && {
          disabledReason:
            "Manual Run Now is only available for draft or enabled schedules.",
        }),
        ...(runNowStatusEnabled &&
          harnessUnavailableReason && {
            disabledReason: harnessUnavailableReason,
          }),
      },
      pause: {
        kind: "pause",
        label: "Pause",
        enabled: schedule.status === "active",
        ...(schedule.status !== "active" && {
          disabledReason: "Only active schedules can be paused.",
        }),
      },
      resume: {
        kind: "resume",
        label: "Resume",
        enabled: schedule.status === "paused",
        ...(schedule.status !== "paused" && {
          disabledReason: "Only paused schedules can be resumed.",
        }),
      },
      restart: {
        kind: "restart",
        label: "Restart",
        enabled: schedule.status === "completed",
        ...(schedule.status !== "completed" && {
          disabledReason: "Only completed schedules can be restarted.",
        }),
      },
      delete: {
        kind: "delete",
        label: "Delete Schedule",
        enabled: !activeRunBlocksDeletion,
        ...(activeRunBlocksDeletion && {
          disabledReason:
            "Resolve or cancel the active run before deleting this schedule.",
        }),
      },
    };
  }

  private previousRunViewFor(
    run: RunHistoryEntry,
  ): ScheduleDetailPreviousRun {
    return {
      ...run,
      outcome: this.runOutcomeViewFor(run),
      historyDetailLink: {
        runId: run.id,
        view: "run-history-detail",
      },
    };
  }

  private runOutcomeViewFor(run: RunHistoryEntry): RunOutcomeView {
    return {
      status: run.status,
      completedAt: run.completedAt,
      summary: run.summary,
      error: run.error,
      description: this.runOutcomeDescriptionFor(run),
    };
  }

  private runOutcomeDescriptionFor(run: RunHistoryEntry): string {
    const detail = run.error ?? run.summary;

    switch (run.status) {
      case "blocked":
        return `Blocked: ${detail ?? "AgentScheduler blocked this run before it started."}`;
      case "approval-waiting":
        return `Approval needed: ${detail ?? "Open the approval surface to continue this run."}`;
      case "deferred":
        return `Deferred: ${detail ?? "AgentScheduler deferred this run and will coalesce catch-up work."}`;
      case "failed":
        return `Failed: ${detail ?? "The harness reported that this run failed."}`;
      case "completed":
        return detail ?? "Run completed.";
      case "running":
        return detail ?? "Run is running.";
      case "canceled":
        return detail ?? "Run was canceled.";
    }
  }

  private localSchedulingViewFor(
    enabled: boolean,
  ): ScheduleDetailView["localScheduling"] {
    return {
      enabled,
      automaticRuns: enabled ? "active" : "inactive",
      message: enabled
        ? "Automatic runs are active because local scheduling setup is enabled."
        : "Automatic runs are inactive until local scheduling setup is enabled. Manual Run Now can still run from the editor when the harness is available.",
    };
  }

  private harnessAvailabilityViewFor(
    schedule: Schedule,
  ): ScheduleDetailView["harnessAvailability"] {
    const modes = this.listHarnessModes();
    const selected = schedule.harnessMode
      ? this.harnessAvailabilityFor(schedule.harnessMode, schedule)
      : null;

    return {
      modes,
      selected,
      message: selected
        ? selected.available
          ? [
              `${selected.label} harness is available.`,
              selected.manualRunReady === false
                ? selected.manualRunReason
                : "Manual Run Now is ready in the editor.",
              selected.unattendedRunReady === false
                ? selected.unattendedRunReason
                : "Unattended policy is ready for automatic runs.",
              selected.readinessNote,
            ]
              .filter((message): message is string => Boolean(message))
              .join(" ")
          : selected.reason ?? unavailableHarnessModeMessage(selected.mode)
        : "Choose an available harness mode before activating or running this schedule.",
    };
  }

  selectedHarnessUnavailableReason(schedule: Schedule): string | undefined {
    if (!schedule.harnessMode) {
      return "Choose an available harness mode before activating or running this schedule.";
    }

    const availability = this.harnessAvailabilityFor(
      schedule.harnessMode,
      schedule,
    );
    return availability.available
      ? undefined
      : availability.reason ?? unavailableHarnessModeMessage(schedule.harnessMode);
  }

}

function unavailableHarnessModeMessage(mode: HarnessMode): string {
  return `${HARNESS_MODE_LABELS[mode]} is unavailable in this VS Code environment because no ${HARNESS_MODE_LABELS[mode]} harness is registered. Install or enable the matching Copilot integration, or choose another available harness mode.`;
}
