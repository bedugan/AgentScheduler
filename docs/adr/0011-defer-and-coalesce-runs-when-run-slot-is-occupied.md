# Defer and coalesce runs when a run slot is occupied

When an agent run is due but its run slot is occupied, AgentScheduler will defer it and coalesce missed due times into at most one catch-up run per schedule. We chose this over blocking or unbounded queueing because a busy slot is not a user-fixable error, and repeated wakeups should not create a backlog storm after a long run or machine sleep.
