# Align visible execution policy with the selected harness

AgentScheduler will keep a provider-neutral execution policy model internally, but the schedule detail will present harness-native policy controls for the selected harness. For the Copilot harness in VS Code, that means using the visible approval modes Default Approvals, Bypass Approvals, and Autopilot; advanced local CLI mappings can still resolve to Copilot CLI concepts such as available or excluded tools, allow or deny tool permissions, permissive modes, and local sandbox settings.
