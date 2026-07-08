# Forbid secondary schedulers in Local Copilot runs

Local Copilot Mode runs must not create operating-system scheduled tasks, cron entries, launch agents, systemd timers, detached background loops, or similar secondary schedulers solely to implement an AgentScheduler schedule's recurrence. AgentScheduler owns recurrence through Run Cadence and Local Scheduling Setup; the harness receives only one Agent Run occurrence at a time. Bypass Approvals and Autopilot may broaden tool execution, but they do not grant permission to create another scheduler for the same recurrence.

We chose this because prompt-only guidance is not a strong enough boundary when local CLI models have different capabilities and approval behavior. If Local Copilot Mode cannot enforce the no-secondary-scheduler policy for a run, it should block before start with a meaningful Run History reason instead of silently allowing duplicated local scheduling state.
