# Store run history in local user state

AgentScheduler will store completed, failed, and blocked run history in local user state, separate from but linked to the schedule registry. We chose this because the schedule registry answers what should run next, while run history answers what happened, and storing history in repo files would leak prompts or results and create repository churn.
