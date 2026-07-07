# Store agent run schedules in local user state

AgentScheduler will store agent run schedules in a per-user local schedule registry rather than committing schedules to repository files. We chose this because schedules can contain private prompts, personal cadences, and machine-specific context references, while the local worker needs one place to discover due runs even when VS Code is closed.
