# Block runs when the selected harness is unavailable

AgentScheduler will not silently fall back to another agent harness when the selected harness is unavailable. A due agent run will become a blocked run with a meaningful description of the error, because fallback could execute a different model, permission policy, or approval flow than the user scheduled.
