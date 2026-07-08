# Record executed model in run history

Run History will store the scheduled model selector and, when the harness reports it, the executed model that actually handled the Agent Run. The scheduled model remains the user's chosen configuration, such as Auto; the executed model is historical audit data for a specific run.

We chose this because Auto model selection is useful for schedule setup, but backend model capabilities can vary across runs. Users need Previous Runs and Run History Detail to show which model executed a past run when that information is available, while still showing Unknown when a harness cannot report it reliably.
