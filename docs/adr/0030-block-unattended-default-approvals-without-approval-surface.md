# Block unattended Default Approvals without an approval surface

When a due run uses Default Approvals and no approval surface is available, the harness preflight will block the run before start with a meaningful reason. We chose this because starting an unattended run that immediately waits for an invisible approval would occupy its run slot and make the schedule appear stuck.
