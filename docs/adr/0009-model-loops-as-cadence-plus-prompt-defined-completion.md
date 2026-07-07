# Model loops as cadence plus prompt-defined completion

AgentScheduler will model loops as a run cadence plus completion conditions. Cron syntax will represent the run cadence when the cadence can be expressed by cron; scheduler-native conditions such as "run X times" will be enforced by AgentScheduler as run caps; domain-specific stop conditions such as tests passing, no new findings, or issue closure stay in the prompt and are interpreted by the selected agent harness.
