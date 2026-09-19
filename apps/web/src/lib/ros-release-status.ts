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
 * over time: `RosLeagueReadiness.reasons` and `.positions`. An unknown reason remains an opaque
 * string, and a malformed position entry is dropped rather than rejecting the whole payload.
 * Top-level shape strictness (`ALLOWED_KEYS` below) remains a hard rejection so a removed collapsed
 * `publication` verdict cannot return unnoticed.
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
   * Not a hard `RosWithholdingReason[]`: an additive value from a newer API remains an opaque string
   * rather than failing the parse.
   */
  readonly reasons: readonly string[];
  readonly scoringProfile: RosScoringProfileIdentity | null;
  /** Always all six of QB/RB/WR/TE/K/DST when present; a missing or malformed field defaults to []. */
  readonly positions: readonly RosLeaguePositionReadiness[];
  readonly scoringValidation?: {
    readonly state: "pending" | "validating" | "admitted" | "withheld" | "failed";
    readonly requestedAt: string;
    readonly blockers: readonly string[];
    readonly rawBlockers?: readonly string[];
    readonly supersededIntervalDiagnostics?: readonly string[];
    readonly historyPreparation?: {
      readonly state:
        "pending" | "building" | "ready" | "retry-wait" | "waiting-source" | "blocked-integrity";
      readonly updatedAt: string;
      readonly nextAttemptAt: string | null;
    };
  };
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
    let scoringValidation: RosLeagueReadiness["scoringValidation"];
    if (entry.scoringValidation !== undefined) {
      const validation = entry.scoringValidation;
      if (
        !isRecord(validation) ||
        typeof validation.state !== "string" ||
        !["pending", "validating", "admitted", "withheld", "failed"].includes(validation.state) ||
        !isString(validation.requestedAt) ||
        !Number.isFinite(Date.parse(validation.requestedAt)) ||
        !Array.isArray(validation.blockers) ||
        !validation.blockers.every(isString)
      )
        return null;
      scoringValidation = {
        state: validation.state as NonNullable<RosLeagueReadiness["scoringValidation"]>["state"],
        requestedAt: validation.requestedAt,
        blockers: validation.blockers,
        ...(Array.isArray(validation.rawBlockers) && validation.rawBlockers.every(isString)
          ? { rawBlockers: validation.rawBlockers }
          : {}),
        ...(Array.isArray(validation.supersededIntervalDiagnostics) &&
        validation.supersededIntervalDiagnostics.every(isString)
          ? { supersededIntervalDiagnostics: validation.supersededIntervalDiagnostics }
          : {}),
      };
      const history = validation.historyPreparation;
      // This additive diagnostic must not blank the entire status on a mixed-version rollout.
      if (
        isRecord(history) &&
        typeof history.state === "string" &&
        [
          "pending",
          "building",
          "ready",
          "retry-wait",
          "waiting-source",
          "blocked-integrity",
        ].includes(history.state) &&
        isString(history.updatedAt) &&
        Number.isFinite(Date.parse(history.updatedAt)) &&
        (history.nextAttemptAt === null ||
          (isString(history.nextAttemptAt) && Number.isFinite(Date.parse(history.nextAttemptAt))))
      ) {
        scoringValidation = {
          ...scoringValidation,
          historyPreparation: {
            state: history.state as NonNullable<
              NonNullable<RosLeagueReadiness["scoringValidation"]>["historyPreparation"]
            >["state"],
            updatedAt: history.updatedAt,
            nextAttemptAt: history.nextAttemptAt,
          },
        };
      }
    }
    readiness.push({
      leagueSeasonId: entry.leagueSeasonId,
      leagueName: isString(entry.leagueName) ? entry.leagueName : null,
      state: entry.state,
      reasons: entry.reasons,
      scoringProfile,
      positions: parsePositionReadiness(entry.positions),
      ...(scoringValidation ? { scoringValidation } : {}),
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

export interface RosReleaseDescription {
  readonly artifactHeadline: string;
  readonly supportedProfileSummary: string;
  readonly unsupportedProfileSummary: string | null;
  readonly cellSummary: string | null;
  readonly withheldCells: readonly string[];
  readonly publishedLeagueCount: number;
  readonly publishedPlayerCount: number;
  readonly retainedSetNotice: string | null;
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

/** Explains the caller's league independently of another league's publication or model check. */
export function describeRosLeagueReadiness(
  league: RosLeagueReadiness,
  hasPublishedSet: boolean,
): {
  readonly heading: string;
  readonly messages: readonly string[];
  readonly positionMessages: readonly string[];
  readonly showConnections: boolean;
} {
  const validation = league.scoringValidation?.state;
  const history = league.scoringValidation?.historyPreparation;
  const reasonMessages: Readonly<Record<string, string>> = {
    "scoring-rules-unsupported":
      "Some scoring rules are not supported yet. Your league settings are saved; changing a model or reconnecting will not add support for those rules.",
    "no-admitted-scoring-profile":
      "A forecast for these scoring rules must pass validation before it can be published.",
    "incomplete-schedule":
      "The NFL schedule is incomplete. Forecasts will update after the missing games arrive.",
    "missing-candidate-pool":
      "The current NFL player pool is not available yet. Laces Out is waiting for that data.",
    "insufficient-candidate-inputs":
      "There is not enough verified player data to produce a complete forecast yet.",
    "non-converged-cell":
      "This league's latest simulation did not produce stable results. A new forecast will wait for a passing check.",
    "stale-source": "The NFL inputs need to be refreshed before a new forecast can be published.",
    "no-league-synced":
      "Connect a league and finish its first sync to prepare a forecast for your scoring rules.",
  };
  const messages = league.reasons.map(
    (reason) => reasonMessages[reason] ?? "A required forecast check has not passed yet.",
  );
  let heading = hasPublishedSet ? "Forecast available" : "Waiting for first forecast";
  if (
    history &&
    (validation === "pending" || validation === "failed") &&
    history.state !== "ready"
  ) {
    const descriptions = {
      pending: [
        "Forecast preparation queued",
        "Laces Out is preparing the historical player data used to check forecasts. This runs automatically.",
      ],
      building: [
        "Preparing forecast history",
        "Laces Out is preparing shared historical player data. The initial build can take several hours; your scoring check will follow automatically.",
      ],
      "retry-wait": [
        "Forecast preparation will retry",
        "Historical data preparation was interrupted. Laces Out will retry automatically; your league connection does not need to be changed.",
      ],
      "waiting-source": [
        "Waiting for historical data",
        "Some required historical player data is incomplete. Laces Out will check for updated data automatically.",
      ],
      "blocked-integrity": [
        "Forecast preparation needs repair",
        "Laces Out found a problem with its stored historical data and needs to repair it before this check can continue. Your league connection does not need to be changed.",
      ],
    } as const;
    const description = descriptions[history.state];
    heading = description[0];
    messages.unshift(description[1]);
    if (
      history.nextAttemptAt !== null &&
      (history.state === "retry-wait" || history.state === "waiting-source")
    ) {
      messages.push(
        `Next automatic retry is scheduled for ${new Date(history.nextAttemptAt).toLocaleString()}.`,
      );
    }
  } else if (validation === "pending" || validation === "validating") {
    heading =
      validation === "pending" ? "Scoring validation queued" : "Checking your scoring rules";
    messages.unshift(
      "Laces Out is testing a forecast against your league's exact scoring rules. This runs automatically and can take several hours.",
    );
  } else if (validation === "failed") {
    heading = "Scoring check interrupted";
    messages.unshift(
      "The scoring check could not finish. Laces Out needs to resolve this check; your league connection does not need to be changed.",
    );
  } else if (validation === "withheld") {
    heading = "Scoring validation has not passed";
    messages.unshift(
      "The forecast has not passed the accuracy checks for these scoring rules. Existing approved numbers are retained when available.",
    );
  } else if (league.state === "withheld") {
    heading = hasPublishedSet ? "Latest approved forecast retained" : "Forecast waiting on inputs";
  } else if (!hasPublishedSet) {
    messages.push(
      "The available inputs are ready. Your league is waiting for its first complete forecast.",
    );
  }
  const positionMessages = league.positions
    .filter((position) => position.decision === "withheld")
    .map((position) => {
      const explanations = position.reasons
        .filter((reason) => reason !== "position-unsupported")
        .map((reason) =>
          reason === "scoring-profile-position-mismatch"
            ? "This position does not have an approved forecast for your scoring rules."
            : reason,
        );
      return `${position.position === "DST" ? "D/ST" : position.position}: ${explanations.join(" ") || "These scoring rules are not supported yet."}`;
    });
  return {
    heading,
    messages: [...new Set(messages)],
    positionMessages,
    showConnections: league.reasons.includes("no-league-synced"),
  };
}

/** Builds the copy and counts used by the rest-of-season status panel. */
export function describeRosRelease(status: RosReleaseStatus): RosReleaseDescription {
  const supported = status.scoringProfiles.supported;
  const artifact = status.admittedArtifacts.artifacts[0];

  const artifactHeadline =
    status.admittedArtifacts.state === "admitted" && artifact
      ? `Ready for ${artifact.scoringProfile.label}${artifact.scoringProfile.label.endsWith("scoring") ? "" : " scoring"}`
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
  const otherFormatCount = supported.filter(
    (profile) =>
      profile.label !== "Full PPR" &&
      profile.label !== "Half PPR" &&
      !profile.label.startsWith("Standard"),
  ).length;
  if (otherFormatCount > 0)
    supportedScoringFamilies.push(
      `${otherFormatCount} additional league ${otherFormatCount === 1 ? "format" : "formats"}`,
    );
  const supportedProfileSummary =
    supported.length === 0
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

  return {
    artifactHeadline,
    supportedProfileSummary,
    unsupportedProfileSummary,
    cellSummary,
    withheldCells,
    publishedLeagueCount: status.publishedSets.length,
    publishedPlayerCount: status.publishedSets.reduce((sum, set) => sum + set.playerCount, 0),
    retainedSetNotice,
  };
}
