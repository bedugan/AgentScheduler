# Implement MVP worker as Node TypeScript CLI

AgentScheduler will implement the MVP local worker as a Node/TypeScript CLI bundled with or installed alongside the VS Code extension. We chose this because the extension is already TypeScript, harness integrations are process-oriented, and the contracts are still evolving; the worker entrypoint must remain small enough to preserve the sub-50 ms idle path, and a native binary can be revisited if startup or distribution becomes a bottleneck.
