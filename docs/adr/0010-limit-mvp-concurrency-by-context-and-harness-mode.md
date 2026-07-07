# Limit MVP concurrency by context and harness mode

AgentScheduler will allow only one active agent run per target context and harness mode by default. We chose this because local laptop workflows are vulnerable to overlapping edits, competing CLI sessions, duplicated notifications, and ambiguous run history when multiple due schedules target the same place at the same time.
