# Restart completed schedules explicitly

Completed schedules will be restartable through an explicit Restart action that resets scheduler-native counters and computes future due times from the current schedule revision. We chose this over silent resumption because Completed means the loop reached its defined stopping point, while old run history should remain intact for audit and review.
