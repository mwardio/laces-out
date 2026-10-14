# Weekly projection retention

The worker's `projection-retention` queue runs hourly at minute 17 UTC. Deploy the API
(schedule producer) and worker (consumer and recommendation writer) together to enable it.
No database migration is required.

Only automatic, league-visible, explicit weekly `laces-out-first-party` projection sets
are eligible. A set is removed only when **all** of the following hold:

- Both creation and source-fetch timestamps are more than seven days old.
- It is outside the newest 100 sets for its league season and scoring profile, ordered
  by creation time and ID, preserving the browser's bounded forecast history.
- It is outside the newest 32 sets for its league season, target week, and scoring profile,
  ordered by source-fetch time, creation time, and ID, preserving decision-reader candidates
  even when the latest publication for a week is old.
- No saved `recommendation_runs.inputs.projectionSetIds` array references it.

User imports, global forecasts, ROS forecasts and summaries, model runs, raw observations,
and filesystem validation evidence are not pruned. Pinned recommendation inputs and the
per-target exceptions can outlive seven days; this is a rolling-history policy, not a hard
database byte cap. Other append-only datasets can still grow.

Each job deletes at most 500 sets in transactions of 25, cascading to their player projection
rows. Lock and statement timeouts bound each batch. An advisory lock serializes cleanup with
recommendation persistence; a recommendation computed from an already removed set fails
and retries from a fresh snapshot instead of saving a dangling reference. Deploy the updated
recommendation writer before manually applying cleanup; older writers do not take this lock.

Inspect candidates without changing data:

```sh
npm run projections:prune -w @laces-out/worker
```

Apply one bounded sweep using the same policy as the scheduled job:

```sh
npm run projections:prune -w @laces-out/worker -- --apply
```

In a built worker container, use `node apps/worker/dist/prune-projection-history.js`
with the optional `--apply` argument. Each command reports the candidate count before the
sweep and the number of sets removed. Worker logs report `projection retention completed`.

Deletion makes space reusable inside PostgreSQL after vacuuming; it does not promise an
immediate reduction in Docker volume size. The job never runs `VACUUM FULL`, which would
rewrite and exclusively lock the table. Reclaiming existing allocated disk space is a
separate maintenance operation.
