/**
 * Client-side contract and presenter for the rest-of-season release status.
 *
 * The API returns six independent facts. This module keeps them independent all the way to the
 * screen: an admitted, release-capable model is never described as globally withheld because a
 * separate audit run was degraded, and a withheld position group never implies a league lost the
 * set it already has.
 *
 * The canonical schema lives in `packages/contracts/src/ros-release-status.ts` (now re-exported from
 * the `@laces-out/contracts` barrel); `apps/api` carries the same shapes locally. `ros-release-status.test.ts`
 * pins this module's known reason list against the canonical one so the two cannot silently drift.
 *
 * Parsing here is deliberately more forgiving than the server-side wire schema on two axes that grow
 * over time — `RosLeagueReadiness.reasons` and `.positions` — because an unrecognized-but-additive
 * value from a newer API is normal, expected API evolution, not corruption: an unknown reason string
 * is kept as an opaque string (rendered via a readable fallback, see `humanizeRosWithholdingReason`)
 * instead of failing the parse, and a malformed `positions` entry is dropped rather than rejecting the
 * league or the whole payload. This mirrors the module's own stated goal above — one degraded or
 * not-yet-locally-known fact must never blank the others. Top-level shape strictness (`ALLOWED_KEYS`
 * below) stays a hard rejection on purpose: it exists specifically to catch a server re-introducing the
 * removed collapsed `publication` verdict, a real regression class, not additive evolution.
 */

export const ROS_WITHHOLDING_REASONS = [
  "scoring-rules-unsupported",
  "no-admitted-scoring-profile",
  "incomplete-schedule",
  "missing-candidate-pool",
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

/**
 * Position-scoped readiness within one league, mirroring `RosCellGateDecision`'s vocabulary.
 * `reasons` is opaque strings (not a fixed enum): the two current values are `position-unsupported`
 * (followed by real normalization messages) and `scoring-profile-position-mismatch`, but this is
 * presentation-only detail, so a not-yet-locally-known reason here is rendered as-is rather than
 * rejected.
 */
export interface RosLeaguePositionReadiness {
  readonly position: "QB" | "RB" | "WR" | "TE" | "K" | "DST";
  readonly decision: "ready" | "withheld";
  readonly reasons: readonly string[];
}

export interface RosLeagueReadiness {
  readonly leagueSeasonId: string | null;
  /** Absent on an older API, which is why a missing value degrades to null rather than failing. */
  readonly leagueName: string | null;
  readonly state: "ready" | "withheld";
  /**
   * Not a hard `RosWithholdingReason[]`: an unrecognized-but-additive value from a newer API is kept
   * as an opaque string (see the module docblock) rather than failing the parse. Every currently-known
   * value is still a `RosWithholdingReason`; `humanizeRosWithholdingReason` renders any string safely.
   */
  readonly reasons: readonly string[];
  readonly scoringProfile: RosScoringProfileIdentity | null;
  /** Always all six of QB/RB/WR/TE/K/DST when present; a missing or malformed field defaults to []. */
  readonly positions: readonly RosLeaguePositionReadiness[];
}

export interface RosCellGateDecision {
  readonly position: "QB" | "RB" | "WR" | "TE" | "K" | "DST";
  readonly bucket: "one-to-four" | "five-to-eight" | "nine-plus";
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

export interface RosAuditRun {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly createdAt: string;
  readonly reasons: readonly string[];
}

export interface RosAuditState {
  readonly state: "recorded" | "none";
  readonly latestRun: RosAuditRun | null;
}

export interface RosReleaseStatus {
  readonly season: number;
  readonly modelVersion: string;
  readonly admittedArtifacts: RosAdmittedArtifactState;
  readonly scoringProfiles: RosScoringProfileCoverage;
  readonly leagueReadiness: readonly RosLeagueReadiness[];
  readonly cellGates: RosCellGateState;
  readonly publishedSets: readonly RosPublishedLeagueSet[];
  readonly shadowAudit: RosAuditState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseProfile(value: unknown): RosScoringProfileIdentity | null {
  if (!isRecord(value)) return null;
  const { profileId, label, scoringProfileKey, digest } = value;
  if (!isString(profileId) || !isString(label) || !isString(scoringProfileKey)) return null;
  if (!isString(digest)) return null;
  return { profileId, label, scoringProfileKey, digest };
}

function parseArtifacts(value: unknown): RosAdmittedArtifactState | null {
  if (!isRecord(value)) return null;
  if (value.state !== "admitted" && value.state !== "none") return null;
  if (!Array.isArray(value.artifacts)) return null;
  const artifacts: RosAdmittedArtifact[] = [];
  for (const entry of value.artifacts) {
    if (!isRecord(entry)) return null;
    const scoringProfile = parseProfile(entry.scoringProfile);
    if (!scoringProfile) return null;
    if (
      !isFiniteNumber(entry.season) ||
      !isString(entry.modelVersion) ||
      !isString(entry.policyVersion) ||
      !isString(entry.calibrationVersion) ||
      !isFiniteNumber(entry.evidenceThroughSeason) ||
      !isString(entry.artifactChecksum) ||
      !isString(entry.admittedAt) ||
      !isFiniteNumber(entry.sourceChecksumCount)
    ) {
      return null;
    }
    artifacts.push({
      scoringProfile,
      season: entry.season,
      modelVersion: entry.modelVersion,
      policyVersion: entry.policyVersion,
      calibrationVersion: entry.calibrationVersion,
      evidenceThroughSeason: entry.evidenceThroughSeason,
      artifactChecksum: entry.artifactChecksum,
      admittedAt: entry.admittedAt,
      sourceChecksumCount: entry.sourceChecksumCount,
    });
  }
  return { state: value.state, artifacts };
}

function parseCoverage(value: unknown): RosScoringProfileCoverage | null {
  if (!isRecord(value) || !Array.isArray(value.supported) || !Array.isArray(value.unsupported)) {
    return null;
  }
  const supported: RosScoringProfileIdentity[] = [];
  for (const entry of value.supported) {
    const profile = parseProfile(entry);
    if (!profile) return null;
    supported.push(profile);
  }
  const unsupported: RosUnsupportedScoringProfile[] = [];
  for (const entry of value.unsupported) {
    if (!isRecord(entry)) return null;
    const profile = parseProfile(entry.profile);
    if (!profile || !Array.isArray(entry.blockers)) return null;
    if (entry.evidenceReport !== null && !isString(entry.evidenceReport)) return null;
    unsupported.push({
      profile,
      blockers: entry.blockers.filter(isString),
      evidenceReport: entry.evidenceReport,
    });
  }
  return { supported, unsupported };
}

/**
 * Position-scoped readiness entries are presentation detail, not schema-critical: a malformed or
 * not-yet-locally-known item is dropped rather than rejecting the league (or the whole payload). A
 * missing/non-array `positions` value (e.g. an older API response) defaults to `[]`.
 */
function parsePositionReadiness(value: unknown): readonly RosLeaguePositionReadiness[] {
  if (!Array.isArray(value)) return [];
  const positions: RosLeaguePositionReadiness[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (!isString(entry.position) || !POSITIONS.has(entry.position)) continue;
    if (entry.decision !== "ready" && entry.decision !== "withheld") continue;
    if (!Array.isArray(entry.reasons) || !entry.reasons.every(isString)) continue;
    positions.push({
      position: entry.position as RosLeaguePositionReadiness["position"],
      decision: entry.decision,
      reasons: entry.reasons,
    });
  }
  return positions;
}

function parseReadiness(value: unknown): readonly RosLeagueReadiness[] | null {
  if (!Array.isArray(value)) return null;
  const readiness: RosLeagueReadiness[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (entry.leagueSeasonId !== null && !isString(entry.leagueSeasonId)) return null;
    if (entry.state !== "ready" && entry.state !== "withheld") return null;
    // Reason membership is intentionally NOT checked against the locally-known `ROS_WITHHOLDING_REASONS`
    // here: an additive reason from a newer API must not blank this league (or the whole payload) —
    // see the module docblock. Shape (an array of strings) is still required.
    if (!Array.isArray(entry.reasons) || !entry.reasons.every(isString)) return null;
    const scoringProfile =
      entry.scoringProfile === null ? null : parseProfile(entry.scoringProfile);
    if (entry.scoringProfile !== null && !scoringProfile) return null;
    readiness.push({
      leagueSeasonId: entry.leagueSeasonId,
      leagueName: isString(entry.leagueName) ? entry.leagueName : null,
      state: entry.state,
      reasons: entry.reasons,
      scoringProfile,
      positions: parsePositionReadiness(entry.positions),
    });
  }
  return readiness;
}

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const BUCKETS = new Set(["one-to-four", "five-to-eight", "nine-plus"]);

function parseCellGates(value: unknown): RosCellGateState | null {
  if (!isRecord(value)) return null;
  if (value.state !== "evaluated" && value.state !== "none") return null;
  if (value.evaluatedAt !== null && !isString(value.evaluatedAt)) return null;
  if (!Array.isArray(value.cells)) return null;
  const cells: RosCellGateDecision[] = [];
  for (const entry of value.cells) {
    if (!isRecord(entry)) return null;
    if (!isString(entry.position) || !POSITIONS.has(entry.position)) return null;
    if (!isString(entry.bucket) || !BUCKETS.has(entry.bucket)) return null;
    if (entry.decision !== "released" && entry.decision !== "withheld") return null;
    if (!Array.isArray(entry.reasons)) return null;
    cells.push({
      position: entry.position as RosCellGateDecision["position"],
      bucket: entry.bucket as RosCellGateDecision["bucket"],
      decision: entry.decision,
      reasons: entry.reasons.filter(isString),
    });
  }
  return { state: value.state, evaluatedAt: value.evaluatedAt, cells };
}

function parsePublishedSets(value: unknown): readonly RosPublishedLeagueSet[] | null {
  if (!Array.isArray(value)) return null;
  const sets: RosPublishedLeagueSet[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const scoringProfile =
      entry.scoringProfile === null ? null : parseProfile(entry.scoringProfile);
    if (entry.scoringProfile !== null && !scoringProfile) return null;
    if (
      !isString(entry.projectionSetId) ||
      !isString(entry.leagueSeasonId) ||
      !isFiniteNumber(entry.season) ||
      !isFiniteNumber(entry.playerCount) ||
      !isFiniteNumber(entry.windowStartWeek) ||
      !isFiniteNumber(entry.windowEndWeek) ||
      !isFiniteNumber(entry.asOfWeek) ||
      !isString(entry.fetchedAt) ||
      !isString(entry.inputChecksum) ||
      typeof entry.retainedFromEarlierRun !== "boolean"
    ) {
      return null;
    }
    if (entry.championArtifactChecksum !== null && !isString(entry.championArtifactChecksum)) {
      return null;
    }
    sets.push({
      projectionSetId: entry.projectionSetId,
      leagueSeasonId: entry.leagueSeasonId,
      leagueName: isString(entry.leagueName) ? entry.leagueName : null,
      scoringProfile,
      season: entry.season,
      playerCount: entry.playerCount,
      windowStartWeek: entry.windowStartWeek,
      windowEndWeek: entry.windowEndWeek,
      asOfWeek: entry.asOfWeek,
      fetchedAt: entry.fetchedAt,
      inputChecksum: entry.inputChecksum,
      championArtifactChecksum: entry.championArtifactChecksum,
      retainedFromEarlierRun: entry.retainedFromEarlierRun,
    });
  }
  return sets;
}

function parseAudit(value: unknown): RosAuditState | null {
  if (!isRecord(value)) return null;
  if (value.state !== "recorded" && value.state !== "none") return null;
  if (value.latestRun === null) return { state: value.state, latestRun: null };
  const run = value.latestRun;
  if (!isRecord(run)) return null;
  if (
    !isString(run.sourceSyncRunId) ||
    !isString(run.mode) ||
    !isString(run.qualityState) ||
    !isString(run.createdAt) ||
    !Array.isArray(run.reasons)
  ) {
    return null;
  }
  return {
    state: value.state,
    latestRun: {
      sourceSyncRunId: run.sourceSyncRunId,
      mode: run.mode,
      qualityState: run.qualityState,
      createdAt: run.createdAt,
      reasons: run.reasons.filter(isString),
    },
  };
}

const ALLOWED_KEYS = new Set([
  "season",
  "modelVersion",
  "admittedArtifacts",
  "scoringProfiles",
  "leagueReadiness",
  "cellGates",
  "publishedSets",
  "shadowAudit",
]);

/**
 * Parses an untrusted response. Returns null rather than throwing. An unexpected key rejects, so a
 * server still emitting the removed collapsed `publication` verdict fails loudly instead of being
 * silently ignored.
 */
export function parseRosReleaseStatus(value: unknown): RosReleaseStatus | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key)) return null;
  if (!isFiniteNumber(value.season) || !isString(value.modelVersion)) return null;

  const admittedArtifacts = parseArtifacts(value.admittedArtifacts);
  const scoringProfiles = parseCoverage(value.scoringProfiles);
  const leagueReadiness = parseReadiness(value.leagueReadiness);
  const cellGates = parseCellGates(value.cellGates);
  const publishedSets = parsePublishedSets(value.publishedSets);
  const shadowAudit = parseAudit(value.shadowAudit);
  if (
    !admittedArtifacts ||
    !scoringProfiles ||
    !leagueReadiness ||
    !cellGates ||
    !publishedSets ||
    !shadowAudit
  ) {
    return null;
  }

  return {
    season: value.season,
    modelVersion: value.modelVersion,
    admittedArtifacts,
    scoringProfiles,
    leagueReadiness,
    cellGates,
    publishedSets,
    shadowAudit,
  };
}

const REASON_LABELS: Readonly<Record<RosWithholdingReason, string>> = {
  "scoring-rules-unsupported":
    "Your league's scoring rules could not be matched to any position at all.",
  "no-admitted-scoring-profile":
    "Your league's scoring rules are not one of the validated profiles.",
  "incomplete-schedule": "The NFL schedule for the remaining weeks is not complete yet.",
  "missing-candidate-pool": "The current NFL player pool has not been captured yet.",
  "insufficient-candidate-inputs": "There are not enough scored inputs for your league yet.",
  "non-converged-cell": "One or more position groups did not settle within tolerance.",
  "stale-source": "The NFL source data is older than the freshness limit.",
  "no-league-synced": "No league has been synced yet, so there is nothing to forecast for.",
};

/**
 * Turns an unrecognized reason code (e.g. one added to the API after this module was last updated)
 * into a readable-enough sentence instead of rendering `undefined`. Not pretty, but never blank.
 */
function humanizeUnknownReason(code: string): string {
  const words = code
    .split(/[-_\s]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return "Your league has an unrecognized readiness issue.";
  const sentence = words.join(" ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * Accepts any string, not just a known `RosWithholdingReason`: `RosLeagueReadiness.reasons` is parsed
 * leniently (see the module docblock) so a reason the API added after this module was last updated
 * still renders, via `humanizeUnknownReason`, instead of the panel losing the whole payload.
 */
export function humanizeRosWithholdingReason(reason: string): string {
  return (
    (REASON_LABELS as Readonly<Record<string, string>>)[reason] ?? humanizeUnknownReason(reason)
  );
}

/** One position's compact readiness chip for one league. */
export interface RosLeaguePositionChip {
  readonly position: "QB" | "RB" | "WR" | "TE" | "K" | "DST";
  readonly decision: "ready" | "withheld";
  /** The position's first reason string, verbatim; null when there is nothing to explain. */
  readonly title: string | null;
}

/** One league's per-position readiness, in `POSITION_GROUP_ORDER`. */
export interface RosLeaguePositionSummary {
  readonly leagueSeasonId: string | null;
  /** Falls back to a shortened id only when the API did not send a name. */
  readonly leagueLabel: string;
  readonly positions: readonly RosLeaguePositionChip[];
}

export interface RosReleaseDescription {
  /** Fact 1 and 2: the validated model and what scoring it covers. */
  readonly artifactHeadline: string;
  readonly supportedProfileSummary: string;
  readonly unsupportedProfileSummary: string | null;
  /** Fact 3: the caller's own leagues. */
  readonly leagueNotices: readonly string[];
  readonly readyLeagueCount: number;
  /** Fact 3, position-scoped: each league's own per-position readiness, for compact chip display. */
  readonly leaguePositionSummaries: readonly RosLeaguePositionSummary[];
  /** Fact 4: the live per-cell gate. */
  readonly cellSummary: string | null;
  readonly withheldCells: readonly string[];
  /** Fact 5: what each league actually holds. */
  readonly publishedLeagueCount: number;
  readonly publishedPlayerCount: number;
  readonly retainedSetNotice: string | null;
  /** Fact 6: the independent audit rail, described as itself and nothing more. */
  readonly auditHeadline: string;
  readonly auditDetail: string | null;
}

const POSITION_GROUP_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

/**
 * A league is named by its name. The truncated id is a last resort for a payload that predates
 * the name field — it is not something anyone can recognize their own league by.
 */
export function leagueLabelFor(name: string | null, leagueSeasonId: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return leagueSeasonId ? `League ${leagueSeasonId.slice(0, 8)}` : "League";
}

/**
 * Builds the panel's copy. Each field answers exactly one of the six facts; no field is computed
 * from another. In particular the audit headline never changes because of the artifact state, and
 * the artifact headline never changes because of the audit.
 */
export function describeRosRelease(status: RosReleaseStatus): RosReleaseDescription {
  const supported = status.scoringProfiles.supported;
  const artifact = status.admittedArtifacts.artifacts[0];

  const artifactHeadline =
    status.admittedArtifacts.state === "admitted" && artifact
      ? `Ready for ${artifact.scoringProfile.label} scoring`
      : "Not ready for this season yet";

  const coversFullPpr = supported.some((profile) => profile.label === "Full PPR");
  const coversHalfPpr = supported.some((profile) => profile.label === "Half PPR");
  const supportedScoringFamilies = [
    coversFullPpr && coversHalfPpr
      ? "Half/Full PPR"
      : coversFullPpr
        ? "Full PPR"
        : coversHalfPpr
          ? "Half PPR"
          : null,
    supported.some((profile) => profile.label.startsWith("Standard")) ? "Standard" : null,
  ].filter((family): family is string => family !== null);
  const supportedProfileSummary =
    supportedScoringFamilies.length === 0
      ? "No scoring formats ready yet"
      : `Covers ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(
          supportedScoringFamilies,
        )} scoring`;

  const unsupportedProfileSummary =
    status.scoringProfiles.unsupported.length === 0
      ? null
      : `Does not cover ${status.scoringProfiles.unsupported
          .map((entry) => entry.profile.label)
          .join(", ")}`;

  const leagueNotices = [
    ...new Set(
      status.leagueReadiness.flatMap((league) =>
        league.reasons.map((reason) => humanizeRosWithholdingReason(reason)),
      ),
    ),
  ];

  // Omits a league reporting no positions at all (e.g. the no-league-synced placeholder entry,
  // which always carries `positions: []`) — there is nothing to render a chip row for.
  const leaguePositionSummaries: RosLeaguePositionSummary[] = status.leagueReadiness
    .filter((league) => league.positions.length > 0)
    .map((league) => ({
      leagueSeasonId: league.leagueSeasonId,
      leagueLabel: leagueLabelFor(league.leagueName, league.leagueSeasonId),
      positions: league.positions.map((position) => ({
        position: position.position,
        decision: position.decision,
        title: position.reasons[0] ?? null,
      })),
    }));

  const cells = status.cellGates.cells;
  const releasedCount = cells.filter((cell) => cell.decision === "released").length;
  const cellSummary =
    cells.length === 0 ? null : `${releasedCount} of ${cells.length} position groups released`;
  const withheldCells = POSITION_GROUP_ORDER.flatMap((position) =>
    cells.some((cell) => cell.position === position && cell.decision === "withheld")
      ? [position]
      : [],
  );

  const retained = status.publishedSets.some((set) => set.retainedFromEarlierRun);
  const retainedSetNotice = retained
    ? "Some positions did not clear the latest check, so your league keeps the last forecast that did."
    : null;

  const auditHeadline =
    status.shadowAudit.state === "recorded"
      ? "Separate audit run, not a release signal"
      : "No separate audit run recorded this season";
  const auditDetail =
    status.shadowAudit.latestRun === null
      ? null
      : `Recorded ${status.shadowAudit.latestRun.reasons.length} diagnostic${
          status.shadowAudit.latestRun.reasons.length === 1 ? "" : "s"
        }. This run audits the model on its own; it does not decide whether your league receives a forecast.`;

  return {
    artifactHeadline,
    supportedProfileSummary,
    unsupportedProfileSummary,
    leagueNotices,
    readyLeagueCount: status.leagueReadiness.filter((league) => league.state === "ready").length,
    leaguePositionSummaries,
    cellSummary,
    withheldCells,
    publishedLeagueCount: status.publishedSets.length,
    publishedPlayerCount: status.publishedSets.reduce((sum, set) => sum + set.playerCount, 0),
    retainedSetNotice,
    auditHeadline,
    auditDetail,
  };
}
