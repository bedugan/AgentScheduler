# Use VS Code Tasks for manual Local Copilot Default Approvals

Manual Local Copilot runs using Default Approvals will execute `copilot -i` in a dedicated VS Code Task terminal. The visible interactive terminal is the Approval Surface: users can review and answer Copilot permission prompts while the extension waits for the task process to finish. Background worker runs remain non-interactive and must block during preflight when Default Approvals would require that surface.

Local Copilot model choices are owned by the harness rather than VS Code's chat-language-model catalog. Auto remains the backward-compatible default. The harness discovers explicit Scheduled Model identifiers from the installed Copilot CLI configuration help and validates them during preflight, so unrelated VS Code language-model identifiers never enter Copilot CLI arguments. A Copilot Agent Profile is a separate optional selector and maps to the CLI `--agent` option; it is not a model alias.

We chose this because Default Approvals is the safe default but cannot work through the existing non-interactive CLI process. VS Code Tasks provide an explicit, user-visible terminal without weakening unattended policy, and a harness-owned model catalog prevents editor API identifiers from leaking into Copilot CLI arguments.

This decision was refined after smoke testing showed that Auto alone could select an unnecessarily expensive model for simple work. Explicit backend-valid choices preserve the original identifier isolation while giving users cost and capability control.
