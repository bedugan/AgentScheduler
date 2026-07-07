# Snapshot resolved run instructions in run history

AgentScheduler will store the resolved run instructions used to start each agent run in run history. We chose this because schedules and external prompt sources can change over time, and users need to inspect the exact prompt text that produced a past result.
