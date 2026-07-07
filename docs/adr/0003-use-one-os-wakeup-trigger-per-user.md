# Use one OS wakeup trigger per user

AgentScheduler will install one operating-system wakeup trigger per user and keep the schedule registry as the source of truth for individual schedules. The local worker must make each due work scan extremely cheap so frequent wakeups are acceptable; this avoids creating one cron, launchd, systemd, or Windows Task Scheduler entry per agent run schedule.
