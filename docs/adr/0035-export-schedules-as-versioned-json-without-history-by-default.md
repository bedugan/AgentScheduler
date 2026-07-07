# Export schedules as versioned JSON without history by default

AgentScheduler will export schedules as human-readable JSON with a schema version. The default export includes schedule definitions, harness configuration references, approval modes, cadence, caps, context references, and inline run instructions, but excludes run history because history can contain sensitive outputs and large artifacts.
