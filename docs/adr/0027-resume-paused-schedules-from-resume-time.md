# Resume paused schedules from resume time

When a paused schedule is resumed, AgentScheduler will recompute the next due time from the moment of resume instead of replaying missed due times. We chose this because pausing is explicit user intent to suppress runs, unlike machine downtime where a catch-up run may be appropriate.
