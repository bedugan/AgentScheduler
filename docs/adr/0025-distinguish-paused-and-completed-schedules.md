# Distinguish paused and completed schedules

AgentScheduler will use Paused for schedules manually stopped by the user and Completed for schedules that stop because a run cap is reached or a completion condition is satisfied. We chose separate statuses so the schedule detail can show whether future runs stopped because of user intent or because the schedule finished its defined loop.
