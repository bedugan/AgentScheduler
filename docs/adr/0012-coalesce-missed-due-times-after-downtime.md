# Coalesce missed due times after downtime

When scheduled due times are missed because the machine was asleep, offline, or unable to run the local worker, AgentScheduler will start at most one catch-up run per schedule after recovery. We chose this over replaying every missed interval because replaying can create surprising cost, duplicate work, and long startup backlogs on developer laptops.
