# Store inline run instructions for MVP

AgentScheduler will store inline run instructions directly in each schedule for the MVP, while leaving room for external prompt-file instruction sources later. We chose this because inline instructions make the Codex-like schedule detail self-contained and avoid early complexity around missing files, file watching, prompt versioning, and reconstructing which prompt text ran.
