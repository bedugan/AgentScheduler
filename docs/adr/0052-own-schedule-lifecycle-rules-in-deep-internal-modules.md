# Own Schedule Lifecycle rules in deep internal modules

`ScheduleLifecycle` remains AgentScheduler's external orchestration seam, but it will delegate cohesive policy to deep internal modules. `ScheduleDefinition` owns creation, revision, activation requirements, and lifecycle transitions. `ScheduleFile` owns portable import and export. `RecurrencePolicy` owns cron evaluation. `RecurrenceReducer` owns run-cap and next-run state reduction. `RunCoordinator` owns Agent Run reservation, preflight, execution, reconciliation, cancellation, and result persistence. `ScheduleProjection` owns Schedule Detail and Run History Detail views.

These are concrete internal owners, not extension ports. They accept the dependencies they actually use and expose narrow interfaces to `ScheduleLifecycle`; no hypothetical adapter layer or compatibility wrapper is introduced. Tests continue to exercise behavior through the existing `ScheduleLifecycle` and `ScheduleStore` seams.

Store operations that protect concurrency invariants remain atomic at the `ScheduleStore` seam. New and imported definitions use create-only writes; edits and lifecycle transitions use expected-revision and expected-operational-state compare-and-save writes; deletion checks for an active Agent Run and removes an idle schedule in one transaction. Active-run reservation, run-result commit, execution heartbeat, expired-execution claim, and cancellation request likewise make their guard and write indivisible. The in-memory and SQLite adapters preserve the same observable contract.

We chose these owners because deleting one would force its policy back into the lifecycle facade or across multiple callers. The split makes policy local without changing the public lifecycle interface or the persisted domain model.
