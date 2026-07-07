# Default run notifications to quiet in-app updates

AgentScheduler will show run outcomes in the schedule detail and run history by default, while desktop or toast notifications will be opt-in per schedule or limited to higher-severity outcomes. We chose this because recurring local loops can generate frequent events, and noisy notifications would make schedules harder to keep enabled.
