# Support manual Run now for schedules

AgentScheduler will let users manually start a schedule from the schedule detail. A manual run bypasses only the time-based due check and still uses the current schedule revision, run slot concurrency, harness preflight, approval mode, run caps, and execution policy so users can test schedules without creating a separate execution path.
