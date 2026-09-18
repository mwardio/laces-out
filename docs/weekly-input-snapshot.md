# Weekly projection input consistency

Weekly refreshes capture source admission, immutable observations, and mutable catalog and league
facts in one short PostgreSQL repeatable-read transaction. Canonical D/ST identities may be
created in that transaction. It closes before training, interval replay, and league publication
planning.

The publication fingerprint includes the semantic mutable-input checksum and the actual resolved
positions of historical weekly and snap observations. The training cache also includes those
historical positions. An effective current WR role therefore cannot hide a changed catalog
fallback used by an earlier game. Both publication and training fingerprints also include the
explicit player-history assembly version, so corrected assembly rules invalidate old artifacts
even when upstream source bytes remain unchanged.

Every production publication records a `weekly-coherent-inputs-v1` snapshot in its model-run
configuration and projection-set metadata. Its source manifest includes selected required and
optional sources, their immutable checksums and audit timestamps, and absent optional keys.
Successful checks of unchanged source bytes do not change the semantic identity. Mutable-input
identity excludes update timestamps and equivalent roster snapshot replacements.

Before any publication writes, a separate transaction:

1. Starts an eight-second monotonic publication budget and sets local `statement_timeout` to two seconds.
2. Takes `SHARE NOWAIT` locks, in a fixed order, on `data_sources`, `fantasy_teams`,
   `league_seasons`, `player_external_ids`, `player_source_observations`, `players`,
   `roster_entries`, `roster_snapshots`, and `scoring_rules`.
3. Revalidates source health and admission across the full required/optional universe, then
   compares the captured source and mutable-input identities.
4. Persists the prepared output only if both identities still match.

The table locks cover inserted rows as well as updates, including a previously absent optional
source. They briefly delay unrelated catalog or league writes; this is the deliberate cost of
covering existing writers without requiring a new global revision protocol. Acquisition never
waits while holding earlier locks. No training, league planning, or external waits run under these
locks. Budget checks surround every awaited query. Database work can extend the eight-second
budget by at most one two-second statement before rollback; application suspension is not a
server-enforced idle-time bound. Commit or rollback releases the locks. This deliberately avoids
PostgreSQL's backend-killing transaction timeout, which exposed a connection-reuse failure in
postgres-js 3.4.9 during a real timeout regression.

Changed inputs or contention discard the attempt with `PROJECTION_INPUT_EPOCH_CHANGED` and keep
ordinary queue retry active. A statement timeout or expired publication budget also rolls back
and fails the attempt; statement cancellation preserves the pooled connection. Previously committed good forecasts stay
available. If an earlier week committed before a later week encountered drift, diagnostics retain
the actual committed-week count and retry evaluates the replacement inputs.

The same locked validation protects the unchanged-output shortcut. These changes affect live
weekly input identity and publication consistency. They do not change physical projection math,
point or interval policies, or historical ROS model versions. The accompanying history-assembly
correction preserves zero touchdown counts across positions only for already observed no-stat
appearances and completed rostered DNPs. It does not fill unknown event fields in aggregate source
rows. Corrected assembled facts and the explicit player-history version deliberately invalidate
affected training and historical corpus identities; this is distinct from changing model math.

Focused tests cover optional-source drift, health-only rejection, timestamp-only changes,
historical role identity, repeatable-read consistency, lock acquisition/release, inserted-source
exclusion, transaction rollback, and PostgreSQL cancellation/connection-reuse behavior.
