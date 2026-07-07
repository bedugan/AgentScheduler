# Treat approval needed as an active run state

AgentScheduler will treat approval-needed situations as an active run state when the harness has already started and is waiting for approval. The run keeps occupying its run slot until approval resolves, times out, or the user cancels it; if approval cannot be surfaced at all, harness preflight should block the run before it starts.
