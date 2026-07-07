# Prioritize Windows Task Scheduler, then macOS, then Linux

AgentScheduler will prioritize wakeup provider support in this order: Windows Task Scheduler first, macOS launchd second, and Linux systemd timers or cron after that. We chose this because VS Code and Copilot developer laptop usage makes Windows the most important target, while macOS is the current development environment and Linux can follow once the core worker and installer abstractions are stable.
