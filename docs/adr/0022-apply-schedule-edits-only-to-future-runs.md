# Apply schedule edits only to future runs

AgentScheduler will allow editing a schedule while a run is active, but the active run will keep the schedule revision snapshot it started with. We chose this because live mutation would make run behavior unauditable, while future-only edits let users adjust schedules without interrupting in-flight work.
