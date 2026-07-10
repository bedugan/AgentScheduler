# PRD: AgentScheduler MVP for local Copilot schedules

## Problem Statement

Developers using VS Code and Copilot can run agentic work interactively, but they lack a reliable local way to schedule and loop agent runs on a developer laptop. They want Codex-like scheduled agent runs that can happen later, recur, loop until a condition is met, and be reviewed from an editor surface without requiring repeated manual prompting.

The current gap is especially painful for branch watching, review loops, recurring status checks, and local workflows where the user wants Copilot to run on a cadence with clear instructions and permissions. The user should be able to say something like "Create a scheduled task that runs every hour to review bug branches" and get a working schedule with minimal clicking, while still retaining explicit control over approvals, harness mode, cadence, run history, and local scheduling setup.

## Solution

Build AgentScheduler as a VS Code extension plus a small local worker CLI. VS Code is the editor control surface; the local worker starts due agent runs outside the editor lifecycle. The MVP is local-laptop-first, targets Copilot first, and supports both Local Copilot Mode and Cloud Copilot Mode through a provider-neutral harness contract.

Users can create schedules through a Codex-like schedule detail view or through natural language in VS Code agent mode. Natural-language creation uses a VS Code language model tool so Copilot can create schedules from prompts such as "run every hour to..." with one confirmation when the request is complete. A chat participant and slash command provide explicit fallback entry points.

Schedules live in a per-user SQLite local store. Run history is stored separately from the schedule registry but linked to it. Run history snapshots the resolved run instructions, approval mode, scheduled model, executed model when reported by the harness, and resolved harness policy used for each run so past behavior remains auditable after a schedule changes.

Automatic runs require an explicitly installed OS wakeup trigger. AgentScheduler installs that trigger only after user confirmation and prioritizes Windows Task Scheduler first, macOS launchd second, and Linux systemd timer or cron later. Manual runs continue to work when local scheduling is disabled if the selected harness can run from the current VS Code session.

## User Stories

1. As a VS Code developer, I want to create an Agent Run schedule from natural language, so that I do not have to configure every field manually.
2. As a VS Code developer, I want Copilot to create a schedule when I ask for recurring work, so that scheduling feels like part of agent mode.
3. As a VS Code developer, I want a schedule to become active after one confirmation when my request is complete, so that I avoid unnecessary clicks.
4. As a VS Code developer, I want incomplete or risky natural-language requests to become disabled drafts, so that nothing runs before I review missing details.
5. As a VS Code developer, I want the current workspace to be the default Target Context, so that most schedule creation requests work without extra configuration.
6. As a VS Code developer, I want Local Copilot Mode to be the default Harness Mode, so that schedules run on my laptop unless I ask for cloud execution.
7. As a VS Code developer, I want to choose Cloud Copilot Mode explicitly, so that I can use GitHub-visible cloud sessions when appropriate.
8. As a VS Code developer, I want a Codex-like Schedule Detail view, so that I can see instructions, status, next run, last run, mode, context, cadence, model, policy, and previous runs together.
9. As a VS Code developer, I want to edit Run Instructions inline, so that scheduled behavior is visible and self-contained.
10. As a VS Code developer, I want Draft Schedules to start disabled, so that creating a schedule cannot accidentally start recurrence.
11. As a VS Code developer, I want to manually run a draft schedule, so that I can validate it before enabling recurrence.
12. As a VS Code developer, I want draft manual runs not to count against Run Caps, so that pre-enable validation does not consume the loop.
13. As a VS Code developer, I want to manually run an enabled schedule, so that I can test or trigger work on demand.
14. As a VS Code developer, I want manual runs on enabled schedules to count against Run Caps, so that run counters match actual schedule executions.
15. As a VS Code developer, I want a visible Run Counter such as `3/5`, so that I know why a looping schedule continues or completes.
16. As a VS Code developer, I want schedules with finite caps to become Completed, so that I can distinguish finished loops from manually Paused schedules.
17. As a VS Code developer, I want Paused to mean I manually stopped future runs, so that status explains user intent.
18. As a VS Code developer, I want a Completed Schedule to be restartable through an explicit action, so that I can reuse a finished loop without losing history.
19. As a VS Code developer, I want resuming a Paused Schedule to compute the next due time from now, so that old paused intervals do not create catch-up runs.
20. As a VS Code developer, I want schedule edits during active runs to apply only to future runs, so that active run behavior remains auditable.
21. As a VS Code developer, I want Run History to show what prompt actually ran, so that I can debug historical results after editing instructions.
22. As a VS Code developer, I want Run History to show the approval mode and resolved backend policy used for a run, so that permission behavior is auditable.
23. As a VS Code developer, I want run outcomes to appear quietly in the Schedule Detail and Run History, so that recurring schedules do not spam me.
24. As a VS Code developer, I want desktop notifications to be opt-in or severity-based, so that only important schedule events interrupt me.
25. As a VS Code developer, I want a schedule to block with a meaningful error when its selected harness is unavailable, so that I know what to fix.
26. As a VS Code developer, I want AgentScheduler not to silently fall back to another harness, so that the scheduled model and approval behavior are predictable.
27. As a VS Code developer, I want Default Approvals, Bypass Approvals, and Autopilot to match VS Code Copilot wording, so that the schedule permissions are familiar.
28. As a VS Code developer, I want Default Approvals to be the default Approval Mode, so that schedules respect my existing Copilot settings.
29. As a VS Code developer, I want execution policy controls visible in the Schedule Detail, so that unattended permissions are clear before a run starts.
30. As a VS Code developer, I want Default Approvals to block before start when no Approval Surface is available, so that a background run does not hang invisibly.
31. As a VS Code developer, I want approval-needed runs to remain active while waiting for approval, so that the schedule does not start overlapping work.
32. As a VS Code developer, I want only one active run per Target Context and Harness Mode by default, so that local agent work does not overlap unsafely.
33. As a VS Code developer, I want busy Run Slots to defer and coalesce due runs, so that repeated intervals do not create an unbounded queue.
34. As a VS Code developer, I want missed due times after sleep or downtime to produce at most one Catch-up Run, so that my laptop does not wake into a backlog storm.
35. As a VS Code developer, I want Local Scheduling Setup to be explicit, so that creating a schedule does not silently install a background OS trigger.
36. As a VS Code developer, I want the extension to offer "Enable local scheduling", so that setup is discoverable from the editor.
37. As a VS Code developer, I want CLI install and uninstall commands for the wakeup trigger, so that background scheduling is transparent and debuggable.
38. As a Windows developer, I want Windows Task Scheduler support first, so that the MVP works on the most important VS Code/Copilot laptop target.
39. As a macOS developer, I want launchd support, so that AgentScheduler works on macOS developer laptops.
40. As a Linux developer, I want later systemd timer or cron support, so that AgentScheduler can become cross-platform after the core is stable.
41. As a developer, I want the Idle Path to finish in under 50 ms and make no network calls when no run is due, so that frequent wakeups are cheap.
42. As a developer, I want schedules and run history stored locally, so that private prompts and personal cadences are not committed to repositories.
43. As a developer, I want SQLite-backed schedule storage, so that due scans are indexed, transactional, and safe across the worker and extension.
44. As a developer, I want schedules exportable as human-readable JSON, so that schedules are not trapped in an opaque local database.
45. As a developer, I want exports to include inline prompt text and configuration references, so that I can back up and migrate schedules.
46. As a developer, I want exports to exclude Run History by default, so that sensitive outputs and large artifacts are not shared accidentally.
47. As a developer, I want imported schedules to start paused, so that machine-specific paths and harness settings are reviewed before running.
48. As a developer, I want import validation warnings, so that I can repair missing workspaces, unavailable harnesses, or stale policy settings.
49. As a developer, I want Looping Agent Runs to use cron syntax when the cadence is cron-expressible, so that custom schedules are precise.
50. As a developer, I want scheduler-native completion conditions like "run five times" to be enforced by AgentScheduler, so that simple caps are reliable.
51. As a developer, I want domain-specific completion conditions to stay in Run Instructions, so that the selected harness interprets task-specific done criteria.
52. As a developer, I want Copilot schedules to map visible Approval Modes to backend Copilot CLI or API switches, so that UI choices become concrete execution behavior.
53. As a developer, I want AgentScheduler to support future Claude or Codex harnesses behind the same contract, so that the scheduler is not Copilot-only forever.
54. As a developer, I want a disabled schedule to still support user-initiated runs when possible, so that local scheduling setup is not required for manual testing.
55. As a developer, I want the schedule UI to avoid a wizard, so that expert users can create and adjust schedules quickly from one detail view.

## Implementation Decisions

- Build the core around a Schedule Lifecycle API. This is the main seam for implementation and testing. It owns schedule creation, validation, activation, due scans, manual runs, status transitions, run counters, import/export, and history snapshotting.
- Build a VS Code extension that provides the Editor Control Surface, the Codex-like Schedule Detail, the Schedule Creation Tool, an explicit chat participant, and a slash command fallback.
- Use the VS Code Language Model Tool API as the primary low-click natural-language creation path. Copilot agent mode should be able to invoke schedule creation automatically from a natural-language request.
- Use a chat participant and slash command only as explicit fallback surfaces, not the primary path.
- Require Run Instructions, Run Cadence, Target Context, and Harness Mode before a natural-language schedule can become active after one confirmation.
- Default Target Context to the current VS Code workspace when a schedule is created inside an open workspace.
- Default Harness Mode to Local Copilot Mode for VS Code natural-language creation.
- Default new Copilot schedules to Default Approvals.
- Present Copilot Approval Modes using the VS Code vocabulary: Default Approvals, Bypass Approvals, and Autopilot.
- Resolve visible Approval Modes to concrete harness-specific backend settings at run time. For Copilot CLI this may include tool availability, allow/deny tool permissions, permissive modes, and sandbox settings.
- Snapshot the resolved harness policy in Run History for every run.
- Snapshot the scheduled model and harness-reported executed model in Run History.
- Store inline Run Instructions in the schedule for MVP. External prompt files are out of the MVP but should remain possible later.
- Snapshot the resolved Run Instructions in Run History for every run.
- Allow editing schedules while runs are active, but edits apply only to future runs. Active runs keep the Schedule Revision they started with.
- Build a provider-neutral Harness Contract with operations for preflight, starting runs, getting status, cancelling, and opening/reviewing runs.
- Build the Copilot Harness first, with Local Copilot Mode prioritized and Cloud Copilot Mode also supported by the contract.
- Keep AgentScheduler domain-agnostic. Harnesses own safeguards such as dirty worktree checks, model auth, network access, workspace validity, and approval availability.
- If a selected Agent Harness is unavailable, block the run with a meaningful description. Do not silently fall back.
- Treat approval-needed after start as an active run state. It occupies the Run Slot until approval resolves, times out, or the user cancels.
- If Default Approvals would require an approval but no Approval Surface is available, block during Harness Preflight before start.
- Local Copilot Mode must block run instructions that ask the harness to create secondary schedulers for recurrence. AgentScheduler owns recurrence through Run Cadence and Local Scheduling Setup.
- Enforce one active run per Run Slot by default. A Run Slot is Target Context plus Harness Mode.
- When a due run finds its Run Slot occupied, defer and coalesce. Produce at most one catch-up run per schedule.
- After machine downtime or sleep, coalesce missed due times into at most one Catch-up Run per schedule.
- Model looping as Run Cadence plus Completion Conditions. Cron syntax represents cadence when suitable.
- Enforce scheduler-native Run Caps such as maximum run count inside AgentScheduler.
- Keep domain-specific completion conditions in Run Instructions and have the selected harness interpret/report them.
- Count manual runs on enabled schedules against Run Caps.
- Do not count Draft Runs against Run Caps.
- Use Paused Schedule for user-paused schedules and Completed Schedule for schedules stopped by Run Caps or prompt-level completion conditions.
- Allow Completed Schedules to restart only through an explicit Restart action that resets scheduler-native counters.
- Resume Paused Schedules by recomputing next due time from resume time.
- Allow Manual Runs when local scheduling is disabled if the selected harness can run from the current extension/session.
- Keep Draft Schedules disabled until explicitly enabled.
- Let complete natural-language requests become active after one confirmation. Create a disabled draft if required fields are missing or the request is risky.
- Store schedules in per-user local state rather than repository files.
- Use SQLite for the Local Store, covering Schedule Registry and Run History.
- Optimize the worker Idle Path to finish under 50 ms wall time and make no network calls when no run is due.
- Implement one OS Wakeup Trigger per user. The OS trigger wakes the Worker CLI, and the Worker CLI reads the Local Store to find due runs.
- Implement the MVP Worker CLI in Node/TypeScript, separate from the VS Code extension runtime.
- Prioritize Wakeup Providers in this order: Windows Task Scheduler, macOS launchd, then Linux systemd timer or cron.
- Require explicit user confirmation before installing the OS Wakeup Trigger.
- Provide CLI commands to install, verify, and uninstall the wakeup trigger.
- If local scheduling is not enabled, allow schedule creation and editing but keep automatic runs inactive until setup is enabled.
- Export schedules as versioned human-readable JSON. Include schedule definitions, harness configuration references, Approval Modes, cadence, caps, Target Context references, and inline Run Instructions.
- Exclude Run History from schedule export by default.
- Import schedules as Paused and show validation warnings before the user enables them.
- Default run notifications to quiet in-app Schedule Detail and Run History updates. Desktop notifications should be opt-in per schedule or severity-based.

## Testing Decisions

- Test external behavior through the Schedule Lifecycle API rather than directly testing UI widgets, database tables, or harness internals first.
- The Schedule Lifecycle API is the highest-value seam. It should be able to run against fake clocks, fake stores, fake wakeup providers, and fake harnesses.
- Add contract tests for the Harness Contract using a fake harness and the Copilot Harness adapter. These tests should verify preflight decisions, start behavior, status transitions, cancellation, open/review behavior, and meaningful blocked errors.
- Add scheduler state machine tests for Draft, Active, Paused, Completed, Blocked Run, Deferred Run, Approval-Waiting Run, Catch-up Run, Manual Run, and Draft Run behavior.
- Add tests for activation requirements: complete natural-language requests can activate after confirmation; incomplete requests create disabled drafts.
- Add tests for defaulting: current VS Code workspace as Target Context, Local Copilot Mode as Default Harness Mode, and Default Approvals as default Approval Mode.
- Add tests for Run Cap handling: scheduled runs increment counters, manual enabled-schedule runs increment counters, draft runs do not increment counters, and terminal caps produce Completed Schedule.
- Add tests for completion behavior: Paused resumes from resume time, Completed restarts only through explicit restart, and restart resets scheduler-native counters without deleting Run History.
- Add tests for due scanning: no due runs exits quickly, no network calls occur on Idle Path, and only an indexed due check is needed.
- Add tests for concurrency: one active run per Run Slot, busy slots defer, deferred runs coalesce, and catch-up does not create an unbounded queue.
- Add tests for downtime behavior: multiple missed intervals after sleep produce one Catch-up Run.
- Add tests for approval behavior: approval-needed after start occupies the Run Slot; Default Approvals without an Approval Surface blocks in preflight.
- Add tests for policy snapshotting: Run History records the user-facing Approval Mode and the Resolved Harness Policy used at launch.
- Add tests for instruction snapshotting: Run History records the exact resolved Run Instructions used at launch even after schedule edits.
- Add tests for editing active schedules: active runs keep their starting Schedule Revision and edits apply only to future runs.
- Add tests for import/export: exported schedules are versioned JSON, exclude Run History by default, include inline Run Instructions, and import as Paused with validation warnings.
- Add tests for local scheduling setup: schedule creation does not silently install a Wakeup Trigger, local scheduling can be explicitly enabled, and manual runs can still execute when automatic scheduling is disabled.
- Add integration tests around the Worker CLI due-scan command using a temporary Local Store and fake harnesses.
- Add platform unit tests for Wakeup Provider command generation/installation intent for Windows Task Scheduler and macOS launchd before attempting full end-to-end OS tests.
- Add VS Code extension tests for the Schedule Creation Tool path using mocked VS Code APIs and fake model/tool invocations.
- Add UI behavior tests for the Schedule Detail at the view-model level: fields shown together, status transitions, run counter, quiet notifications, and blocked/error messaging.

## Out of Scope

- A native worker binary for MVP.
- Linux wakeup provider implementation before Windows Task Scheduler and macOS launchd.
- Team-shared repository schedule files as the primary storage model.
- External prompt-file Instruction Sources in the MVP.
- Exporting Run History by default.
- Full cloud-first implementation as the primary MVP path.
- Silent installation of background OS triggers.
- Silent fallback from one Agent Harness to another.
- Unlimited concurrent runs in the same Target Context and Harness Mode.
- Replaying every missed interval after laptop sleep or downtime.
- A multi-step schedule creation wizard.
- Building a custom policy vocabulary that replaces visible Copilot Approval Modes.
- Provider-specific safeguards inside AgentScheduler core; those belong to harnesses.
- Guaranteeing semantic stop-condition interpretation in AgentScheduler when the condition is domain-specific.

## Further Notes

- The public OpenAI Codex repo and Codex documentation are useful as architectural references for local agent execution, non-interactive execution, and Codex-like schedule UI behavior, but AgentScheduler should not copy Codex-specific assumptions into the scheduler core.
- Current VS Code AI extension points support the intended low-click flow: Language Model Tools can be invoked automatically in agent mode, while Chat Participants and slash commands support explicit user entry points.
- The MVP should keep the implementation small but preserve the long-term boundary: scheduler core, harness adapters, local worker, local store, and editor control surface remain separate concepts.
- The first implementation should favor correctness and auditability over broad provider support. A narrow Copilot-first path behind a real Harness Contract is the right starting point.
