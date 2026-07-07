# Snapshot resolved policy in run history

AgentScheduler will store both the user-facing approval mode and the resolved harness policy used for each run in run history. We chose this because defaults and harness mappings can change over time, and users need to audit exactly which permissions, sandbox settings, and backend switches were applied to a past run.
