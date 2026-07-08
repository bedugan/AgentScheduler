# AgentScheduler

AgentScheduler coordinates unattended agent runs for developer-controlled contexts. It separates the schedule, the harness that executes the run, and the editor surface used to manage it.

## Language

**Agent Run**:
A scheduled prompt executed by a configured agent harness, possibly against a workspace, issue, file, browser task, terminal command, or other context.
_Avoid_: Task, reminder, automation, scheduled agent work

**Run Instructions**:
The durable prompt text for an agent run schedule. Run instructions describe what the harness should do each time, what context to use, how to report, and any prompt-level stop conditions.
_Avoid_: Schedule settings, execution policy

**Instruction Source**:
Where run instructions come from. The MVP uses inline instructions stored in the schedule; external prompt files are a later source for reusable or versioned workflows.
_Avoid_: Execution policy, cadence

**Execution Policy**:
The enforceable permission and approval settings for an agent run, including tool approvals, sandbox behavior, and harness-specific restrictions. Execution policy constrains what run instructions can cause.
_Avoid_: Prompt, guidance, preference

**Harness Policy Mapping**:
The translation between AgentScheduler's provider-neutral execution policy model and the selected agent harness's native permission, sandbox, and policy controls.
_Avoid_: Custom policy system, duplicated provider settings

**Approval Mode**:
The visible Copilot permission mode selected for an agent run schedule: Default Approvals, Bypass Approvals, or Autopilot.
_Avoid_: Sandbox mode, tool allowlist

**Resolved Harness Policy**:
The concrete provider-specific permission flags, sandbox settings, and tool controls produced from an agent run schedule's approval mode and advanced policy settings.
_Avoid_: Approval mode, run instructions

**Schedule Detail**:
The editor control surface for one agent run schedule. It shows run instructions, execution policy, status, cadence, context, harness mode, model, and run history together.
_Avoid_: Settings page, run log

**Draft Schedule**:
An editable schedule created with sensible defaults before the user enables it for automatic runs.
_Avoid_: Wizard step, active schedule

**Active Schedule**:
An enabled schedule that the local worker considers during due work scans.
_Avoid_: Draft schedule, paused schedule

**Natural-Language Schedule Creation**:
The low-click path where Copilot or another VS Code agent creates an agent run schedule from a user's natural-language request.
_Avoid_: Wizard, manual-only creation

**Schedule Creation Tool**:
The VS Code language model tool that lets agent mode create or update AgentScheduler schedules from natural language. Explicit chat participant and slash-command entry points are fallback surfaces.
_Avoid_: Standalone wizard, command-palette-only flow

**Creation Confirmation**:
The user approval step that allows a complete natural-language schedule request to become an active schedule immediately.
_Avoid_: Draft enablement, approval mode

**Activation Requirements**:
The minimum fields required before a natural-language schedule can become active after confirmation: run instructions, run cadence, target context, and harness mode.
_Avoid_: Optional defaults, advanced settings

**Target Context**:
The workspace, project, issue, file, browser task, terminal command, or other context an agent run targets. In VS Code, the current workspace is the default target context when available.
_Avoid_: Run instructions, harness mode

**Schedule Revision**:
The current editable version of an agent run schedule. Active runs keep the schedule revision snapshot they started with; edits affect only future runs.
_Avoid_: Active run state, run history entry

**Looping Agent Run**:
An agent run schedule that repeats until its prompt-defined completion condition is met or a configured cap stops it.
_Avoid_: Unbounded background agent, daemon

**Run Cadence**:
The time rule that determines when a schedule should start its next agent run. Cron syntax represents the run cadence when the cadence can be expressed by cron.
_Avoid_: Completion condition, loop condition

**Completion Condition**:
The definition of done for a looping agent run. AgentScheduler can enforce scheduler-native completion conditions such as a maximum run count; domain-specific completion conditions stay in the prompt and are interpreted by the selected agent harness.
_Avoid_: Cron condition, scheduler safeguard

**Run Cap**:
A scheduler-native limit that stops a looping agent run, such as a maximum number of runs, maximum elapsed time, or budget ceiling.
_Avoid_: Prompt condition, harness preflight

**Run Counter**:
The visible progress count for a run cap, shown as completed runs out of the configured total. Manual runs increment the run counter.
_Avoid_: Previous runs list, cadence

**Paused Schedule**:
An agent run schedule that a user manually stopped from starting future runs.
_Avoid_: Completed schedule, blocked run

**Completed Schedule**:
An agent run schedule that stopped because a run cap was reached or a completion condition was satisfied.
_Avoid_: Paused schedule, disabled schedule

**Schedule Restart**:
An explicit user action that moves a completed schedule back to active state using the current schedule revision and reset scheduler-native counters.
_Avoid_: Resume, retry

**Schedule Resume**:
An explicit user action that moves a paused schedule back to active state and recomputes its next due time from the resume time.
_Avoid_: Restart, catch-up run

**Agent Harness**:
The configurable executor that performs an agent run. The harness owns agent-specific setup, safeguards, approvals, and readiness checks.
_Avoid_: Agent, bot, assistant

**Harness Contract**:
The provider-neutral interface AgentScheduler uses to preflight, start, monitor, cancel, and open agent runs without depending on one provider's lifecycle.
_Avoid_: Copilot API, Claude API, provider SDK

**Copilot Harness**:
The first agent harness AgentScheduler will support. It targets GitHub Copilot agent surfaces while preserving the harness contract for later providers.
_Avoid_: Built-in scheduler, only harness

**Harness Mode**:
A concrete execution path within an agent harness, such as a local CLI session or a cloud agent session.
_Avoid_: Provider, model

**Scheduled Model**:
The model selector stored on a schedule, including explicit model ids and provider-defined choices such as Auto. The scheduled model is the user's configuration for future runs.
_Avoid_: Executed model, harness mode

**Executed Model**:
The concrete model reported by the harness for one Agent Run. Run History records the executed model when the harness can report it, because Auto or provider defaults may resolve differently across runs.
_Avoid_: Scheduled model, model picker

**Local Copilot Mode**:
The Copilot harness mode that starts agent runs on the developer's laptop through local Copilot tooling.
_Avoid_: Cloud agent, GitHub Actions run

**Default Harness Mode**:
The harness mode selected when a complete schedule request does not explicitly specify one. In VS Code natural-language creation, the default harness mode is Local Copilot Mode.
_Avoid_: Approval mode, model default

**Cloud Copilot Mode**:
The Copilot harness mode that submits agent runs to GitHub Copilot cloud agent sessions.
_Avoid_: Local laptop run, CLI process

**Local Worker**:
The local process responsible for starting due agent runs outside the editor lifecycle.
_Avoid_: Background extension, editor timer

**Worker CLI**:
The command-line entrypoint for local worker operations such as scanning due runs and installing wakeup triggers. The MVP worker CLI is implemented in Node/TypeScript and kept separate from the VS Code extension runtime.
_Avoid_: Extension host, native daemon

**Schedule Registry**:
The per-user local store of agent run schedules. Each entry records what should run, when it should run, what context it targets, and which agent harness should execute it.
_Avoid_: Repo schedule file, tasks.json, crontab

**Local Store**:
The per-user SQLite database that stores the schedule registry and run history.
_Avoid_: JSON config file, repo database

**Schedule Export**:
A portable export of schedules, configuration, and inline run instructions from the local store for backup, review, sharing, or migration.
_Avoid_: Run history, database dump

**Schedule Export File**:
A human-readable JSON file with a schema version that contains schedule definitions and excludes run history by default.
_Avoid_: SQLite backup, run history export

**Schedule Import**:
The process of loading schedule export files into the local store. Imported schedules start paused until the user reviews validation warnings and enables them.
_Avoid_: Restore-and-run, database import

**Run History**:
The per-user local record of attempted agent runs. Run history records what happened for completed, failed, and blocked runs without changing the schedule registry itself, including the resolved run instructions, approval mode, scheduled model, executed model when reported by the harness, and resolved harness policy used for each run.
_Avoid_: Schedule registry, repo log

**Wakeup Trigger**:
The operating-system schedule entry that periodically starts the local worker so it can check for due agent runs.
_Avoid_: Schedule, agent task

**Wakeup Provider**:
The operating-system-specific implementation used to install and manage the wakeup trigger, prioritized as Windows Task Scheduler, macOS launchd, then Linux systemd timer or cron.
_Avoid_: Harness, cadence parser

**Local Scheduling Setup**:
The explicit user-confirmed process that installs, verifies, or removes the operating-system wakeup trigger for the local worker.
_Avoid_: Hidden install, extension activation

**Secondary Scheduler**:
An operating-system scheduled task, cron entry, launch agent, systemd timer, detached background loop, or similar mechanism created by a harness run to implement recurrence outside AgentScheduler.
_Avoid_: Wakeup trigger, local scheduling setup

**Scheduling Disabled State**:
The machine state where schedules can be created and edited, but automatic local wakeups are not installed or enabled.
_Avoid_: Paused schedule, draft schedule

**Automatic Run**:
An agent run started by the local worker because a schedule became due. Automatic runs require local scheduling to be enabled.
_Avoid_: Manual run, draft run

**Due Work Scan**:
The local worker's check of the schedule registry to find agent runs that should start now.
_Avoid_: Polling loop, cron job

**Idle Path**:
The worker execution path when no agent run is due. The idle path must finish in under 50 ms wall time and make no network calls.
_Avoid_: No-op run, empty tick

**Harness Preflight**:
The agent harness's structured readiness decision before an agent run starts, such as ready, blocked, requires approval, or defer.
_Avoid_: Scheduler safeguard, global safety rule

**Blocked Run**:
An agent run that did not start because AgentScheduler or the selected agent harness found a condition the user must fix. A blocked run includes a meaningful description of the error.
_Avoid_: Failed run, skipped run

**Approval-Waiting Run**:
An active agent run that is waiting for a user or harness approval decision. It keeps occupying its run slot until approval resolves, times out, or the user cancels it.
_Avoid_: Blocked run, completed run

**Approval Surface**:
An interactive UI or channel where a user can see and respond to a harness approval request.
_Avoid_: Approval mode, run notification

**Run Slot**:
The concurrency boundary for agent runs, defined by the target context plus the selected harness mode. By default, only one active run may occupy a run slot at a time.
_Avoid_: Global queue, worker thread

**Deferred Run**:
An agent run that was due but could not start because its run slot was occupied. Deferred runs are coalesced so a busy slot produces at most one catch-up run per schedule.
_Avoid_: Blocked run, failed run, unbounded queue

**Catch-up Run**:
A single agent run started after one or more due times were missed because the machine was asleep, offline, or otherwise unable to run the local worker.
_Avoid_: Replay, backlog drain

**Manual Run**:
An agent run started by the user from a schedule detail instead of by the time-based due check. Manual runs still honor run slots, harness preflight, approval mode, run caps, and execution policy.
_Avoid_: Test bypass, unscheduled session

**Draft Run**:
A manual run started from a draft schedule before recurrence is enabled. Draft runs validate the current schedule revision but do not increment scheduler-native run caps.
_Avoid_: Active schedule run, recurrence

**Editor Control Surface**:
The editor-facing experience where a developer creates, edits, monitors, and reviews agent run schedules and run results.
_Avoid_: Scheduler, worker

**Codex-like Schedule View**:
The schedule detail interface pattern modeled on Codex automations, with run instructions, status, next run, last run, harness mode, context, cadence, model, and previous runs visible together.
_Avoid_: Generic cron editor, settings form

**Run Notification**:
A user-facing alert about an agent run outcome, such as completion, blocked state, failure, or approval needed. Run notifications default to quiet in-app status and history updates.
_Avoid_: Run history, desktop-only alert
