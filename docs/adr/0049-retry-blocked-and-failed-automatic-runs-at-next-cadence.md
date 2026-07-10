# Retry blocked and failed automatic runs at the next cadence

When an automatic Agent Run is blocked or fails, AgentScheduler will record that occurrence and compute the next due time from the Run Cadence instead of leaving the prior due time eligible for every Wakeup Trigger scan. We chose cadence-bounded retries over immediate repeated attempts because configuration and harness failures often need user intervention, while repeated scans would create noisy Run History and retry storms.
