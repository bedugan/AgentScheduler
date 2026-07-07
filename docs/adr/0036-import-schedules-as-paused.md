# Import schedules as paused

AgentScheduler will import schedules in a paused state and show validation warnings for missing contexts, unavailable harnesses, stale approval modes, or machine-specific paths. We chose this because imported schedules may not be safe or runnable on the current machine until the user reviews and explicitly enables them.
