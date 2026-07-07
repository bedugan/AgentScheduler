# Build the Copilot harness first behind a provider-neutral contract

AgentScheduler will build a Copilot harness first because the target product surface is VS Code and GitHub Copilot agents. The scheduler core will depend only on a provider-neutral harness contract so Claude, Codex, or other agent harnesses can support their own setup, models, session lifecycle, and safeguards later.
