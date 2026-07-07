# Keep the scheduler domain-agnostic

AgentScheduler will schedule agent runs and delegate agent-specific safeguards to the selected agent harness. We chose this boundary because scheduled runs may target more than code workspaces, and checks such as dirty worktrees, model authentication, approvals, network access, and context validity differ by harness.
