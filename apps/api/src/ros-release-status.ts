import {
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
  rosScoringProfileCatalog,
} from "@fantasy/projections";

/**
 * Pure derivations behind `GET /v1/projections/ros-status`.
 *
 * Each function produces exactly one of the six independent facts in `RosReleaseStatus` and reads
 * only the inputs that fact depends on. In particular `deriveShadowAudit` is never consulted by any
 * other derivation: the shadow rail records deliberately degraded diagnostics, and treating it as
 * evidence about the admitted artifact is the specific mistake this module exists to prevent.
 *
 * The canonical wire contract lives in `packages/contracts/src/ros-release-status.ts`. That module
 * is not re-exported from the contracts barrel yet (the barrel is owned elsewhere this wave), so the
 * shapes below are declared locally and kept byte-identical in name and order. `ROS_WITHHOLDING_REASONS`
 * is pinned by a test against the contract's own list so the two cannot drift; once the barrel line
 * lands, these declarations are replaced by imports and nothing else changes.
 */

/**
 * Structured reasons a league's rest-of-season set is withheld. Order is fixed and load bearing:
 * a rendered reason list must be stable between requests.
 */
export const ROS_WITHHOLDING_REASONS = [
  "scoring-rules-unsupported",
  "no-admitted-scoring-profile",
  "incomplete-schedule",
  "missing-roster-snapshot",
  "insufficient-candidate-inputs",
  "non-converged-cell",
  "stale-source",
  "no-league-synced",
] as const;

export type RosWithholdingReason = (typeof ROS_WITHHOLDING_REASONS)[number];

export interface RosScoringProfileIdentity {
  readonly profileId: string;
  readonly label: string;
  readonly scoringProfileKey: string;
  readonly digest: string;
}

export interface RosAdmittedArtifact {
  readonly scoringProfile: RosScoringProfileIdentity;
  readonly season: number;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly artifactChecksum: string;
  readonly admittedAt: string;
  readonly sourceChecksumCount: number;
}

export interface RosAdmittedArtifactState {
  readonly state: "admitted" | "none";
  readonly artifacts: readonly RosAdmittedArtifact[];
}

export interface RosUnsupportedScoringProfile {
  readonly profile: RosScoringProfileIdentity;
  readonly blockers: readonly string[];
  readonly evidenceReport: string | null;
}

export interface RosScoringProfileCoverage {
  readonly supported: readonly RosScoringProfileIdentity[];
  readonly unsupported: readonly RosUnsupportedScoringProfile[];
}

export type RosCellPosition = "QB" | "RB" | "WR" | "TE" | "K" | "DST";
export type RosCellBucket = "one-to-four" | "five-to-eight" | "nine-plus";

/** Every position `normalizeLeagueScoringProfile` and this surface reason about, fixed order. */
export const ROS_LEAGUE_POSITIONS: readonly RosCellPosition[] = [
  "QB",
  "RB",
  "WR",
  "TE",
  "K",
  "DST",
];

/**
 * Position-scoped readiness within one league, mirroring `RosCellGateDecision`'s vocabulary.
 * `reasons` distinguishes two causes: `position-unsupported` is followed by the normalization
 * messages that made this position unscoreable; `scoring-profile-position-mismatch` means the
 * position normalizes fine but its scoped rules do not equal any admitted artifact's scoped rules.
 * Reported for all six positions on every league, D/ST included: this states normalization and
 * catalog-match truth for a position, not whether the ROS rail currently ships that position's
 * forecasts (today only QB/RB/WR/TE/K).
 */
export interface RosLeaguePositionReadiness {
  readonly position: RosCellPosition;
  readonly decision: "ready" | "withheld";
  readonly reasons: readonly string[];
}

export interface RosLeagueReadiness {
  readonly leagueSeasonId: string | null;
  /** The league's own name, so the UI can say "Garagely" rather than a truncated UUID. */
  readonly leagueName: string | null;
  readonly state: "ready" | "withheld";
  readonly reasons: readonly RosWithholdingReason[];
  readonly scoringProfile: RosScoringProfileIdentity | null;
  readonly positions: readonly RosLeaguePositionReadiness[];
}

export interface RosCellGateDecision {
  readonly position: RosCellPosition;
  readonly bucket: RosCellBucket;
  readonly decision: "released" | "withheld";
  readonly reasons: readonly string[];
}

export interface RosCellGateState {
  readonly state: "evaluated" | "none";
  readonly evaluatedAt: string | null;
  readonly cells: readonly RosCellGateDecision[];
}

export interface RosPublishedLeagueSet {
  readonly projectionSetId: string;
  readonly leagueSeasonId: string;
  readonly leagueName: string | null;
  readonly scoringProfile: RosScoringProfileIdentity | null;
  readonly season: number;
  readonly playerCount: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly fetchedAt: string;
  readonly inputChecksum: string;
  readonly championArtifactChecksum: string | null;
  readonly retainedFromEarlierRun: boolean;
}

export interface RosShadowAuditRunSummary {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly createdAt: string;
  readonly reasons: readonly string[];
}

export interface RosShadowAuditState {
  readonly state: "recorded" | "none";
  readonly latestRun: RosShadowAuditRunSummary | null;
}

/**
 * The complete status. There is intentionally no top-level verdict field; a caller that needs one
 * must decide which of the six facts it actually cares about.
 */
export interface RosReleaseStatus {
  readonly season: number;
  readonly modelVersion: string;
  readonly admittedArtifacts: RosAdmittedArtifactState;
  readonly scoringProfiles: RosScoringProfileCoverage;
  readonly leagueReadiness: readonly RosLeagueReadiness[];
  readonly cellGates: RosCellGateState;
  readonly publishedSets: readonly RosPublishedLeagueSet[];
  readonly shadowAudit: RosShadowAuditState;
}

/** Beyond this age a league's newest source observation is reported stale rather than used. */
const STALE_SOURCE_HOURS = 36;
/**
 * Below this many candidate inputs a league has nothing to forecast for. This read only detects the
 * empty case; per-player candidate sufficiency is decided by the worker at publication time against
 * the admitted evidence, and is not re-litigated here.
 */
const MINIMUM_CANDIDATE_INPUTS = 1;

const PROFILE_BY_KEY = new Map<string, RosScoringProfileIdentity>(
  rosScoringProfileCatalog().map((entry) => [
    entry.scoringProfileKey,
    {
      profileId: entry.profile.id,
      label: entry.label,
      scoringProfileKey: entry.scoringProfileKey,
      digest: entry.digest,
    },
  ]),
);

/**
 * Resolves a stored scoring key to a named catalog profile. An unrecognized key returns null rather
 * than a nearest match — a league must never be told it has a profile it does not have.
 */
export function rosScoringProfileIdentityForKey(key: string): RosScoringProfileIdentity | null {
  return PROFILE_BY_KEY.get(key) ?? null;
}

/** Per-position normalization support carried forward from `normalizeLeagueScoringProfile`. */
export interface RosLeaguePositionSupport {
  readonly position: RosCellPosition;
  readonly supported: boolean;
  /** Normalization reason MESSAGES (not codes), empty iff `supported`. */
  readonly reasons: readonly string[];
}

export interface RosLeagueInputRow {
  readonly leagueSeasonId: string;
  readonly leagueName: string | null;
  readonly scoringProfileKey: string | null;
  /** Always all six of `ROS_LEAGUE_POSITIONS`, mirroring `normalizeLeagueScoringProfile`. */
  readonly positions: readonly RosLeaguePositionSupport[];
  readonly scheduleComplete: boolean;
  readonly rosterSnapshotAt: Date | null;
  readonly candidateInputCount: number;
  readonly sourceAsOf: Date | null;
  readonly nonConvergedCells: number;
}

/**
 * Recovers a position-scoped canonical key from a whole-profile canonical key (itself the JSON
 * `projectionScoringProfileKey` emits). Returns null instead of throwing on a malformed key: this
 * read must never crash the status surface, and a key that cannot be recovered can never match
 * anything, so it fails closed by omission rather than by exception.
 */
function safePositionKey(wholeProfileKey: string, position: RosCellPosition): string | null {
  try {
    const rules = projectionScoringRulesFromProfileKey(wholeProfileKey);
    return projectionScoringProfileKeyForPosition({ id: "ros-position-key", rules }, position);
  } catch {
    return null;
  }
}

/** Position-scoped keys every admitted artifact matches at `position`, deduplicated. */
function admittedPositionKeys(
  admittedScoringProfileKeys: readonly string[],
  position: RosCellPosition,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const wholeProfileKey of admittedScoringProfileKeys) {
    const key = safePositionKey(wholeProfileKey, position);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * Position-scoped readiness for one league. A position `normalizeLeagueScoringProfile` could not
 * support is withheld with the normalization messages; a supported position is withheld instead
 * with `scoring-profile-position-mismatch` unless its own position-scoped key equals an admitted
 * artifact's position-scoped key at that same position.
 */
function derivePositionReadiness(
  league: RosLeagueInputRow,
  admittedPositionKeysByPosition: ReadonlyMap<RosCellPosition, ReadonlySet<string>>,
): readonly RosLeaguePositionReadiness[] {
  return league.positions.map((support): RosLeaguePositionReadiness => {
    if (!support.supported) {
      return {
        position: support.position,
        decision: "withheld",
        // `support.reasons` carries one normalization message per failing rule row and is
        // otherwise unbounded (a league can define thousands of rule rows). Clamp to the wire
        // contract's `rosLeaguePositionReadinessSchema.reasons` cap (`.max(32)`,
        // `packages/contracts/src/ros-release-status.ts`) so a rule-heavy league still parses
        // instead of blanking the whole status payload.
        reasons: ["position-unsupported", ...support.reasons].slice(0, 32),
      };
    }
    const leagueKey =
      league.scoringProfileKey === null
        ? null
        : safePositionKey(league.scoringProfileKey, support.position);
    const admitted = admittedPositionKeysByPosition.get(support.position);
    if (leagueKey !== null && admitted?.has(leagueKey)) {
      return { position: support.position, decision: "ready", reasons: [] };
    }
    return {
      position: support.position,
      decision: "withheld",
      reasons: ["scoring-profile-position-mismatch"],
    };
  });
}

/**
 * 3. League input readiness. Every unmet input is reported, not just the first, and always in the
 * fixed `ROS_WITHHOLDING_REASONS` order so a rendered list is stable between requests.
 */
export function deriveLeagueReadiness(input: {
  readonly admittedScoringProfileKeys: readonly string[];
  readonly leagues: readonly RosLeagueInputRow[];
  readonly now: Date;
}): readonly RosLeagueReadiness[] {
  if (input.leagues.length === 0) {
    return [
      {
        leagueSeasonId: null,
        leagueName: null,
        state: "withheld",
        reasons: ["no-league-synced"],
        scoringProfile: null,
        positions: [],
      },
    ];
  }

  const admitted = new Set(input.admittedScoringProfileKeys);
  const staleBefore = input.now.getTime() - STALE_SOURCE_HOURS * 60 * 60 * 1_000;
  const admittedPositionKeysByPosition = new Map(
    ROS_LEAGUE_POSITIONS.map(
      (position) =>
        [position, admittedPositionKeys(input.admittedScoringProfileKeys, position)] as const,
    ),
  );

  return input.leagues.map((league) => {
    const reasons = new Set<RosWithholdingReason>();
    if (league.scoringProfileKey === null) {
      // Zero positions supported: normalization itself failed, which is a different fact from
      // "normalizes, but no admitted artifact matches" below.
      reasons.add("scoring-rules-unsupported");
    } else if (!admitted.has(league.scoringProfileKey)) {
      reasons.add("no-admitted-scoring-profile");
    }
    if (!league.scheduleComplete) reasons.add("incomplete-schedule");
    if (league.rosterSnapshotAt === null) reasons.add("missing-roster-snapshot");
    if (league.candidateInputCount < MINIMUM_CANDIDATE_INPUTS) {
      reasons.add("insufficient-candidate-inputs");
    }
    if (league.nonConvergedCells > 0) reasons.add("non-converged-cell");
    if (league.sourceAsOf === null || league.sourceAsOf.getTime() < staleBefore) {
      reasons.add("stale-source");
    }

    const ordered = ROS_WITHHOLDING_REASONS.filter((reason) => reasons.has(reason));
    return {
      leagueSeasonId: league.leagueSeasonId,
      leagueName: league.leagueName,
      state: ordered.length === 0 ? "ready" : "withheld",
      reasons: ordered,
      scoringProfile:
        league.scoringProfileKey === null
          ? null
          : rosScoringProfileIdentityForKey(league.scoringProfileKey),
      positions: derivePositionReadiness(league, admittedPositionKeysByPosition),
    };
  });
}

export interface RosShadowAuditRow {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly createdAt: Date;
  readonly reasons: readonly string[];
}

/** 6. The independent shadow audit. Nothing else in this module reads its result. */
export function deriveShadowAudit(row: RosShadowAuditRow | null): RosShadowAuditState {
  if (row === null) return { state: "none", latestRun: null };
  return {
    state: "recorded",
    latestRun: {
      sourceSyncRunId: row.sourceSyncRunId,
      mode: row.mode,
      qualityState: row.qualityState,
      createdAt: row.createdAt.toISOString(),
      reasons: [...row.reasons].slice(0, 32),
    },
  };
}

export interface RosAdmittedArtifactRow {
  readonly season: number;
  readonly scoringProfileKey: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly artifactChecksum: string;
  readonly admittedAt: Date;
  readonly sourceChecksumCount: number;
}

/** 1. Admitted artifact state. Latest admission wins within one scoring profile. */
export function deriveAdmittedArtifacts(
  rows: readonly RosAdmittedArtifactRow[],
): RosAdmittedArtifactState {
  const latest = new Map<string, RosAdmittedArtifactRow>();
  for (const row of rows) {
    const existing = latest.get(row.scoringProfileKey);
    if (!existing || existing.admittedAt.getTime() < row.admittedAt.getTime()) {
      latest.set(row.scoringProfileKey, row);
    }
  }

  const artifacts = [...latest.values()]
    .sort((left, right) => right.admittedAt.getTime() - left.admittedAt.getTime())
    .slice(0, 8)
    .flatMap((row) => {
      const profile = rosScoringProfileIdentityForKey(row.scoringProfileKey);
      // An artifact admitted under a profile the running catalog no longer names cannot be
      // described honestly, so it is omitted rather than mislabelled.
      if (!profile) return [];
      return [
        {
          scoringProfile: profile,
          season: row.season,
          modelVersion: row.modelVersion,
          policyVersion: row.policyVersion,
          calibrationVersion: row.calibrationVersion,
          evidenceThroughSeason: row.evidenceThroughSeason,
          artifactChecksum: row.artifactChecksum,
          admittedAt: row.admittedAt.toISOString(),
          sourceChecksumCount: row.sourceChecksumCount,
        },
      ];
    });

  return { state: artifacts.length === 0 ? "none" : "admitted", artifacts };
}

/**
 * 2. Supported scoring-profile identity. Every catalog profile without an admitted artifact is
 * listed as unsupported with the reason, so an absent profile is visible rather than silent.
 */
export function deriveScoringProfileCoverage(
  admitted: RosAdmittedArtifactState,
  evidenceReports: Readonly<Record<string, string | undefined>> = {},
): RosScoringProfileCoverage {
  const admittedKeys = new Set(
    admitted.artifacts.map((artifact) => artifact.scoringProfile.scoringProfileKey),
  );
  const supported: RosScoringProfileIdentity[] = [];
  const unsupported: RosUnsupportedScoringProfile[] = [];

  for (const entry of rosScoringProfileCatalog()) {
    const profile = rosScoringProfileIdentityForKey(entry.scoringProfileKey);
    if (!profile) continue;
    if (admittedKeys.has(entry.scoringProfileKey)) {
      supported.push(profile);
    } else {
      unsupported.push({
        profile,
        blockers: ["no_admitted_artifact"],
        evidenceReport: evidenceReports[entry.key] ?? null,
      });
    }
  }

  return { supported, unsupported };
}

export interface RosCellDecisionRow {
  readonly position: string;
  readonly bucket: string;
  readonly state: string;
  readonly reasons: readonly string[];
}

const CELL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const CELL_BUCKETS = new Set(["one-to-four", "five-to-eight", "nine-plus"]);

/** 4. Live per-cell gate decisions, released and withheld alike. */
export function deriveCellGates(
  run: { readonly createdAt: Date; readonly cellDecisions: readonly RosCellDecisionRow[] } | null,
): RosCellGateState {
  const cells = (run?.cellDecisions ?? []).flatMap((decision) => {
    if (!CELL_POSITIONS.has(decision.position) || !CELL_BUCKETS.has(decision.bucket)) return [];
    return [
      {
        position: decision.position as RosCellPosition,
        bucket: decision.bucket as RosCellBucket,
        decision: decision.state === "release" ? ("released" as const) : ("withheld" as const),
        reasons: [...decision.reasons].slice(0, 16),
      },
    ];
  });

  if (run === null || cells.length === 0) {
    return { state: "none", evaluatedAt: null, cells: [] };
  }
  return {
    state: "evaluated",
    evaluatedAt: run.createdAt.toISOString(),
    cells: cells.slice(0, 18),
  };
}

export interface RosPublishedSetRow {
  readonly projectionSetId: string;
  readonly leagueSeasonId: string;
  readonly leagueName: string | null;
  readonly season: number;
  readonly playerCount: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly fetchedAt: Date;
  readonly inputChecksum: string;
  readonly championArtifactChecksum: string | null;
  readonly scoringProfileKey: string | null;
}

/**
 * 5. Latest published league set. When the newest evaluation withheld, the surviving set is the
 * last good one and is flagged so the UI can say so instead of implying it is fresh.
 */
export function derivePublishedSets(input: {
  readonly rows: readonly RosPublishedSetRow[];
  readonly preservePriorGoodSet: boolean;
}): readonly RosPublishedLeagueSet[] {
  const latest = new Map<string, RosPublishedSetRow>();
  for (const row of input.rows) {
    const existing = latest.get(row.leagueSeasonId);
    if (!existing || existing.fetchedAt.getTime() < row.fetchedAt.getTime()) {
      latest.set(row.leagueSeasonId, row);
    }
  }

  return [...latest.values()]
    .sort((left, right) => right.fetchedAt.getTime() - left.fetchedAt.getTime())
    .slice(0, 64)
    .map((row) => ({
      projectionSetId: row.projectionSetId,
      leagueSeasonId: row.leagueSeasonId,
      leagueName: row.leagueName,
      scoringProfile:
        row.scoringProfileKey === null
          ? null
          : rosScoringProfileIdentityForKey(row.scoringProfileKey),
      season: row.season,
      playerCount: row.playerCount,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      asOfWeek: row.asOfWeek,
      fetchedAt: row.fetchedAt.toISOString(),
      inputChecksum: row.inputChecksum,
      championArtifactChecksum: row.championArtifactChecksum,
      retainedFromEarlierRun: input.preservePriorGoodSet,
    }));
}
