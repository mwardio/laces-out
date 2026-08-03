/**
 * Source-specific match-rate thresholds.
 *
 * A match-rate threshold must exist *before* derived analysis publishes. That threshold initially
 * shipped as a bare `minimumPublishableMatchRate = 0.95` duplicated in
 * `apps/worker/src/nflverse-weekly-data.ts` and `apps/worker/src/ffc-adp.ts`. This module is that
 * same threshold lifted into one registry so the number has one home, a written rationale, and a
 * per-source override where the identity cross-walk genuinely differs. It is not a second,
 * competing threshold — both worker ingestions now resolve their number from here.
 *
 * Not to be confused with `apps/worker/src/ros-data-coverage.ts` `DEFAULT_THRESHOLDS`
 * (`minimumRosterMatchRate`, `minimumSnapMatchRate`). Those measure *dataset overlap* between weekly
 * stats and rosters/snaps when assembling held-out shadow batches. They say nothing about whether an
 * external identifier resolved to a canonical player, and the two families must never be unified.
 */

export interface SourceMatchRateThreshold {
  /** Minimum resolved fraction before a dataset may publish derived analysis. */
  readonly minimumMatchRate: number;
  /** Why this source carries this number, for the surface and for review. */
  readonly rationale: string;
}

/**
 * The value already in production for every source. A dataset that resolves fewer than 95% of its
 * rows to a canonical player is quarantined rather than published.
 */
export const DEFAULT_SOURCE_MATCH_RATE = 0.95;

/**
 * Snap counts are keyed by Pro Football Reference identifiers
 * (`player_snap_counts_external_id_check`, `^[A-Za-z0-9.-]{1,20}$`), not by the GSIS identifiers
 * every other nflverse observation table uses. The PFR cross-walk is structurally lossier: it is a
 * second-hop join through `player_external_ids` rather than the catalog's native key, so a rookie or
 * a mid-season practice-squad elevation can be unresolved in snaps while resolving cleanly in stats.
 * 0.90 gives that hop headroom without letting a genuinely broken ingestion publish.
 *
 * Evidenced, not asserted. Live rates on 2026-07-27, from the production `data_sources` metadata:
 *
 * ```bash
 * docker compose exec -T postgres psql -U fantasy -d fantasy -c \
 *   "select key, metadata->>'matchRate' as match_rate, metadata->>'publishable' as publishable \
 *    from data_sources where key like 'nflverse.snap-counts.%' order by key;"
 * ```
 *
 * | key                       | matchRate | publishable |
 * | ------------------------- | --------- | ----------- |
 * | nflverse.snap-counts.2023 | 0.99947   | true        |
 * | nflverse.snap-counts.2024 | 0.99842   | true        |
 * | nflverse.snap-counts.2025 | 0.99790   | true        |
 * | nflverse.snap-counts.2026 | (not yet refreshed) | —   |
 *
 * Every live season is far above 0.95, so lowering the snap threshold to 0.90 admits **nothing**
 * that is quarantined today; it is inert against current data and exists as documented tolerance for
 * PFR cross-walk drift. Re-run the query above before changing this number.
 */
const SNAP_COUNT_MATCH_RATE = 0.9;

/** Kept under 300 characters so it fits the wire contract's `thresholdRationale` bound. */
const SNAP_COUNT_RATIONALE =
  "Snap counts are PFR-keyed, not GSIS-keyed, so they resolve through a second-hop cross-walk that is structurally lossier than the other nflverse datasets. Live seasons run above 0.997, so 0.90 is documented tolerance for cross-walk drift rather than a loosening.";

/**
 * Ordered prefix table. Matching on the stable key prefix means a new season needs no registry
 * entry — the per-season suffix (`.2026`) and the FFC scoring/team suffixes are not part of the
 * identity of the threshold. Order matters only if one prefix is a prefix of another; none is
 * today, and the first match wins.
 */
const SOURCE_MATCH_RATE_THRESHOLDS: readonly (readonly [string, SourceMatchRateThreshold])[] = [
  [
    "nflverse.stats-player-week.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "GSIS-keyed weekly player stats resolve against the canonical catalog directly; below 95% the catalog is stale rather than the feed being noisy.",
    },
  ],
  [
    "nflverse.stats-team-week.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "Team weekly stats resolve against the fixed 32-team table, so anything unresolved is a real defect.",
    },
  ],
  [
    "nflverse.weekly-rosters.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "Weekly rosters resolve GSIS identifiers against the canonical catalog, measured over the model-eligible denominator so bench specialists do not depress the rate.",
    },
  ],
  [
    "nflverse.snap-counts.",
    { minimumMatchRate: SNAP_COUNT_MATCH_RATE, rationale: SNAP_COUNT_RATIONALE },
  ],
  [
    "nflverse.injuries.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "GSIS-keyed injury reports resolve against the canonical catalog directly; below 95% the status-aware evaluation is reading a stale roster.",
    },
  ],
  [
    "nflverse.schedules.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "Schedules carry no player identity, so the default applies vacuously and no source may publish ungated.",
    },
  ],
  [
    "ffc.adp.",
    {
      minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
      rationale:
        "ADP rows are matched by name and team rather than by a stable identifier, so a falling rate means the draft board is drifting from the catalog.",
    },
  ],
];

const UNREGISTERED_THRESHOLD: SourceMatchRateThreshold = {
  minimumMatchRate: DEFAULT_SOURCE_MATCH_RATE,
  rationale:
    "This source has no source-specific threshold, so the default applies rather than leaving it ungated.",
};

/**
 * Resolve the match-rate threshold for a `data_sources.key`. Never throws and never returns `null`:
 * a missing registry entry must not be able to let a source publish without a gate.
 */
export function sourceMatchRateThreshold(sourceKey: string): SourceMatchRateThreshold {
  for (const [prefix, threshold] of SOURCE_MATCH_RATE_THRESHOLDS) {
    if (sourceKey.startsWith(prefix)) return threshold;
  }
  return UNREGISTERED_THRESHOLD;
}

/** Only ingestion-recorded season metadata can classify an artifact as completed history. */
export function sourceSeason(metadata: Readonly<Record<string, unknown>>): number | null {
  const season = metadata.season;
  return typeof season === "number" && Number.isInteger(season) && season >= 1999 && season <= 2200
    ? season
    : null;
}

/** Completed nflverse seasons are immutable model artifacts, not live freshness dependencies. */
export function isArchivedNflverseSource(
  sourceKey: string,
  metadata: Readonly<Record<string, unknown>>,
  activeSeason: number,
): boolean {
  const season = sourceSeason(metadata);
  return sourceKey.startsWith("nflverse.") && season !== null && season < activeSeason;
}

/**
 * An admitted completed-season artifact may be reused indefinitely. A parser/schema release or an
 * explicit operator refresh is what reopens it, not the passage of wall-clock time.
 */
export function isReusableArchivedSourceArtifact(input: {
  readonly sourceKey: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lastChecksum: string | null;
  readonly activeSeason: number;
  readonly sourceSchemaVersion: number;
}): boolean {
  return (
    isArchivedNflverseSource(input.sourceKey, input.metadata, input.activeSeason) &&
    input.lastChecksum !== null &&
    input.metadata.sourceSchemaVersion === input.sourceSchemaVersion &&
    input.metadata.availability === "available" &&
    input.metadata.publishable !== false
  );
}
