# Run instructions are constrained by execution policy

AgentScheduler will treat the schedule prompt as run instructions and execute those instructions only within the selected execution policy. If run instructions conflict with tool approval settings, sandbox behavior, harness restrictions, or schedule-allowed modes, the execution policy wins and the run is blocked, deferred, or failed with a meaningful explanation.
