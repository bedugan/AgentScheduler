# Persist Local Run Execution leases

AgentScheduler will persist Local Run Execution state separately from Run History. Each started local process or VS Code Task records an execution identity, process-owner identity, capability snapshot, heartbeat time, and two-minute lease expiry linked to its Run History entry. Active executions renew the lease every thirty seconds. Adapters that cannot heartbeat receive a bounded 24-hour compatibility lease instead of an immortal reservation. Worker scans reconcile expired leases before checking whether Local Scheduling is enabled, and legacy active rows without an execution identity receive the same bounded grace period before failing with a recovery explanation.

Cancellation is enabled only when the persisted execution says it is cancelable and the requesting lifecycle still owns that execution. Other active runs show cancellation as unsupported instead of attempting cross-process PID or Task cancellation. Terminal execution records remain available as identity and capability snapshots for Run History Detail.

The VS Code control surface polls SQLite `PRAGMA data_version` and refreshes open Schedule Detail, Run History Detail, and Schedule List state after another connection changes the store.

We chose a separate execution record because Run History is an audit snapshot while leases are mutable liveness state. Owner-scoped capabilities avoid unsafe cancellation after process restart, and SQLite data-version polling gives the editor a low-cost cross-process invalidation signal without coupling the worker to VS Code.
