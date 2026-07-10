# AgentScheduler

AgentScheduler is a VS Code extension for creating, editing, and reviewing scheduled Agent Runs. VS Code is the editor control surface; schedules and run history are stored in per-user local state, and a separate worker CLI scans for due automatic runs.

The MVP is local-first and Copilot-focused. It supports Local Copilot Mode and Cloud Copilot Mode through a provider-neutral harness contract, but runs only start when the selected Harness Mode is available. AgentScheduler blocks unavailable harnesses or models instead of silently falling back to a different execution path.

## Current State

- Schedules are stored in a local SQLite database named `agent-scheduler.sqlite` under the extension global storage directory.
- The Schedule Detail editor supports draft creation, activation, manual runs, pause/resume, completed-schedule restart, deletion, model selection, local scheduling state, and previous run history.
- Natural-Language Schedule Creation is exposed through a VS Code language model tool, the `@agentScheduler` chat participant, and the `/createSchedule` chat command.
- Automatic runs require Local Scheduling Setup. Creating or activating a schedule does not silently install an operating-system Wakeup Trigger.
- The default packaged VS Code services currently register the scheduler UI, storage, model catalog, command surfaces, and Local Copilot Mode backed by GitHub Copilot CLI. Cloud Copilot Mode still depends on an available cloud harness implementation.

## Prerequisites

- VS Code `^1.100.0`.
- Node.js `>=26`.
- npm.
- GitHub Copilot and VS Code language model APIs if you want model discovery or natural-language schedule creation.
- GitHub Copilot CLI for Local Copilot Mode. Check it with `copilot --version`; if it is missing, install it or run `gh copilot` to fetch it through GitHub CLI.
- Windows or macOS for Local Scheduling Setup. Linux wakeup providers are not part of the MVP path yet.

## Local Development

Install dependencies:

```sh
npm install
```

Build the extension and worker CLI:

```sh
npm run build
```

Typecheck without writing build output:

```sh
npm run typecheck
```

Run the test suite:

```sh
npm test
```

Create a local VSIX package:

```sh
npx @vscode/vsce package
```

Install the generated VSIX from VS Code with `Extensions: Install from VSIX...`, or with the VS Code CLI:

```sh
code --install-extension agent-scheduler-0.1.0.vsix
```

## Extension Surfaces

| Surface | ID | Purpose |
| --- | --- | --- |
| Schedule List view | `agentScheduler.scheduleList` | Explorer view that lists schedules and opens Schedule Detail. |
| New Schedule command | `agentScheduler.newSchedule` | Creates a disabled Draft Schedule with current-workspace defaults when available. |
| Open Schedule command | `agentScheduler.openSchedule` | Opens an existing schedule in Schedule Detail. |
| Delete Schedule command | `agentScheduler.deleteSchedule` | Confirms and deletes a schedule plus its Run History. |
| Create Schedule command | `agentScheduler.createSchedule` | Command fallback for Natural-Language Schedule Creation. |
| Language model tool | `agentScheduler_createSchedule` | Lets VS Code agent mode create schedules from natural language. |
| Chat participant | `agentScheduler.schedule` | Exposed as `@agentScheduler` for schedule creation and review entry points. |
| Chat command | `/createSchedule` | Explicit chat fallback for natural-language creation. |

## Basic Usage

### Create a Draft Schedule

Run `AgentScheduler: New Schedule` or select the empty item in the AgentScheduler Explorer view. The extension opens Schedule Detail with editable fields for Run Instructions, Cron Expression, Target Context, Harness Mode, model, Approval Mode, and Maximum Run Count.

Draft Schedules are disabled. They can be edited safely before automatic recurrence is enabled.

### Create a Schedule From Natural Language

In VS Code agent mode, ask Copilot to create a recurring AgentScheduler schedule. The language model tool can receive a natural-language request plus structured fields such as cadence, Target Context, Harness Mode, model, Approval Mode, and run cap.

Complete low-risk requests ask for Creation Confirmation before becoming active. Incomplete requests, risky requests, unavailable Harness Modes, or unavailable models are saved as Draft Schedules for review. You can also use `@agentScheduler /createSchedule` as an explicit fallback path.

### Activate Automatic Recurrence

A schedule needs these Activation Requirements before it can become active:

- Run Instructions.
- Run Cadence.
- Target Context.
- Harness Mode.

Use `Activate` in Schedule Detail after those fields are set. An Active Schedule is eligible for automatic due scans, but automatic runs remain inactive until Local Scheduling Setup is enabled on the machine.

### Run Manually

Use `Run Now` from Schedule Detail to start a Manual Run when the selected harness is available. Manual Runs still honor Run Slots, Harness Preflight, Approval Mode, run caps, and Execution Policy.

Draft Runs do not increment scheduler-native run caps. Manual Runs from enabled schedules do increment run caps.

### Local Copilot Mode

Local Copilot Mode runs through GitHub Copilot CLI. AgentScheduler invokes `copilot -p` with the schedule instructions, `--model` from the schedule, `--output-format json`, and `-C` set to the Target Context workspace when the target is a local file URI.

Before using Local Copilot Mode, verify the same environment that will start the run can see the CLI:

```sh
copilot --version
```

If the command is missing, install GitHub Copilot CLI or run:

```sh
gh copilot
```

For interactive use, authenticate with:

```sh
copilot login
```

For unattended worker contexts, configure `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` if the worker cannot use the interactive login. Set `COPILOT_CLI_PATH` when `copilot` is not on the worker process `PATH`.

Approval Mode maps to concrete CLI behavior:

- Default Approvals uses no auto-approval flags and requires an approval surface. Unattended automatic runs block before start when no approval surface is available.
- Bypass Approvals uses `--no-ask-user --allow-all-tools`.
- Autopilot uses `--no-ask-user --autopilot --allow-all`.

### Pause, Resume, and Restart

Use `Pause` to stop an Active Schedule from starting future runs. Use `Resume` to make a Paused Schedule active again; the next due time is recomputed from the resume time, so missed intervals do not replay.

Schedules with finite run caps become Completed Schedules when the cap is reached. Use `Restart` to explicitly reset scheduler-native counters and make a Completed Schedule active again without deleting Run History.

### Review Run History

Schedule Detail shows Previous Runs with status, trigger, timestamps, detail text, and outcome. Run History records the run instructions snapshot, Approval Mode, model, Target Context, Harness Mode, external run ID, summary, error, and resolved harness policy used for each attempt.

Run notifications default to quiet in-app updates through Schedule Detail and Run History.

### Delete a Schedule

Use `Delete Schedule` from Schedule Detail or the Schedule List context menu. The extension asks for confirmation, deletes the schedule, and deletes its Run History. Deletion is blocked while the schedule has an active run. The shared Local Scheduling wakeup trigger is not removed when one schedule is deleted.

## Local Scheduling Setup

Local Scheduling Setup installs one operating-system Wakeup Trigger per user. The trigger starts the Worker CLI periodically, and the Worker CLI reads the Local Store to scan for due automatic runs.

From any Schedule Detail, select **Enable Local Scheduling**. AgentScheduler shows the exact platform, trigger ID, interval, Worker command, OS command, and generated file path in a modal confirmation before making OS changes. Once enabled, use **Verify Local Scheduling** or **Disable Local Scheduling** from the same section. Every open Schedule Detail and the Schedule List refresh after setup changes. Creating or activating a schedule never runs this setup implicitly.

The installed extension uses its packaged `dist/src/workerCli.js` and the `agent-scheduler.sqlite` Local Store under VS Code global storage. The Wakeup Trigger requires a standalone absolute Node.js executable; VS Code's Electron executable is not used. If Node is not discoverable on `PATH`, set `AGENT_SCHEDULER_NODE_PATH` to the absolute `node` or `node.exe` path before starting VS Code.

The Worker CLI commands below remain available for diagnostics and manual administration.

Build first:

```sh
npm run build
```

Preview the OS commands without applying them:

```sh
node dist/src/workerCli.js local-scheduling install --dry-run --platform macos
```

Install, verify, or uninstall the wakeup trigger:

```sh
node dist/src/workerCli.js local-scheduling install --store /path/to/agent-scheduler.sqlite --platform macos
node dist/src/workerCli.js local-scheduling verify --store /path/to/agent-scheduler.sqlite --platform macos
node dist/src/workerCli.js local-scheduling uninstall --store /path/to/agent-scheduler.sqlite --platform macos
```

Run one due-work scan manually:

```sh
node dist/src/workerCli.js scan-due-work --store /path/to/agent-scheduler.sqlite
```

`--platform` accepts `windows`, `win32`, `macos`, or `darwin`. If omitted, the CLI infers the current platform on Windows and macOS. The default trigger IDs are `AgentSchedulerLocalWakeup` on Windows and `com.bedugan.AgentScheduler.local-wakeup` on macOS.

Automatic Local Copilot Mode runs use the same Copilot CLI harness as manual runs. OS wakeup triggers often start with a different `PATH` than your terminal or VS Code session, so verify `copilot --version` from the worker environment or set `COPILOT_CLI_PATH` to an absolute CLI path.

## Key Concepts

**Agent Run**: A scheduled prompt executed by a configured agent harness against a Target Context.

**Run Instructions**: Durable prompt text that tells the harness what to do each time the schedule fires.

**Execution Policy**: Enforceable permission and approval settings for a run. The visible Copilot Approval Modes are Default Approvals, Bypass Approvals, and Autopilot.

**Harness Mode**: A concrete execution path in an Agent Harness, currently Local Copilot Mode or Cloud Copilot Mode.

**Target Context**: The workspace or other context an Agent Run targets. In VS Code, the current workspace is used as the default when available.

**Run Cadence**: The time rule for the next run. The MVP stores cron expressions and summarizes common cadences such as hourly, daily, and weekly.

**Local Scheduling Setup**: The explicit user-confirmed setup that installs, verifies, or removes the OS Wakeup Trigger used for automatic runs.

**Manual Run**: A user-started run from Schedule Detail. It still respects Harness Preflight, Execution Policy, Run Slots, and run caps.

**Run History**: The local record of attempted runs, including completed, failed, blocked, deferred, and approval-waiting outcomes.

## Troubleshooting

**Automatic runs are inactive**: Local Scheduling Setup is disabled. Activate the schedule if needed, then select **Enable Local Scheduling** in Schedule Detail and confirm the exact Wakeup Trigger intent. Manual Run Now can still work from the editor when the selected harness is available.

**No Copilot harness modes are available**: The current extension environment has no registered available harness for Local Copilot Mode or Cloud Copilot Mode. Choose an available mode if one is listed, or wire/register the appropriate harness implementation before expecting runs to start.

**Local Copilot Mode is unavailable because `copilot` is missing**: Install GitHub Copilot CLI, run `gh copilot`, or set `COPILOT_CLI_PATH`. For automatic runs, remember that launchd and Task Scheduler may not inherit the same `PATH` as your interactive shell.

**Local Copilot Mode is unavailable because authentication is missing**: Run `copilot login` in an interactive shell, or configure `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` for unattended worker contexts.

**Saved model is unavailable or legacy**: The selected model is not currently reported by VS Code chat model discovery. Pick an available model from the Model field, sign in to Copilot if needed, or enter a model ID manually when no model catalog is reported.

**A run is blocked with Default Approvals**: Default Approvals may need an Approval Surface. For unattended automatic runs, use Bypass Approvals or Autopilot only when that permission behavior is acceptable for the schedule.

Blocked and failed automatic runs are recorded once per due occurrence and retry at the next Run Cadence. They do not remain immediately due on every Wakeup Trigger scan.

**Delete is disabled**: The schedule has an active run. Wait for the run to finish or cancel it through the harness before deleting the schedule.

**Worker CLI says `--store is required`**: Local scheduling install, verify, and uninstall commands need the SQLite Local Store path. The VS Code extension stores it in the extension global storage directory as `agent-scheduler.sqlite`.

**Linux setup fails**: Linux wakeup providers are not implemented in the MVP. Use Windows Task Scheduler or macOS launchd for automatic wakeups.

## Screenshots

The following placeholders mark useful future screenshots. They are intentionally not real screenshots yet.

- Placeholder: Schedule List view in the Explorer sidebar.
- Placeholder: Schedule Detail editor with Overview, Editable Fields, Actions, Local Scheduling, and Previous Runs.
- Placeholder: Natural-language schedule creation confirmation dialog.
- Placeholder: Local Scheduling status shown in Schedule Detail.

## Architecture and Development Notes

- Shared domain language lives in [`CONTEXT.md`](./CONTEXT.md).
- The MVP product direction lives in [`docs/prd/agent-scheduler-mvp.md`](./docs/prd/agent-scheduler-mvp.md).
- Architecture decisions live under [`docs/adr/`](./docs/adr/).
- The Schedule Lifecycle API owns schedule creation, activation, due scans, manual runs, transitions, run caps, import/export, and history snapshotting.
- The Harness Contract separates scheduling from provider-specific execution.
- The Worker CLI is separate from the VS Code extension runtime so automatic runs do not depend on editor uptime.
