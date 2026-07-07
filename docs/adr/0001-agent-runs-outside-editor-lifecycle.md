# Agent runs run outside the editor lifecycle

AgentScheduler will treat VS Code as the editor control surface and start due agent runs from a local worker that can run while VS Code is closed. We chose this over an extension-only scheduler because the core experience is asynchronous scheduled execution, and extension-host timers would make runs depend on editor uptime.
