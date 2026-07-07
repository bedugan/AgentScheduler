# Use SQLite for local store and support schedule export

AgentScheduler will use a per-user SQLite local store for the schedule registry and run history. We chose SQLite for fast indexed due scans, transactions, locking, and queryable history; schedules, configuration, and inline run instructions must also be exportable in a portable format so important automation definitions are not trapped in an opaque database.
