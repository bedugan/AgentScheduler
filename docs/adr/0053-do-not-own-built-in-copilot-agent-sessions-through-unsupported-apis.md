# Do not own built-in Copilot Agent sessions through unsupported APIs

AgentScheduler will not replace its managed VS Code Task/Copilot CLI Approval Surface with the built-in Copilot Agent UI until stable public VS Code interfaces expose the lifecycle required by the Harness Contract: start with selected configuration, observe status, persist execution identity, cancel, and reopen or review the run.

The supported VS Code Language Model interface can enumerate Copilot models and send model requests, while Chat Participants and Language Model Tools can extend chat. Those interfaces do not let an extension create and own a built-in Copilot Agent session with its approval and tool lifecycle. The installed Copilot extension uses proposed agent-session interfaces internally and does not export a stable extension interface for this purpose. Internal command identifiers, undocumented extension exports, and proposed interfaces are therefore not production dependencies.

Manual Local Copilot runs using Default Approvals continue to use the visible VS Code Task terminal as the managed fallback. Schedule Detail must identify that Approval Surface before a run starts. A future built-in adapter may replace the fallback only after the public interface can satisfy the Harness Contract and its availability, cancellation, fallback, and execution-identity behavior can be tested. A UI-only prompt handoff is not treated as an Agent Run because AgentScheduler cannot honestly report or manage its lifecycle.

References:

- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [VS Code AI extensibility overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)
- [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
