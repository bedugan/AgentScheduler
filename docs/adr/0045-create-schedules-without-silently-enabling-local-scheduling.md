# Create schedules without silently enabling local scheduling

If local scheduling is not enabled, AgentScheduler will still allow schedules to be created and edited, but automatic runs will remain inactive until the user explicitly enables local scheduling. We chose this because creating a schedule should not silently install an operating-system wakeup trigger as a side effect.
