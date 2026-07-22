// Read-only client view of the fail-closed rest-of-season (ROS) projection rail. This mirrors the
// API's `/v1/projections/ros-status` shape and turns its recorded state into plain language. It is a
// visibility surface only: nothing here feeds lineup, waiver, trade, standings, or AI recommendations.

export type RosPublicationSummary = "fail-closed-shadow" | "publishable";

export interface RosChampionArtifactPresent {
  readonly present: true;
  readonly season: number;
  readonly scoringProfileKey: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string;
  readonly evidenceThroughSeason: number;
  readonly artifactChecksum: string;
  readonly sourceChecksums: readonly { readonly key: string; readonly checksum: string }[];
  readonly admittedAt: string;
}

export type RosChampionArtifact = RosChampionArtifactPresent | { readonly present: false };

export interface RosModelRunAudit {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly canPublish: boolean;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: string | null;
  readonly playersEvaluated: number;
  readonly playersPublished: number;
  readonly reasons: readonly string[];
  readonly evidenceGate: Record<string, unknown> | null;
  readonly inputChecksum: string;
  readonly sourceAsOf: string | null;
  readonly createdAt: string;
}

export interface RosPublishedSetSummary {
  readonly projectionSetId: string;
  readonly leagueSeasonId: string;
  readonly source: string;
  readonly version: string;
  readonly season: number;
  readonly playerCount: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: string | null;
  readonly fetchedAt: string;
  readonly inputChecksum: string;
  readonly championArtifactChecksum: string | null;
  readonly scoringProfileKey: string | null;
  readonly createdAt: string;
}

export interface RosProjectionStatus {
  readonly season: number;
  readonly modelVersion: string;
  readonly publication: RosPublicationSummary;
  readonly artifact: RosChampionArtifact;
  readonly latestRun: RosModelRunAudit | null;
  readonly publishedSets: readonly RosPublishedSetSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseArtifact(value: unknown): RosChampionArtifact | null {
  if (!isRecord(value)) return null;
  if (value.present === false) return { present: false };
  if (value.present !== true) return null;
  if (
    typeof value.season !== "number" ||
    typeof value.scoringProfileKey !== "string" ||
    typeof value.modelVersion !== "string" ||
    typeof value.policyVersion !== "string" ||
    typeof value.calibrationVersion !== "string" ||
    typeof value.evidenceThroughSeason !== "number" ||
    typeof value.artifactChecksum !== "string" ||
    typeof value.admittedAt !== "string" ||
    !Array.isArray(value.sourceChecksums)
  ) {
    return null;
  }
  const sourceChecksums: { key: string; checksum: string }[] = [];
  for (const entry of value.sourceChecksums) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.checksum !== "string") {
      return null;
    }
    sourceChecksums.push({ key: entry.key, checksum: entry.checksum });
  }
  return {
    present: true,
    season: value.season,
    scoringProfileKey: value.scoringProfileKey,
    modelVersion: value.modelVersion,
    policyVersion: value.policyVersion,
    calibrationVersion: value.calibrationVersion,
    evidenceThroughSeason: value.evidenceThroughSeason,
    artifactChecksum: value.artifactChecksum,
    sourceChecksums,
    admittedAt: value.admittedAt,
  };
}

const INVALID = Symbol("invalid");

function parseRun(value: unknown): RosModelRunAudit | null | typeof INVALID {
  if (value === null) return null;
  if (!isRecord(value)) return INVALID;
  if (
    typeof value.sourceSyncRunId !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.qualityState !== "string" ||
    typeof value.canPublish !== "boolean" ||
    typeof value.season !== "number" ||
    typeof value.windowStartWeek !== "number" ||
    typeof value.windowEndWeek !== "number" ||
    typeof value.asOfWeek !== "number" ||
    (value.asOfAt !== null && typeof value.asOfAt !== "string") ||
    typeof value.playersEvaluated !== "number" ||
    typeof value.playersPublished !== "number" ||
    !isStringArray(value.reasons) ||
    (value.evidenceGate !== null && !isRecord(value.evidenceGate)) ||
    typeof value.inputChecksum !== "string" ||
    (value.sourceAsOf !== null && typeof value.sourceAsOf !== "string") ||
    typeof value.createdAt !== "string"
  ) {
    return INVALID;
  }
  return {
    sourceSyncRunId: value.sourceSyncRunId,
    mode: value.mode,
    qualityState: value.qualityState,
    canPublish: value.canPublish,
    season: value.season,
    windowStartWeek: value.windowStartWeek,
    windowEndWeek: value.windowEndWeek,
    asOfWeek: value.asOfWeek,
    asOfAt: value.asOfAt,
    playersEvaluated: value.playersEvaluated,
    playersPublished: value.playersPublished,
    reasons: value.reasons,
    evidenceGate: value.evidenceGate,
    inputChecksum: value.inputChecksum,
    sourceAsOf: value.sourceAsOf,
    createdAt: value.createdAt,
  };
}

function parsePublishedSet(value: unknown): RosPublishedSetSummary | null {
  if (
    !isRecord(value) ||
    typeof value.projectionSetId !== "string" ||
    typeof value.leagueSeasonId !== "string" ||
    typeof value.source !== "string" ||
    typeof value.version !== "string" ||
    typeof value.season !== "number" ||
    typeof value.playerCount !== "number" ||
    typeof value.windowStartWeek !== "number" ||
    typeof value.windowEndWeek !== "number" ||
    typeof value.asOfWeek !== "number" ||
    (value.asOfAt !== null && typeof value.asOfAt !== "string") ||
    typeof value.fetchedAt !== "string" ||
    typeof value.inputChecksum !== "string" ||
    (value.championArtifactChecksum !== null &&
      typeof value.championArtifactChecksum !== "string") ||
    (value.scoringProfileKey !== null && typeof value.scoringProfileKey !== "string") ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    projectionSetId: value.projectionSetId,
    leagueSeasonId: value.leagueSeasonId,
    source: value.source,
    version: value.version,
    season: value.season,
    playerCount: value.playerCount,
    windowStartWeek: value.windowStartWeek,
    windowEndWeek: value.windowEndWeek,
    asOfWeek: value.asOfWeek,
    asOfAt: value.asOfAt,
    fetchedAt: value.fetchedAt,
    inputChecksum: value.inputChecksum,
    championArtifactChecksum: value.championArtifactChecksum,
    scoringProfileKey: value.scoringProfileKey,
    createdAt: value.createdAt,
  };
}

export function parseRosProjectionStatus(value: unknown): RosProjectionStatus | null {
  if (
    !isRecord(value) ||
    typeof value.season !== "number" ||
    typeof value.modelVersion !== "string" ||
    (value.publication !== "fail-closed-shadow" && value.publication !== "publishable") ||
    !Array.isArray(value.publishedSets)
  ) {
    return null;
  }
  const artifact = parseArtifact(value.artifact);
  if (!artifact) return null;
  const latestRun = parseRun(value.latestRun);
  if (latestRun === INVALID) return null;
  const publishedSets: RosPublishedSetSummary[] = [];
  for (const entry of value.publishedSets) {
    const parsed = parsePublishedSet(entry);
    if (!parsed) return null;
    publishedSets.push(parsed);
  }
  return {
    season: value.season,
    modelVersion: value.modelVersion,
    publication: value.publication,
    artifact,
    latestRun,
    publishedSets,
  };
}

// Human-readable copy for the audit reason codes the rail records. Unknown codes are humanized by
// replacing separators so a new worker diagnostic still renders legibly.
const REASON_LABELS: Record<string, string> = {
  schedule_source_missing: "NFL schedule source has not synced.",
  schedule_source_not_fresh: "NFL schedule source is stale.",
  no_untouched_regular_season_window: "No untouched regular-season window is available yet.",
  weekly_projection_source_missing: "Weekly projection source is missing.",
  weekly_projection_source_not_fresh: "Weekly projection source is stale.",
  weekly_projection_window_incomplete: "The weekly forecast window is not complete.",
  weekly_projection_pin_not_publishable: "A weekly forecast in the window is not publishable.",
  weekly_candidate_pairs_not_persisted: "Champion candidate pairs are not persisted yet.",
  held_out_seasons_below_minimum: "Held-out seasons are below the required minimum.",
  held_out_batches_below_minimum: "Held-out batches are below the required minimum.",
  held_out_samples_below_minimum: "Held-out samples are below the required minimum.",
  prediction_intervals_not_calibrated: "Prediction intervals are not calibrated.",
  shadow_publication_disabled: "Publication is intentionally disabled — shadow evidence only.",
  ros_champion_artifact_absent: "No admitted champion artifact exists.",
  ros_champion_artifact_invalid: "The champion artifact failed validation.",
  ros_champion_artifact_scoring_profile_mismatch:
    "The champion artifact's scoring profile does not match the league.",
  ros_future_window_incomplete: "The future forecast window is incomplete.",
  ros_release_gate_withheld: "The live release gate withheld one or more buckets.",
};

export function humanizeRosReason(code: string): string {
  return (
    REASON_LABELS[code] ?? code.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (c) => c.toUpperCase())
  );
}

export interface RosRailDescription {
  readonly isShadow: boolean;
  readonly statusLabel: string;
  readonly statusDetail: string;
  readonly artifactPresent: boolean;
  readonly artifactSummary: string;
  readonly reasons: readonly { readonly code: string; readonly label: string }[];
  readonly lastEvaluatedIso: string | null;
  readonly lastPublishedIso: string | null;
  readonly publishedLeagueCount: number;
  readonly publishedPlayerCount: number;
}

/**
 * Plain-language description of the rail's posture for the Projection Lab panel. When fail-closed it
 * makes clear the rail is shadow-only and is not used in any recommendation.
 */
export function describeRosProjectionRail(status: RosProjectionStatus): RosRailDescription {
  const isShadow = status.publication === "fail-closed-shadow";
  const artifactPresent = status.artifact.present;
  const reasonCodes = status.latestRun?.reasons ?? [];
  const reasons = reasonCodes.map((code) => ({ code, label: humanizeRosReason(code) }));
  const publishedPlayerCount = status.publishedSets.reduce((sum, set) => sum + set.playerCount, 0);
  const lastPublishedIso =
    status.publishedSets.length === 0
      ? null
      : status.publishedSets
          .map((set) => set.fetchedAt)
          .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))[0];
  const artifactSummary = status.artifact.present
    ? `Champion artifact admitted for ${status.artifact.scoringProfileKey} (evidence through ${status.artifact.evidenceThroughSeason}).`
    : "No champion artifact admitted — the rail cannot authorize live publication.";
  return {
    isShadow,
    statusLabel: isShadow ? "Fail-closed shadow" : "Publishable",
    statusDetail: isShadow
      ? "The rail records audit evidence only. No projections reach recommendations."
      : "A validated champion artifact has authorized league-scoped publication.",
    artifactPresent,
    artifactSummary,
    reasons,
    lastEvaluatedIso: status.latestRun?.createdAt ?? null,
    lastPublishedIso: lastPublishedIso ?? null,
    publishedLeagueCount: status.publishedSets.length,
    publishedPlayerCount,
  };
}
