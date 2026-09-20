import type {
  FirstPartyRosLiveProjection,
  FirstPartyRosLiveProjector,
} from "./ros-live-projection.js";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  dataSources,
  fantasyTeams,
  leagueSeasons,
  nflScheduleObservations,
  playerExternalIds,
  playerInjuryReportObservations,
  playerSnapCountObservations,
  playerSourceObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  rosterEntries,
  rosterSnapshots,
  scoringRules,
  teamWeeklyStatObservations,
  type Database,
} from "@laces-out/db";
import {
  NFL_TEAMS,
  canonicalNflTeamCode,
  playerNameIdentityParts,
  playerNameIdentitiesCompatible,
  providerPlayerCrosswalkId,
} from "@laces-out/domain";
import {
  fitFirstPartyDefenseGameCalibration,
  FIRST_PARTY_ROS_POINT_POLICY_VERSION,
  extractFirstPartyRosPointConvergence,
  DEFENSE_POINTS_ALLOWED_DEFINITIONS,
  defensePointsAllowedDefinitionForProfile,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  projectFirstPartyRestOfSeason,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type FirstPartyProjectionCalibration,
  type FirstPartyProjectionPosition,
  type FirstPartyRosLiveReleaseEvidence,
  type FirstPartyRosProjectionInput,
  type FirstPartyTeamDefenseCalibration,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
  type LeagueScoringPositionSupport,
  type ProjectionScoringProfile,
  type ProjectionDefensePointsAllowedDefinition,
} from "@laces-out/projections";
import { createRosLiveProjectionReuse } from "./ros-live-reuse.js";
import { createRosLiveOutcomeProjector, ROS_LIVE_OUTCOME_VERSION } from "./ros-live-outcomes.js";
import { prepareRosLiveOutcomeCache } from "./ros-live-cache-capacity.js";
import { createRosLiveGenerationStore } from "./ros-live-generation-store.js";
import {
  canonicalRosLiveRows,
  rosLivePhysicalIdentity,
  ROS_LIVE_PHYSICAL_IDENTITY_VERSION,
} from "./ros-live-physical-identity.js";
import {
  restoreRosLiveCalibration,
  restoreRosLiveTargetTemplate,
} from "./ros-live-generation-validation.js";
import { rosSourceVersionPredicate } from "./first-party-ros-source-versions.js";
import { readRosHistoryCatalogRolesChecksum } from "./ros-history-catalog-checksum.js";
import { assertFootballSourceCoherence } from "./football-source-coherence.js";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  HISTORICAL_ROS_SUPPORTED_POSITIONS,
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
  type HistoricalRosAvailabilityCalibration,
  type HistoricalRosKickerCalibration,
  type HistoricalRosRoleCalibration,
} from "./first-party-ros-backtest.js";
import {
  assembleFirstPartyRosCandidateInputs,
  assembleFirstPartyRosDefenseCandidateInputs,
  buildFirstPartyRosLiveReleaseEvidence,
  diagnoseBoundedFirstPartyRosConvergence,
  simulateFirstPartyRosCandidate,
  validateFirstPartyRosLiveConvergenceCounts,
  type FirstPartyRosAssembledCandidateInputs,
  type FirstPartyRosCandidate,
} from "./first-party-ros-candidates.js";
import {
  buildFirstPartyPlayerHistory,
  FIRST_PARTY_PLAYER_HISTORY_VERSION,
  FIRST_PARTY_DEFENSE_HISTORY_VERSION,
  buildFirstPartyDefenseHistory,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
  type ProjectionSnapFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "./first-party-projection-inputs.js";
import {
  espnSelfAssertedProjectionLeague,
  firstPartyAvailableProjectionComponents,
  firstPartyDefensePlayerId,
  projectionHistorySeasons,
} from "./first-party-projections.js";
import type {
  FirstPartyRosCandidateContext,
  FirstPartyRosCandidateProvider,
  FirstPartyRosPublicationTarget,
  FirstPartyRosWindow,
} from "./first-party-ros-projections.js";
import {
  matchFirstPartyRosPositions,
  firstPartyRosChampionArtifactIsValid,
  selectFirstPartyRosArtifactForLeague,
  type FirstPartyRosRailPosition,
  type FirstPartyRosReleasedPlayer,
  type FirstPartyRosRunConvergence,
  type FirstPartyRosWithheldPosition,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic 64-hex lineage digest over an unordered set of member checksums. */
function aggregateChecksum(kind: string, members: readonly string[]): string {
  return sha256(JSON.stringify({ kind, members: [...members].sort() }));
}

function normalizePosition(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "HB" || normalized === "FB") return "RB";
  if (normalized === "PK") return "K";
  if (normalized === "D/ST" || normalized === "DEF") return "DST";
  return normalized;
}

export interface FirstPartyRosScoringMatchedLeague {
  readonly leagueSeasonId: string;
  readonly profile: ProjectionScoringProfile;
  /** Rail positions this league may receive from the artifact. Never empty on a matched league. */
  readonly matchedPositions: readonly FirstPartyRosRailPosition[];
  /** Rail positions this league may not receive, each with the reason it was withheld. */
  readonly withheldPositions: readonly FirstPartyRosWithheldPosition[];
  /** Rail positions league-scoring normalization supports, matched or not. */
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
}

/** A league the artifact authorizes for no position at all, with the reason for each one. */
export interface FirstPartyRosScoringExcludedLeague {
  readonly leagueSeasonId: string;
  readonly withheldPositions: readonly FirstPartyRosWithheldPosition[];
}

export interface FirstPartyRosScoringMatchReport {
  readonly matched: readonly FirstPartyRosScoringMatchedLeague[];
  readonly excluded: readonly FirstPartyRosScoringExcludedLeague[];
}

/**
 * Applies the release rail's single-artifact arbitration before simulation. The release service
 * repeats the same check after targets are built as a fail-closed backstop; doing it here avoids
 * simulating a full player pool for artifacts whose output would necessarily be discarded.
 */
export function firstPartyRosArtifactOwnedLeagues(input: {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly artifacts: readonly LoadedFirstPartyRosChampionArtifact[];
  readonly leagues: readonly FirstPartyRosScoringMatchedLeague[];
}): readonly FirstPartyRosScoringMatchedLeague[] {
  return input.leagues.filter((league) => {
    const selected = selectFirstPartyRosArtifactForLeague({
      artifacts: input.artifacts,
      leagueScoringProfileKey: projectionScoringProfileKey(league.profile),
      leagueScoringProfile: league.profile,
      supportedPositions: league.supportedPositions,
    });
    return selected?.artifactChecksum === input.artifact.artifactChecksum;
  });
}

export interface FirstPartyRosLeagueRow {
  readonly id: string;
  readonly provider: string;
}

export interface FirstPartyRosScoringRuleRow {
  readonly leagueSeasonId: string;
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly operation: string;
  readonly points: string;
  readonly thresholdLow: string | null;
  readonly thresholdHigh: string | null;
  readonly positionTypes: readonly string[] | null;
}

const UNSUPPORTED_RAIL_POSITIONS: readonly FirstPartyRosWithheldPosition[] =
  HISTORICAL_ROS_SUPPORTED_POSITIONS.map((position) => ({
    position,
    reason: "position-unsupported" as const,
  }));

/** The rail positions a normalization result reports as supported, in rail order. */
function supportedRailPositions(
  positions: readonly LeagueScoringPositionSupport[],
): readonly FirstPartyRosRailPosition[] {
  const supported = new Set(
    positions.filter((entry) => entry.supported).map((entry) => entry.position),
  );
  return HISTORICAL_ROS_SUPPORTED_POSITIONS.filter((position) => supported.has(position));
}

/**
 * Matches leagues against the champion artifact one position at a time. A league receives a
 * position only when its own normalization supports that position AND the position-scoped scoring
 * keys are byte-equal to the artifact's, so a league that prices D/ST or kickers differently keeps
 * every position whose scoring is provably identical and loses exactly the ones that are not.
 *
 * Nothing is widened and nothing is silently dropped: a league that matches no position is
 * excluded exactly as before, but now reports why for each position instead of vanishing.
 */
export function enumerateFirstPartyRosScoringMatchedLeagues(input: {
  readonly artifactScoringProfileKey: string;
  readonly leagues: readonly FirstPartyRosLeagueRow[];
  readonly rules: readonly FirstPartyRosScoringRuleRow[];
  readonly availableStatIds: readonly string[];
}): FirstPartyRosScoringMatchReport {
  const rulesByLeague = new Map<string, FirstPartyRosScoringRuleRow[]>();
  for (const rule of input.rules) {
    const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
    rows.push(rule);
    rulesByLeague.set(rule.leagueSeasonId, rows);
  }
  const matched: FirstPartyRosScoringMatchedLeague[] = [];
  const excluded: FirstPartyRosScoringExcludedLeague[] = [];
  for (const league of input.leagues) {
    const normalization = normalizeLeagueScoringProfile({
      id: `league:${league.id}`,
      label: "League scoring",
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
      rows: (rulesByLeague.get(league.id) ?? []).map((rule) => ({
        provider: league.provider,
        statKey: rule.statKey,
        providerStatId: rule.providerStatId,
        operation: rule.operation,
        points: rule.points,
        thresholdLow: rule.thresholdLow,
        thresholdHigh: rule.thresholdHigh,
        positionTypes: rule.positionTypes,
      })),
      availableStatIds: input.availableStatIds,
    });
    if (normalization.state !== "available") {
      // No profile exists to compare, so no position can be attributed anything but its own
      // unsupported normalization.
      excluded.push({ leagueSeasonId: league.id, withheldPositions: UNSUPPORTED_RAIL_POSITIONS });
      continue;
    }
    const supportedPositions = supportedRailPositions(normalization.positions);
    const match = matchFirstPartyRosPositions({
      artifactScoringProfileKey: input.artifactScoringProfileKey,
      leagueScoringProfile: normalization.profile,
      supportedPositions,
    });
    if (match.matched.length === 0) {
      excluded.push({ leagueSeasonId: league.id, withheldPositions: match.withheld });
      continue;
    }
    matched.push({
      leagueSeasonId: league.id,
      profile: normalization.profile,
      matchedPositions: match.matched,
      withheldPositions: match.withheld,
      supportedPositions,
    });
  }
  return { matched, excluded };
}

export interface FirstPartyRosCandidatePlayer {
  readonly playerId: string;
  readonly position: string;
  readonly team: string | null;
  readonly rosterStatus?: string | null;
}

export interface FirstPartyRosRosterUniverseRow {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly status: string | null;
}

export interface FirstPartyRosUnmatchedCandidate {
  readonly externalPlayerId: string;
  readonly positions: readonly FirstPartyRosRailPosition[];
}

/**
 * Audits the latest current-season row for every upstream player identity before nullable internal
 * IDs are filtered out. An unmatched active player is part of the possible waiver universe, so a
 * release that silently omitted it could call a partial ranking complete.
 */
export function unmatchedCurrentFantasyPlayers(
  rows: readonly FirstPartyRosRosterUniverseRow[],
  season: number,
): readonly FirstPartyRosUnmatchedCandidate[] {
  const byExternalId = new Map<string, FirstPartyRosRosterUniverseRow[]>();
  for (const row of rows) {
    if (row.season !== season) continue;
    const externalPlayerId = row.externalPlayerId.trim();
    if (externalPlayerId.length === 0) continue;
    const current = byExternalId.get(externalPlayerId) ?? [];
    current.push(row);
    byExternalId.set(externalPlayerId, current);
  }

  const unmatched: FirstPartyRosUnmatchedCandidate[] = [];
  for (const [externalPlayerId, observations] of byExternalId) {
    const latestWeek = Math.max(...observations.map((row) => row.week));
    const latestEligible = observations.filter((row) => {
      if (row.week !== latestWeek) return false;
      const position = normalizePosition(row.position);
      const status = row.status?.trim().toUpperCase() ?? null;
      return (
        ["QB", "RB", "WR", "TE", "K"].includes(position) &&
        row.team.trim().length > 0 &&
        canonicalNflTeamCode(row.team).length > 0 &&
        status !== "CUT" &&
        status !== "RET"
      );
    });
    if (latestEligible.length === 0 || latestEligible.every((row) => row.playerId !== null)) {
      continue;
    }
    const positions = [
      ...new Set(
        latestEligible.map((row) => normalizePosition(row.position) as FirstPartyRosRailPosition),
      ),
    ].sort();
    unmatched.push({ externalPlayerId, positions });
  }
  return unmatched.sort((left, right) =>
    left.externalPlayerId.localeCompare(right.externalPlayerId),
  );
}

const ROS_ALIAS_POSITIONS = new Set<FirstPartyRosRailPosition>([
  "QB",
  "RB",
  "WR",
  "TE",
  "K",
  "DST",
]);
const ROS_ALIAS_EXTERNAL_SOURCES = [
  "espn-self-asserted",
  "espn",
  "yahoo",
  "sleeper-espn",
  "sleeper-yahoo",
] as const;
const ROS_ALIAS_QUERY_CHUNK_SIZE = 400;
const ROS_ALIAS_YAHOO_EVIDENCE_LIMIT = 50_000;
const NFL_TEAM_SET = new Set<string>(NFL_TEAMS);

export interface FirstPartyRosPlayerAliasIdentity {
  readonly playerId: string;
  readonly fullName: string;
  readonly position: string;
  readonly team: string | null;
  readonly gsisId?: string | null;
}

export interface FirstPartyRosPlayerAliasExternalId {
  readonly playerId: string;
  readonly source: string;
  readonly externalId: string;
}

/** A bounded one-hop closure; overflow must not discard already loaded explicit identities. */
export function firstPartyRosYahooEvidenceClosure(input: {
  readonly externalIds: readonly FirstPartyRosPlayerAliasExternalId[];
  readonly sourceRows: readonly FirstPartyRosPlayerAliasExternalId[];
}): {
  readonly complete: boolean;
  readonly externalIds: readonly FirstPartyRosPlayerAliasExternalId[];
} {
  if (
    input.sourceRows.length > ROS_ALIAS_YAHOO_EVIDENCE_LIMIT ||
    input.sourceRows.some((row) => row.source !== "yahoo" && row.source !== "sleeper-yahoo")
  ) {
    return { complete: false, externalIds: input.externalIds };
  }
  const requestedIds = new Set(
    input.externalIds.flatMap((row) => {
      if (row.source !== "yahoo" && row.source !== "sleeper-yahoo") return [];
      const id = providerPlayerCrosswalkId(row.source, row.externalId);
      return id === undefined ? [] : [id];
    }),
  );
  return {
    complete: true,
    externalIds: [
      ...input.externalIds,
      ...input.sourceRows.filter((row) => {
        const id = providerPlayerCrosswalkId(row.source, row.externalId);
        return id !== undefined && requestedIds.has(id);
      }),
    ],
  };
}

export interface FirstPartyRosPlayerAliasGsisEvidence {
  readonly playerId: string;
  readonly gsisId: string | null;
}

export interface FirstPartyRosPlayerAlias {
  readonly position: FirstPartyRosRailPosition;
  readonly team: string | null;
  readonly canonicalPlayerId: string;
  readonly playerId: string;
}

export interface FirstPartyRosPlayerAliasIssue {
  readonly position: FirstPartyRosRailPosition;
  readonly playerId: string;
  readonly code: string;
}

export interface FirstPartyRosPlayerAliasPlan {
  readonly aliases: readonly FirstPartyRosPlayerAlias[];
  readonly issues: readonly FirstPartyRosPlayerAliasIssue[];
}

function aliasPosition(value: string): FirstPartyRosRailPosition | undefined {
  const position = normalizePosition(value) as FirstPartyRosRailPosition;
  return ROS_ALIAS_POSITIONS.has(position) ? position : undefined;
}

function aliasTeam(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const team = canonicalNflTeamCode(value);
    return NFL_TEAM_SET.has(team) ? team : undefined;
  } catch {
    return undefined;
  }
}

function aliasIdentityKey(
  input: {
    readonly fullName: string;
    readonly position: FirstPartyRosRailPosition;
    readonly team: string;
  },
  withoutSuffix = false,
): string | undefined {
  const parts = playerNameIdentityParts(input.fullName);
  const name = withoutSuffix ? parts.base : parts.exact;
  return name ? `${name}|${input.team}|${input.position}` : undefined;
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function playerAliasIssueSort(
  left: FirstPartyRosPlayerAliasIssue,
  right: FirstPartyRosPlayerAliasIssue,
): number {
  return (
    left.position.localeCompare(right.position) ||
    left.playerId.localeCompare(right.playerId) ||
    left.code.localeCompare(right.code)
  );
}

function playerAliasSort(left: FirstPartyRosPlayerAlias, right: FirstPartyRosPlayerAlias): number {
  return (
    left.position.localeCompare(right.position) ||
    (left.team ?? "").localeCompare(right.team ?? "") ||
    left.canonicalPlayerId.localeCompare(right.canonicalPlayerId) ||
    left.playerId.localeCompare(right.playerId)
  );
}

/**
 * Resolves one league's latest roster identities against the canonical ROS candidate universe.
 * Direct candidate IDs win. Every other match must be unique, position-compatible,
 * team-compatible, and bijective; uncertainty becomes a position-scoped publication issue rather
 * than a guessed persistence identity.
 */
export function firstPartyRosPlayerAliasPlan(input: {
  readonly leagueSeasonId: string;
  readonly rosterPlayers: readonly FirstPartyRosPlayerAliasIdentity[];
  readonly canonicalPlayers: readonly FirstPartyRosPlayerAliasIdentity[];
  readonly externalIds?: readonly FirstPartyRosPlayerAliasExternalId[];
  /** All Yahoo source rows matching roster suffixes, including outside-pool targets, were read. */
  readonly yahooExternalEvidenceComplete?: boolean;
  readonly gsisEvidence?: readonly FirstPartyRosPlayerAliasGsisEvidence[];
  readonly initialIssues?: readonly FirstPartyRosPlayerAliasIssue[];
}): FirstPartyRosPlayerAliasPlan {
  type NormalizedIdentity = {
    readonly playerId: string;
    readonly fullName: string;
    readonly position: FirstPartyRosRailPosition;
    readonly team: string;
    readonly gsisId: string | null;
  };

  const issues: FirstPartyRosPlayerAliasIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (position: FirstPartyRosRailPosition, playerId: string, code: string): void => {
    const key = `${position}\0${playerId}\0${code}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ position, playerId, code });
  };
  for (const issue of input.initialIssues ?? []) {
    addIssue(issue.position, issue.playerId, issue.code);
  }

  const canonicalPlayers: NormalizedIdentity[] = [];
  for (const row of input.canonicalPlayers) {
    const position = aliasPosition(row.position);
    if (!position) continue;
    const team = aliasTeam(row.team);
    if (!team) continue;
    canonicalPlayers.push({
      playerId: row.playerId,
      fullName: row.fullName,
      position,
      team,
      gsisId: row.gsisId?.trim() || null,
    });
  }
  const canonicalById = new Map<string, NormalizedIdentity>();
  const duplicateCanonicalIds = new Set<string>();
  for (const candidate of canonicalPlayers) {
    if (canonicalById.has(candidate.playerId)) duplicateCanonicalIds.add(candidate.playerId);
    else canonicalById.set(candidate.playerId, candidate);
  }

  const canonicalIdsByGsis = new Map<string, Set<string>>();
  const canonicalIdsByDefenseTeam = new Map<string, Set<string>>();
  const canonicalIdsByExactIdentity = new Map<string, Set<string>>();
  const canonicalIdsByBaseIdentity = new Map<string, Set<string>>();
  for (const candidate of canonicalPlayers) {
    if (candidate.gsisId) addToSetMap(canonicalIdsByGsis, candidate.gsisId, candidate.playerId);
    if (candidate.position === "DST") {
      addToSetMap(canonicalIdsByDefenseTeam, candidate.team, candidate.playerId);
    }
    // Display-name fallback is permitted only against a canonical candidate with trusted GSIS.
    if (candidate.gsisId) {
      const key = aliasIdentityKey(candidate);
      if (key) addToSetMap(canonicalIdsByExactIdentity, key, candidate.playerId);
      const baseKey = aliasIdentityKey(candidate, true);
      if (baseKey) addToSetMap(canonicalIdsByBaseIdentity, baseKey, candidate.playerId);
    }
  }

  const externalIds = input.externalIds ?? [];
  const externalIdsByPlayer = new Map<string, FirstPartyRosPlayerAliasExternalId[]>();
  const canonicalIdsByExternalKey = new Map<string, Set<string>>();
  const yahooPlayerIdsByExternalKey = new Map<string, Set<string>>();
  const yahooIdsByPlayer = new Map<string, Set<string>>();
  const espnIdsByPlayer = new Map<string, Set<string>>();
  const invalidYahooPlayers = new Set<string>();
  for (const row of externalIds) {
    const externalId = row.externalId.trim();
    const isYahoo = row.source === "yahoo" || row.source === "sleeper-yahoo";
    const yahooId = isYahoo ? providerPlayerCrosswalkId(row.source, externalId) : undefined;
    if (row.source === "espn" || row.source === "sleeper-espn") {
      const espnId = providerPlayerCrosswalkId(row.source, externalId);
      if (espnId) addToSetMap(espnIdsByPlayer, row.playerId, espnId);
    } else if (
      row.source === "espn-self-asserted" &&
      espnSelfAssertedProjectionLeague(externalId) === input.leagueSeasonId.toLowerCase()
    ) {
      addToSetMap(espnIdsByPlayer, row.playerId, externalId.slice(externalId.indexOf(":") + 1));
    }
    if (isYahoo) {
      if (yahooId === undefined) invalidYahooPlayers.add(row.playerId);
      else {
        addToSetMap(yahooIdsByPlayer, row.playerId, yahooId);
        // Keep known bridges outside the candidate pool: their absence from today's pool does
        // not authorize a different name match. The loader closes this one-hop evidence set.
        if (row.source === "sleeper-yahoo" || canonicalById.has(row.playerId)) {
          addToSetMap(yahooPlayerIdsByExternalKey, `${row.source}:${yahooId}`, row.playerId);
        }
      }
    }
    if (!externalId) continue;
    const rows = externalIdsByPlayer.get(row.playerId) ?? [];
    rows.push({ ...row, externalId });
    externalIdsByPlayer.set(row.playerId, rows);
    const crosswalkId =
      row.source === "espn-self-asserted"
        ? externalId
        : providerPlayerCrosswalkId(row.source, externalId);
    if (canonicalById.has(row.playerId) && crosswalkId !== undefined) {
      addToSetMap(canonicalIdsByExternalKey, `${row.source}:${crosswalkId}`, row.playerId);
    }
  }
  const gsisByPlayer = new Map<string, Set<string>>();
  for (const row of input.gsisEvidence ?? []) {
    const gsisId = row.gsisId?.trim();
    if (gsisId) addToSetMap(gsisByPlayer, row.playerId, gsisId);
  }

  const rosterRowsByPlayer = new Map<string, NormalizedIdentity[]>();
  for (const row of input.rosterPlayers) {
    const position = aliasPosition(row.position);
    if (!position) continue;
    const team = aliasTeam(row.team);
    if (!team) {
      addIssue(position, row.playerId, "team-missing-or-invalid");
      continue;
    }
    const rows = rosterRowsByPlayer.get(row.playerId) ?? [];
    rows.push({
      playerId: row.playerId,
      fullName: row.fullName,
      position,
      team,
      gsisId: row.gsisId?.trim() || null,
    });
    rosterRowsByPlayer.set(row.playerId, rows);
  }

  const resolved = new Map<string, { row: NormalizedIdentity; canonicalPlayerId: string }>();
  const orderedRosterIds = [...rosterRowsByPlayer.keys()].sort();
  for (const playerId of orderedRosterIds) {
    const observations = rosterRowsByPlayer.get(playerId)!;
    const signatures = new Set(
      observations.map((row) => `${row.position}|${row.team}|${row.gsisId ?? ""}`),
    );
    if (signatures.size !== 1) {
      for (const row of observations) addIssue(row.position, playerId, "roster-facts-conflict");
      continue;
    }
    const row = observations[0]!;
    const compatible = (candidate: NormalizedIdentity): boolean =>
      candidate.position === row.position && candidate.team === row.team;

    // A canonical ID already present on the league roster is authoritative. Lower-priority
    // crosswalk/name evidence must never re-key it to a different player.
    const direct = canonicalById.get(playerId);
    if (direct && duplicateCanonicalIds.has(playerId)) {
      addIssue(row.position, playerId, "identity-ambiguous");
      continue;
    }
    if (direct) {
      if (!compatible(direct)) addIssue(row.position, playerId, "direct-identity-incompatible");
      else resolved.set(playerId, { row, canonicalPlayerId: direct.playerId });
      continue;
    }

    if (row.position === "DST") {
      const defenseCandidates = canonicalIdsByDefenseTeam.get(row.team) ?? new Set<string>();
      if (defenseCandidates.size === 0) {
        addIssue(row.position, playerId, "identity-unresolved");
      } else if (defenseCandidates.size > 1) {
        addIssue(row.position, playerId, "identity-ambiguous");
      } else {
        resolved.set(playerId, { row, canonicalPlayerId: [...defenseCandidates][0]! });
      }
      continue;
    }

    const evidence = new Set<string>();
    const observedGsisIds = new Set<string>([
      ...(row.gsisId ? [row.gsisId] : []),
      ...(gsisByPlayer.get(playerId) ?? []),
    ]);
    const observedYahooIds = yahooIdsByPlayer.get(playerId) ?? new Set<string>();
    let ambiguousEvidence = observedGsisIds.size > 1 || observedYahooIds.size > 1;
    let strongerFactPresent = observedGsisIds.size > 0;
    const collect = (candidateIds: ReadonlySet<string> | undefined): void => {
      if (!candidateIds || candidateIds.size === 0) return;
      if (candidateIds.size > 1) ambiguousEvidence = true;
      for (const candidateId of candidateIds) evidence.add(candidateId);
    };
    for (const gsisId of observedGsisIds) {
      collect(canonicalIdsByGsis.get(gsisId));
    }
    for (const external of externalIdsByPlayer.get(playerId) ?? []) {
      const pairedSource =
        external.source === "espn"
          ? "sleeper-espn"
          : external.source === "sleeper-espn"
            ? "espn"
            : external.source === "yahoo"
              ? "sleeper-yahoo"
              : external.source === "sleeper-yahoo"
                ? "yahoo"
                : undefined;
      if (pairedSource) {
        const crosswalkId = providerPlayerCrosswalkId(external.source, external.externalId);
        if (external.source === "yahoo" || external.source === "sleeper-yahoo") {
          const matches =
            crosswalkId === undefined
              ? undefined
              : yahooPlayerIdsByExternalKey.get(`${pairedSource}:${crosswalkId}`);
          // An opaque, valid Yahoo ID without a bridge is not contradictory identity evidence.
          // Permit the existing exact fallback only after the outside-pool lookup is complete.
          if (crosswalkId === undefined || !input.yahooExternalEvidenceComplete || matches?.size) {
            strongerFactPresent = true;
          }
          collect(matches);
        } else {
          strongerFactPresent = true;
          if (crosswalkId !== undefined) {
            collect(canonicalIdsByExternalKey.get(`${pairedSource}:${crosswalkId}`));
          }
        }
      }
      if (
        external.source === "espn-self-asserted" &&
        espnSelfAssertedProjectionLeague(external.externalId) === input.leagueSeasonId.toLowerCase()
      ) {
        const providerPlayerId = external.externalId.slice(external.externalId.indexOf(":") + 1);
        collect(canonicalIdsByExternalKey.get(`sleeper-espn:${providerPlayerId}`));
        // A league-local self assertion alone is not a verified canonical identity. If neither
        // crosswalk exists, the trusted-GSIS exact identity fallback remains eligible.
        // Older ESPN syncs can have the direct provider row without a Sleeper crosswalk.
        collect(canonicalIdsByExternalKey.get(`espn:${providerPlayerId}`));
      }
    }

    // Exact NFKC name + canonical team + effective fantasy position is deliberately last and is
    // only eligible when the canonical side has trusted GSIS identity.
    if (
      evidence.size === 0 &&
      !ambiguousEvidence &&
      !strongerFactPresent &&
      !invalidYahooPlayers.has(playerId)
    ) {
      const exactKey = aliasIdentityKey(row);
      const exactMatches = exactKey ? canonicalIdsByExactIdentity.get(exactKey) : undefined;
      const baseKey = aliasIdentityKey(row, true);
      // Broaden Yahoo names only after its outside-pool bridge lookup is complete. ESPN's
      // scoped assertion fallback remains exact until equivalent evidence closure is available.
      const suffixMatches =
        exactMatches === undefined &&
        observedYahooIds.size === 1 &&
        input.yahooExternalEvidenceComplete &&
        !espnIdsByPlayer.has(playerId) &&
        baseKey
          ? canonicalIdsByBaseIdentity.get(baseKey)
          : undefined;
      const nameMatches = exactMatches ?? suffixMatches;
      // Do not prune an ambiguous name cohort into an apparently unique match. A single exact
      // candidate's own Yahoo facts may veto this fallback but may never select among names.
      const exactCandidateId = nameMatches?.size === 1 ? [...nameMatches][0]! : undefined;
      const candidateYahooIds = exactCandidateId
        ? yahooIdsByPlayer.get(exactCandidateId)
        : undefined;
      const candidateYahooConflict =
        observedYahooIds.size > 0 &&
        exactCandidateId !== undefined &&
        (invalidYahooPlayers.has(exactCandidateId) ||
          [...(candidateYahooIds ?? [])].some((id) => !observedYahooIds.has(id)));
      const observedEspnIds = espnIdsByPlayer.get(playerId);
      const candidateEspnIds = exactCandidateId ? espnIdsByPlayer.get(exactCandidateId) : undefined;
      const candidateEspnConflict =
        (observedEspnIds?.size ?? 0) > 1 ||
        (candidateEspnIds?.size ?? 0) > 1 ||
        (observedEspnIds?.size === 1 &&
          candidateEspnIds?.size === 1 &&
          !candidateEspnIds.has([...observedEspnIds][0]!));
      const suffixConflict =
        suffixMatches !== undefined &&
        exactCandidateId !== undefined &&
        !playerNameIdentitiesCompatible(
          playerNameIdentityParts(row.fullName),
          playerNameIdentityParts(canonicalById.get(exactCandidateId)!.fullName),
        );
      if (!candidateYahooConflict && !candidateEspnConflict && !suffixConflict)
        collect(nameMatches);
    }
    if (invalidYahooPlayers.has(playerId)) {
      addIssue(row.position, playerId, "identity-unresolved");
      continue;
    }
    if (ambiguousEvidence) {
      addIssue(row.position, playerId, "identity-ambiguous");
      continue;
    }
    if (evidence.size > 1) {
      addIssue(row.position, playerId, "identity-evidence-conflict");
      continue;
    }
    if (evidence.size === 0) {
      addIssue(row.position, playerId, "identity-unresolved");
      continue;
    }
    const canonicalPlayerId = [...evidence][0]!;
    const canonical = canonicalById.get(canonicalPlayerId);
    if (duplicateCanonicalIds.has(canonicalPlayerId)) {
      addIssue(row.position, playerId, "identity-ambiguous");
      continue;
    }
    if (!canonical || !compatible(canonical)) {
      addIssue(row.position, playerId, "identity-incompatible");
      continue;
    }
    resolved.set(playerId, { row, canonicalPlayerId });
  }

  // Persistence is one-to-one. A duplicate provider row for a canonical player makes the entire
  // applicable position incomplete, including when one of the rows already used the direct ID.
  const rosterIdsByCanonical = new Map<string, string[]>();
  for (const [playerId, match] of resolved) {
    const ids = rosterIdsByCanonical.get(match.canonicalPlayerId) ?? [];
    ids.push(playerId);
    rosterIdsByCanonical.set(match.canonicalPlayerId, ids);
  }
  for (const playerIds of rosterIdsByCanonical.values()) {
    if (playerIds.length < 2) continue;
    for (const playerId of playerIds) {
      const match = resolved.get(playerId)!;
      addIssue(match.row.position, playerId, "canonical-identity-not-bijective");
      resolved.delete(playerId);
    }
  }

  const aliases = [...resolved]
    .flatMap(([playerId, match]): FirstPartyRosPlayerAlias[] =>
      playerId === match.canonicalPlayerId
        ? []
        : [
            {
              position: match.row.position,
              team: match.row.team,
              canonicalPlayerId: match.canonicalPlayerId,
              playerId,
            },
          ],
    )
    .sort(playerAliasSort);
  return { aliases, issues: issues.sort(playerAliasIssueSort) };
}

/** Re-keys only league persistence IDs; simulation payloads and provenance remain canonical. */
export function applyFirstPartyRosPlayerAliases(
  target: FirstPartyRosPublicationTarget,
  plan: FirstPartyRosPlayerAliasPlan,
): FirstPartyRosPublicationTarget {
  const expectedPositions = new Set(target.candidateUniverse.expectedPositions);
  const releasedIds = new Set(target.released.map((player) => player.playerId));
  const aliases = plan.aliases.filter(
    (alias) => expectedPositions.has(alias.position) && releasedIds.has(alias.canonicalPlayerId),
  );
  const issues = plan.issues.filter((issue) => expectedPositions.has(issue.position));
  const aliasByCanonicalId = new Map(aliases.map((alias) => [alias.canonicalPlayerId, alias]));
  return {
    ...target,
    candidateUniverse: {
      ...target.candidateUniverse,
      playerAliases: aliases,
      playerAliasIssues: issues,
      complete: target.candidateUniverse.complete && issues.length === 0,
    },
    released: target.released.map((player) => {
      const alias = aliasByCanonicalId.get(player.playerId);
      return alias
        ? {
            ...player,
            playerId: alias.playerId,
            // `projection.playerId` and every seed/checksum remain the canonical simulation ID.
          }
        : player;
    }),
  };
}

export interface FirstPartyRosLeagueTargetResult {
  readonly target: FirstPartyRosPublicationTarget | null;
  /** Players skipped for a missing/ambiguous per-player piece (no approximation was substituted). */
  readonly skippedPlayers: number;
  /** Set when the whole league yields nothing (a league-wide piece was missing). */
  readonly leagueReason?: string;
}

interface AcceptedCandidate {
  readonly candidate: FirstPartyRosCandidate;
  readonly assembled: FirstPartyRosAssembledCandidateInputs;
  readonly released: FirstPartyRosReleasedPlayer;
}

/**
 * Builds one league-scoped publication target from database-derived observations, mirroring the
 * weekly service's assembly semantics. Every future-week center comes from the tested candidate
 * builder; a player missing any usable piece is skipped and audited (never approximated), and a
 * league that produces no releasable candidate yields no target so the rail stays fail-closed.
 */
export interface FirstPartyRosLeagueTargetInput {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly leagueSeasonId: string;
  readonly scoringProfile: ProjectionScoringProfile;
  /** Only these positions may become candidates; every other one is withheld before simulation. */
  readonly matchedPositions: readonly FirstPartyRosRailPosition[];
  /** Carried onto the target so publication can re-derive the match rather than trust it. */
  readonly supportedPositions: readonly FirstPartyRosRailPosition[];
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly candidatePlayers: readonly FirstPartyRosCandidatePlayer[];
  /** Current releasable upstream identities with no safe internal player match. */
  readonly unmatchedCandidateCount: number;
  readonly unmatchedCandidates?: readonly FirstPartyRosUnmatchedCandidate[];
  readonly featureHistory: readonly FirstPartyWeeklyStatLine[];
  readonly calibration: FirstPartyProjectionCalibration;
  readonly defenseFeatureHistory: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly defenseCalibration: FirstPartyTeamDefenseCalibration;
  readonly availabilityCalibration: HistoricalRosAvailabilityCalibration;
  readonly roleCalibration: HistoricalRosRoleCalibration;
  readonly kickerCalibration: HistoricalRosKickerCalibration;
  readonly injuries: readonly ProjectionInjuryFact[];
  readonly schedules: readonly ProjectionScheduleFact[];
  readonly futureWindowComplete: boolean;
  readonly sourceAsOf: Date;
  /** Actual live refresh cutoff; never the historical replay helper's preseason fallback. */
  readonly asOfAt: Date;
  /**
   * Downscales the release simulation. Production never sets it, so the engine default decides.
   * A caller that downscales the release run must downscale its reference too — an unpaired
   * override is exactly the half-specified scenario contract this rail was fixed for.
   */
  readonly scenarioCount?: number;
  readonly convergenceReferenceScenarioCount?: number;
}

export type FirstPartyRosLeagueTargetBuilder = (
  input: FirstPartyRosLeagueTargetInput,
) => FirstPartyRosLeagueTargetResult | Promise<FirstPartyRosLeagueTargetResult>;

/** Both drivers execute the same assembly and release checks; only outcome I/O differs. */
export function buildFirstPartyRosLeagueTarget(
  input: FirstPartyRosLeagueTargetInput,
  project: FirstPartyRosLiveProjector = projectFirstPartyRestOfSeason,
): FirstPartyRosLeagueTargetResult {
  const steps = firstPartyRosLeagueTargetSteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next(project(step.value));
  return step.value;
}

export async function buildFirstPartyRosLeagueTargetAsync(
  input: FirstPartyRosLeagueTargetInput,
  project: (input: FirstPartyRosProjectionInput) => Promise<FirstPartyRosLiveProjection>,
): Promise<FirstPartyRosLeagueTargetResult> {
  const steps = firstPartyRosLeagueTargetSteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next(await project(step.value));
  return step.value;
}

function* simulateCandidateSteps(
  assembled: FirstPartyRosAssembledCandidateInputs,
): Generator<FirstPartyRosProjectionInput, FirstPartyRosCandidate, FirstPartyRosLiveProjection> {
  const contextual = yield assembled.contextualInput;
  const recency = yield assembled.recencyInput;
  return simulateFirstPartyRosCandidate(assembled, (input) =>
    input.strategy === "contextual" ? contextual : recency,
  );
}

function* firstPartyRosLeagueTargetSteps(
  input: FirstPartyRosLeagueTargetInput,
): Generator<
  FirstPartyRosProjectionInput,
  FirstPartyRosLeagueTargetResult,
  FirstPartyRosLiveProjection
> {
  const convergenceCounts = validateFirstPartyRosLiveConvergenceCounts({
    ...(input.scenarioCount === undefined ? {} : { releaseScenarioCount: input.scenarioCount }),
    ...(input.convergenceReferenceScenarioCount === undefined
      ? {}
      : { referenceScenarioCount: input.convergenceReferenceScenarioCount }),
  });
  const scoringProfileKey = projectionScoringProfileKey(input.scoringProfile);
  const window = {
    season: input.season,
    asOfWeek: input.window.asOfWeek,
    windowStartWeek: input.window.windowStartWeek,
    windowEndWeek: input.window.windowEndWeek,
  } as const;

  let skippedPlayers = input.unmatchedCandidateCount;
  const skippedCandidates: {
    playerId: string | null;
    externalPlayerId: string | null;
    position: string;
    reason: string;
  }[] = (input.unmatchedCandidates ?? []).slice(0, 20).map((candidate) => ({
    playerId: null,
    externalPlayerId: candidate.externalPlayerId,
    position: candidate.positions.join("|"),
    reason: "identity-unresolved",
  }));
  const skip = (player: FirstPartyRosCandidatePlayer, reason: string) => {
    skippedPlayers += 1;
    if (skippedCandidates.length < 20)
      skippedCandidates.push({
        playerId: player.playerId,
        externalPlayerId: null,
        position: player.position,
        reason,
      });
  };
  let expectedPlayers = input.unmatchedCandidateCount;
  const accepted: AcceptedCandidate[] = [];
  const seenPlayers = new Set<string>();
  // A position the artifact does not authorize for this league never becomes a candidate, so it is
  // withheld structurally rather than filtered out later; it is not an audited per-player skip
  // because nothing about the player was missing.
  const releasablePositions = new Set<string>(input.matchedPositions);
  // This target owns one pinned history snapshot. Reuse its prior-season fit locally, including
  // an insufficient-history result, without assuming caller-owned array identities are immutable.
  let defenseGameCalibration: ReturnType<typeof fitFirstPartyDefenseGameCalibration> | undefined;
  for (const player of input.candidatePlayers) {
    const position = normalizePosition(player.position);
    if (!releasablePositions.has(position) || player.team === null) continue;
    if (seenPlayers.has(player.playerId)) continue;
    seenPlayers.add(player.playerId);
    expectedPlayers += 1;

    if (position === "DST") {
      defenseGameCalibration ??= fitFirstPartyDefenseGameCalibration(
        input.defenseFeatureHistory,
        input.season,
      );
      const assembled = assembleFirstPartyRosDefenseCandidateInputs({
        defense: { playerId: player.playerId, team: player.team },
        window,
        featureHistory: input.defenseFeatureHistory,
        calibration: input.defenseCalibration,
        preparedGameCalibration: defenseGameCalibration,
        schedules: input.schedules,
        scoringProfile: input.scoringProfile,
        seed: `live-ros-football:${input.season}:${window.asOfWeek}:${player.playerId}`,
        asOfAt: input.asOfAt.toISOString(),
        ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
      });
      if (assembled === null) {
        skip(player, "candidate-inputs-unavailable");
        continue;
      }
      const candidate = yield* simulateCandidateSteps(assembled);
      const choice = input.artifact.policy.choices.find(
        (candidate_) =>
          candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
      );
      if (choice === undefined) {
        skip(player, "champion-choice-missing");
        continue;
      }
      const projection =
        choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
      if (projection.state !== "projected" || projection.expectedGames <= 0) {
        skip(
          player,
          projection.state !== "projected" ? "projection-unavailable" : "no-expected-games",
        );
        continue;
      }
      accepted.push({
        candidate,
        assembled,
        released: {
          playerId: player.playerId,
          bucket: candidate.bucket,
          strategy: choice.strategy,
          projection,
        },
      });
      continue;
    }

    const builderInput = {
      player: {
        playerId: player.playerId,
        position: position as FirstPartyProjectionPosition,
        team: player.team,
        ...(player.rosterStatus === undefined ? {} : { rosterStatus: player.rosterStatus }),
      },
      window,
      featureHistory: input.featureHistory,
      calibration: input.calibration,
      availabilityCalibration: input.availabilityCalibration,
      roleCalibration: input.roleCalibration,
      kickerCalibration: input.kickerCalibration,
      injuries: input.injuries,
      schedules: input.schedules,
      scoringProfile: input.scoringProfile,
      seed: `live-ros-football:${input.season}:${window.asOfWeek}:${player.playerId}`,
      asOfAt: input.asOfAt.toISOString(),
      ...(input.scenarioCount === undefined ? {} : { scenarioCount: input.scenarioCount }),
    };

    // Assembled ONCE per player and reused for the simulation, the bucket evidence, and the bucket
    // convergence diagnostic. Assembly re-projects every remaining week's weekly centers, and the
    // pipeline previously performed it twice for every accepted player.
    const assembled = assembleFirstPartyRosCandidateInputs(builderInput);
    if (assembled === null) {
      skip(player, "candidate-inputs-unavailable");
      continue;
    }
    const candidate = yield* simulateCandidateSteps(assembled);
    // The champion policy authorizes exactly one strategy per position/bucket; without a matching
    // choice the player cannot be released (no default, no approximation).
    const choice = input.artifact.policy.choices.find(
      (candidate_) =>
        candidate_.position === candidate.position && candidate_.bucket === candidate.bucket,
    );
    if (choice === undefined) {
      skip(player, "champion-choice-missing");
      continue;
    }
    const projection = choice.strategy === "contextual" ? candidate.contextual : candidate.recency;
    if (projection.state !== "projected" || projection.expectedGames <= 0) {
      skip(
        player,
        projection.state !== "projected" ? "projection-unavailable" : "no-expected-games",
      );
      continue;
    }
    accepted.push({
      candidate,
      assembled,
      released: {
        playerId: player.playerId,
        bucket: candidate.bucket,
        strategy: choice.strategy,
        projection,
      },
    });
  }

  if (accepted.length === 0) {
    return { target: null, skippedPlayers, leagueReason: "no_releasable_candidates" };
  }

  const byBucket = new Map<string, AcceptedCandidate[]>();
  for (const entry of accepted) {
    const key = `${entry.candidate.position}:${entry.candidate.bucket}`;
    const rows = byBucket.get(key) ?? [];
    rows.push(entry);
    byBucket.set(key, rows);
  }

  const evidence: FirstPartyRosLiveReleaseEvidence[] = [];
  const bucketConvergences: FirstPartyRosRunConvergence[] = [];
  for (const rows of byBucket.values()) {
    const ordered = [...rows].sort((left, right) =>
      left.released.playerId.localeCompare(right.released.playerId),
    );
    const representative = ordered[0]!;
    // The representative's release runs are already simulated at exactly this path count, so the
    // diagnostic compares that run against the larger reference instead of re-simulating it. The
    // diagnostic verifies provenance before accepting the reuse.
    const scenarioOverrides = {
      releaseScenarioCount: convergenceCounts.lower,
      referenceScenarioCount: convergenceCounts.reference,
    };
    const referenceScenarioCount = convergenceCounts.reference;
    const contextualReference = yield {
      ...representative.assembled.contextualInput,
      scenarioCount: referenceScenarioCount,
    };
    const contextualConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.contextualInput,
      releaseProjection: representative.candidate.contextual,
      ...scenarioOverrides,
      project: () => contextualReference,
    });
    const recencyReference = yield {
      ...representative.assembled.recencyInput,
      scenarioCount: referenceScenarioCount,
    };
    const recencyConvergence = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: representative.assembled.recencyInput,
      releaseProjection: representative.candidate.recency,
      ...scenarioOverrides,
      project: () => recencyReference,
    });
    const pointOnly = input.artifact.policyVersion === FIRST_PARTY_ROS_POINT_POLICY_VERSION;
    if (pointOnly && (!contextualConvergence.fullDiagnostic || !recencyConvergence.fullDiagnostic))
      throw new Error("Point ROS requires the standard complete convergence evidence");
    const pointConvergence = pointOnly
      ? {
          contextual: contextualConvergence.fullDiagnostic!,
          recency: recencyConvergence.fullDiagnostic!,
        }
      : undefined;
    const selectedConvergence =
      representative.released.strategy === "contextual"
        ? contextualConvergence
        : recencyConvergence;
    bucketConvergences.push(
      pointOnly
        ? extractFirstPartyRosPointConvergence({
            position: representative.candidate.position,
            scoringProfileKey,
            diagnostic: selectedConvergence.fullDiagnostic!,
          })
        : selectedConvergence,
    );
    const meanCoverage = {
      contextual:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.contextual, 0) /
        ordered.length,
      recency:
        ordered.reduce((sum, entry) => sum + entry.candidate.coverage.recency, 0) / ordered.length,
    };
    evidence.push({
      ...buildFirstPartyRosLiveReleaseEvidence({
        position: representative.candidate.position,
        bucket: representative.candidate.bucket,
        contextualModelVersion: representative.candidate.contextualModelVersion,
        recencyModelVersion: representative.candidate.recencyModelVersion,
        scoringProfileKey,
        intervalMethodVersion: representative.candidate.intervalMethodVersion,
        inputChecksum: aggregateChecksum(
          "live-ros-bucket-evidence-v1",
          ordered.map((entry) => entry.candidate.inputChecksum),
        ),
        representative: {
          scheduledGames: representative.candidate.scheduledGames,
          contextualExpectedGames: representative.candidate.contextual.expectedGames,
          recencyExpectedGames: representative.candidate.recency.expectedGames,
        },
        meanCoverage,
        convergence: {
          contextual: {
            state: contextualConvergence.state,
            diagnosticChecksum: contextualConvergence.diagnosticChecksum,
          },
          recency: {
            state: recencyConvergence.state,
            diagnosticChecksum: recencyConvergence.diagnosticChecksum,
          },
        },
      }),
      ...(pointConvergence === undefined ? {} : { pointConvergence }),
    });
  }

  // The run summary follows each bucket's selected strategy. Both candidates remain in the
  // per-cell evidence above; an unselected strategy cannot replace the released one's diagnostic.
  const runConvergence = bucketConvergences.reduce((worst, candidate) =>
    candidate.maxToleranceRatio > worst.maxToleranceRatio ? candidate : worst,
  );
  const evaluatedPositions = [
    ...new Set(evidence.map((entry) => entry.position)),
  ].sort() as FirstPartyRosRailPosition[];
  const expectedPositions = [...input.matchedPositions].sort();
  const candidateUniverseComplete =
    skippedPlayers === 0 &&
    expectedPlayers === accepted.length &&
    expectedPositions.every((position) => evaluatedPositions.includes(position));

  return {
    target: {
      leagueSeasonId: input.leagueSeasonId,
      leagueScoringProfileKey: scoringProfileKey,
      leagueScoringProfile: input.scoringProfile,
      supportedPositions: input.supportedPositions,
      candidateUniverse: {
        expectedPlayerCount: expectedPlayers,
        evaluatedPlayerCount: accepted.length,
        skippedPlayerCount: skippedPlayers,
        skippedCandidates,
        skippedCandidatesTruncated: skippedPlayers > skippedCandidates.length,
        expectedPositions,
        evaluatedPositions,
        playerAliases: [],
        playerAliasIssues: [],
        complete: candidateUniverseComplete,
      },
      futureWindowComplete: input.futureWindowComplete,
      evidence,
      convergence: runConvergence,
      released: accepted.map((entry) => entry.released),
      sourceAsOf: input.sourceAsOf,
    },
    skippedPlayers,
  };
}

/**
 * The production candidate provider. It loads the immutable weekly observations already pinned in
 * PostgreSQL, assembles the same inputs the weekly service uses, calibrates availability/role from
 * seasons strictly before the current one, and hands every future-week center to the tested
 * candidate builder. A league is matched against the artifact one position at a time: only the
 * positions whose scoped scoring keys equal the artifact's — and that the league's own normalization
 * supports — produce candidates. A league that matches no position, or that cannot be fully
 * assembled, yields no target.
 */
type RosReadDatabase = Pick<Database, "select" | "selectDistinctOn">;

/** Fits the live player processes from the same locked weekly residuals as historical validation. */
export function calibrateFirstPartyRosPlayerHistory(input: {
  readonly trainingHistory: readonly FirstPartyWeeklyStatLine[];
  readonly schedules: readonly ProjectionScheduleFact[];
}): {
  readonly weekly: FirstPartyProjectionCalibration;
  readonly availability: HistoricalRosAvailabilityCalibration;
  readonly role: HistoricalRosRoleCalibration;
  readonly kicker: HistoricalRosKickerCalibration;
} {
  const weeklyBacktest = runFirstPartyProjectionBacktest(input.trainingHistory);
  return {
    weekly: weeklyBacktest.calibration,
    availability: calibrateHistoricalRosAvailability(input.trainingHistory, input.schedules),
    role: calibrateHistoricalRosRole(
      input.trainingHistory,
      input.schedules,
      weeklyBacktest.predictions,
    ),
    kicker: calibrateHistoricalRosKicker(
      input.trainingHistory,
      input.schedules,
      weeklyBacktest.predictions,
    ),
  };
}

interface FirstPartyRosRefreshReuse {
  calibration?: {
    readonly player: ReturnType<typeof calibrateFirstPartyRosPlayerHistory>;
    readonly defenseByDefinition: Readonly<
      Record<ProjectionDefensePointsAllowedDefinition, FirstPartyTeamDefenseCalibration>
    >;
  };
  project?: ReturnType<typeof createRosLiveProjectionReuse>;
}

export function databaseFirstPartyRosCandidateProvider(input: {
  readonly database: Database;
  /** Separate durable LIVE namespace. Historical evidence is never stored or pruned here. */
  readonly liveCacheDirectory?: string;
  readonly onLiveReuse?: (event: {
    readonly kind: "calibration-hit" | "calibration-fit" | "target-hit" | "target-build";
    readonly physicalIdentity: string;
  }) => void;
  /** Called after all reads are materialized and the database transaction has closed. */
  readonly onSnapshotReady?: () => void;
  readonly scenarioCount?: number;
  readonly convergenceReferenceScenarioCount?: number;
  /**
   * Production offloads the CPU-bound league simulation to a worker thread. Tests and small
   * fixtures keep the direct deterministic builder unless they explicitly provide an override.
   */
  readonly buildLeagueTarget?: FirstPartyRosLeagueTargetBuilder;
}): FirstPartyRosCandidateProvider & {
  buildTargetBatch(
    context: FirstPartyRosCandidateContext,
  ): Promise<Readonly<Record<string, readonly FirstPartyRosPublicationTarget[]>>>;
} {
  const resolveSourceSnapshot = async (
    database: RosReadDatabase,
    sourceInput: { readonly season: number; readonly window: FirstPartyRosWindow },
  ): Promise<{
    readonly checksum: string;
    readonly aliasPlans: ReadonlyMap<string, FirstPartyRosPlayerAliasPlan>;
  }> => {
    const { season, window } = sourceInput;
    const sourceKeys = firstPartyRosCandidateSourceKeys(season);
    const sources = await pinnedSourceChecksums(database, sourceKeys);
    const [leagueRows, scoringRuleRows, candidatePlayers, historyCatalogChecksum] =
      await Promise.all([
        database
          .select({ id: leagueSeasons.id, provider: leagueSeasons.provider })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.season, season)),
        database
          .select({
            leagueSeasonId: scoringRules.leagueSeasonId,
            statKey: scoringRules.statKey,
            providerStatId: scoringRules.providerStatId,
            operation: scoringRules.operation,
            points: scoringRules.points,
            thresholdLow: scoringRules.thresholdLow,
            thresholdHigh: scoringRules.thresholdHigh,
            positionTypes: scoringRules.positionTypes,
          })
          .from(scoringRules)
          .innerJoin(leagueSeasons, eq(leagueSeasons.id, scoringRules.leagueSeasonId))
          .where(eq(leagueSeasons.season, season)),
        currentAliasCandidatePoolForChecksum(database, season, sources),
        readRosHistoryCatalogRolesChecksum(database, projectionHistorySeasons(season), sources),
      ]);
    const aliasPlans = await latestLeaguePlayerAliasPlans(
      database,
      leagueRows.map((league) => league.id),
      candidatePlayers,
      sources.get("sleeper.players")?.id,
    );
    return {
      aliasPlans,
      checksum: aggregateChecksum("live-ros-candidate-provider-v8", [
        `player-history:${FIRST_PARTY_PLAYER_HISTORY_VERSION}`,
        `defense-history:${FIRST_PARTY_DEFENSE_HISTORY_VERSION}`,
        `scoring-normalization:${LEAGUE_SCORING_NORMALIZATION_VERSION}`,
        `live-physical:${ROS_LIVE_PHYSICAL_IDENTITY_VERSION}`,
        `live-outcomes:${ROS_LIVE_OUTCOME_VERSION}`,
        `season:${season}`,
        `window:${window.windowStartWeek}-${window.windowEndWeek}:asof-${window.asOfWeek}`,
        `scenario-count:${input.scenarioCount ?? "default"}`,
        `reference-scenario-count:${input.convergenceReferenceScenarioCount ?? "default"}`,
        `league-scoring:${sha256(
          JSON.stringify({
            leagues: [...leagueRows].sort(
              (left, right) =>
                left.id.localeCompare(right.id) || left.provider.localeCompare(right.provider),
            ),
            rules: [...scoringRuleRows].sort(
              (left, right) =>
                left.leagueSeasonId.localeCompare(right.leagueSeasonId) ||
                left.statKey.localeCompare(right.statKey) ||
                (left.providerStatId ?? "").localeCompare(right.providerStatId ?? "") ||
                left.operation.localeCompare(right.operation) ||
                left.points.localeCompare(right.points) ||
                (left.thresholdLow ?? "").localeCompare(right.thresholdLow ?? "") ||
                (left.thresholdHigh ?? "").localeCompare(right.thresholdHigh ?? ""),
            ),
          }),
        )}`,
        `player-alias-plans:${firstPartyRosPlayerAliasPlansChecksum(aliasPlans)}`,
        `history-catalog-roles:${historyCatalogChecksum}`,
        ...sourceKeys.map((key) => `${key}:${sources.get(key)?.checksum ?? "missing"}`),
      ]),
    };
  };
  const snapshotConfig = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
  const prepareBatch = async (
    context: FirstPartyRosCandidateContext,
    artifacts: readonly LoadedFirstPartyRosChampionArtifact[],
  ) => {
    // All profiles consume one captured fact set. A later feed refresh belongs to the next job,
    // including when it lands between two artifacts' long simulations.
    const simulate = await input.database.transaction(async (transaction) => {
      const snapshot = await resolveSourceSnapshot(transaction, context);
      if (snapshot.checksum !== context.candidateProviderChecksum)
        throw new Error("ROS candidate-provider inputs changed before target assembly");
      return prepareDatabaseFirstPartyRosTargets(
        {
          ...input,
          database: transaction,
          pinnedAliasPlans: snapshot.aliasPlans,
          reuse: {},
          buildArtifacts: artifacts,
        },
        context,
      );
    }, snapshotConfig);
    input.onSnapshotReady?.();
    return simulate();
  };
  return {
    sourceChecksum: ({ season, window }) =>
      input.database.transaction(
        async (transaction) =>
          (await resolveSourceSnapshot(transaction, { season, window })).checksum,
        snapshotConfig,
      ),
    buildTargets: async (context) => {
      const result = await prepareBatch(context, [context.artifact]);
      return result[context.artifact.artifactChecksum] ?? [];
    },
    buildTargetBatch: (context) =>
      prepareBatch(context, context.artifacts.filter(firstPartyRosChampionArtifactIsValid)),
  };
}

export function firstPartyRosCandidateSourceKeys(season: number): readonly string[] {
  const seasons = projectionHistorySeasons(season);
  const completedSeasons = seasons.filter((candidate) => candidate < season);
  return [
    ...seasons.map((candidate) => `nflverse.schedules.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.stats-player-week.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.snap-counts.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.weekly-rosters.${candidate}`),
    ...completedSeasons.map((candidate) => `nflverse.injuries.${candidate}`),
    ...seasons.map((candidate) => `nflverse.stats-team-week.${candidate}`),
    `nflverse.stats-player-week.${season}`,
    `nflverse.snap-counts.${season}`,
    `nflverse.weekly-rosters.${season}`,
    `nflverse.injuries.${season}`,
    "nflverse.players",
    "sleeper.players",
  ];
}

async function pinnedSourceChecksums(
  database: RosReadDatabase,
  keys: readonly string[],
): Promise<ReadonlyMap<string, { readonly id: string; readonly checksum: string }>> {
  if (keys.length === 0) return new Map();
  const rows = await database
    .select({
      id: dataSources.id,
      key: dataSources.key,
      lastChecksum: dataSources.lastChecksum,
      metadata: dataSources.metadata,
    })
    .from(dataSources)
    .where(inArray(dataSources.key, keys));
  assertFootballSourceCoherence(rows.filter((row) => row.lastChecksum !== null));
  const result = new Map<string, { readonly id: string; readonly checksum: string }>();
  for (const row of rows) {
    if (row.lastChecksum) result.set(row.key, { id: row.id, checksum: row.lastChecksum });
  }
  return result;
}

async function currentAliasCandidatePoolForChecksum(
  database: RosReadDatabase,
  season: number,
  sources: ReadonlyMap<string, { readonly id: string; readonly checksum: string }>,
): Promise<readonly FirstPartyRosCandidatePlayer[]> {
  const rosterSource = sources.get(`nflverse.weekly-rosters.${season}`);
  const scheduleSource = sources.get(`nflverse.schedules.${season}`);
  const [rosterRows, scheduleRows] = await Promise.all([
    rosterSource
      ? database
          .select({
            playerId: playerWeeklyRosterObservations.playerId,
            position: playerWeeklyRosterObservations.position,
            season: playerWeeklyRosterObservations.season,
            week: playerWeeklyRosterObservations.week,
            team: playerWeeklyRosterObservations.team,
            status: playerWeeklyRosterObservations.rosterStatus,
          })
          .from(playerWeeklyRosterObservations)
          .where(
            and(
              eq(playerWeeklyRosterObservations.sourceId, rosterSource.id),
              eq(playerWeeklyRosterObservations.inputChecksum, rosterSource.checksum),
              eq(playerWeeklyRosterObservations.season, season),
            ),
          )
      : Promise.resolve([]),
    scheduleSource
      ? database
          .select({
            season: nflScheduleObservations.season,
            awayTeam: nflScheduleObservations.awayTeam,
            homeTeam: nflScheduleObservations.homeTeam,
          })
          .from(nflScheduleObservations)
          .where(
            and(
              eq(nflScheduleObservations.sourceId, scheduleSource.id),
              eq(nflScheduleObservations.inputChecksum, scheduleSource.checksum),
              eq(nflScheduleObservations.season, season),
              eq(nflScheduleObservations.seasonType, "REG"),
            ),
          )
      : Promise.resolve([]),
  ]);
  return currentFantasyPlayerPool(
    rosterRows.flatMap((row) =>
      row.playerId
        ? [
            {
              playerId: row.playerId,
              position: row.position,
              season: row.season,
              week: row.week,
              team: canonicalNflTeamCode(row.team),
              status: row.status,
            },
          ]
        : [],
    ),
    scheduleRows.map((row) => ({
      season: row.season,
      awayTeam: canonicalNflTeamCode(row.awayTeam),
      homeTeam: canonicalNflTeamCode(row.homeTeam),
    })),
    season,
  );
}

function queryChunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += ROS_ALIAS_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + ROS_ALIAS_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

export function firstPartyRosEffectiveRosterAliasPosition(input: {
  readonly playerId: string;
  readonly primaryPosition: string;
  readonly eligiblePositions: readonly string[];
  readonly candidatePositionByPlayerId: ReadonlyMap<string, string>;
}): {
  readonly position?: FirstPartyRosRailPosition;
  readonly ambiguousPositions: readonly FirstPartyRosRailPosition[];
} {
  const candidatePosition = input.candidatePositionByPlayerId.get(input.playerId);
  if (candidatePosition) {
    const position = aliasPosition(candidatePosition);
    return position ? { position, ambiguousPositions: [] } : { ambiguousPositions: [] };
  }
  const primary = aliasPosition(input.primaryPosition);
  if (primary) return { position: primary, ambiguousPositions: [] };
  const eligible = [
    ...new Set(
      input.eligiblePositions.flatMap((position) => {
        const normalized = aliasPosition(position);
        return normalized ? [normalized] : [];
      }),
    ),
  ].sort();
  // Downstream waiver identity reconstruction uses the provider player's catalog primary
  // position when no nflverse row exists. Do not publish an alias under an eligible-only position
  // that the consumer would later reinterpret as CB/LB/etc.; any plausible supported roles become
  // explicit scoped issues instead.
  return { ambiguousPositions: eligible };
}

export function firstPartyRosPlayerAliasPlansChecksum(
  plans: ReadonlyMap<string, FirstPartyRosPlayerAliasPlan>,
): string {
  return sha256(
    JSON.stringify(
      [...plans]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([leagueSeasonId, plan]) => ({
          leagueSeasonId,
          aliases: [...plan.aliases].sort(playerAliasSort),
          issues: [...plan.issues].sort(playerAliasIssueSort),
        })),
    ),
  );
}

/**
 * Loads only identities that can affect the current ROS universe or a latest league roster. No
 * snapshot IDs reach the plan/checksum, so an otherwise identical sync does not churn publication.
 */
async function latestLeaguePlayerAliasPlans(
  database: RosReadDatabase,
  leagueSeasonIds: readonly string[],
  candidatePlayers: readonly FirstPartyRosCandidatePlayer[],
  sleeperSourceId?: string,
): Promise<ReadonlyMap<string, FirstPartyRosPlayerAliasPlan>> {
  const uniqueLeagueIds = [...new Set(leagueSeasonIds)].sort();
  if (uniqueLeagueIds.length === 0) return new Map();
  const snapshotRows = await database
    .selectDistinctOn([fantasyTeams.id], {
      leagueSeasonId: fantasyTeams.leagueSeasonId,
      snapshotId: rosterSnapshots.id,
    })
    .from(fantasyTeams)
    .innerJoin(rosterSnapshots, eq(rosterSnapshots.teamId, fantasyTeams.id))
    .where(inArray(fantasyTeams.leagueSeasonId, [...leagueSeasonIds]))
    .orderBy(fantasyTeams.id, desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id));
  const entryRows: {
    readonly snapshotId: string;
    readonly playerId: string;
    readonly gsisId: string | null;
    readonly fullName: string;
    readonly primaryPosition: string;
    readonly eligiblePositions: readonly string[];
    readonly nflTeam: string | null;
  }[] = [];
  for (const snapshotIds of queryChunks(snapshotRows.map((row) => row.snapshotId))) {
    entryRows.push(
      ...(await database
        .select({
          snapshotId: rosterEntries.snapshotId,
          playerId: rosterEntries.playerId,
          gsisId: players.gsisId,
          fullName: players.fullName,
          primaryPosition: players.primaryPosition,
          eligiblePositions: players.eligiblePositions,
          nflTeam: players.nflTeam,
        })
        .from(rosterEntries)
        .innerJoin(players, eq(players.id, rosterEntries.playerId))
        .where(inArray(rosterEntries.snapshotId, [...snapshotIds]))),
    );
  }
  const leagueBySnapshot = new Map(snapshotRows.map((row) => [row.snapshotId, row.leagueSeasonId]));
  const candidatePositionByPlayerId = new Map(
    candidatePlayers.map((candidate) => [candidate.playerId, candidate.position]),
  );
  const rosterPlayersByLeague = new Map<string, FirstPartyRosPlayerAliasIdentity[]>();
  const initialIssuesByLeague = new Map<string, FirstPartyRosPlayerAliasIssue[]>();
  for (const row of entryRows) {
    const leagueSeasonId = leagueBySnapshot.get(row.snapshotId);
    if (!leagueSeasonId) continue;
    const effectivePosition = firstPartyRosEffectiveRosterAliasPosition({
      playerId: row.playerId,
      candidatePositionByPlayerId,
      primaryPosition: row.primaryPosition,
      eligiblePositions: row.eligiblePositions,
    });
    if (!effectivePosition.position) {
      if (effectivePosition.ambiguousPositions.length > 0) {
        const issues = initialIssuesByLeague.get(leagueSeasonId) ?? [];
        issues.push(
          ...effectivePosition.ambiguousPositions.map((position) => ({
            position,
            playerId: row.playerId,
            code: "effective-position-ambiguous",
          })),
        );
        initialIssuesByLeague.set(leagueSeasonId, issues);
      }
      continue;
    }
    const rosterPlayers = rosterPlayersByLeague.get(leagueSeasonId) ?? [];
    rosterPlayers.push({
      playerId: row.playerId,
      fullName: row.fullName,
      position: effectivePosition.position,
      team: row.nflTeam,
      gsisId: row.gsisId,
    });
    rosterPlayersByLeague.set(leagueSeasonId, rosterPlayers);
  }

  const candidateIds = candidatePlayers
    .filter((candidate) => candidate.position !== "DST")
    .map((candidate) => candidate.playerId);
  const candidateCatalogRows: {
    readonly id: string;
    readonly gsisId: string | null;
    readonly fullName: string;
  }[] = [];
  for (const ids of queryChunks([...new Set(candidateIds)])) {
    candidateCatalogRows.push(
      ...(await database
        .select({ id: players.id, gsisId: players.gsisId, fullName: players.fullName })
        .from(players)
        .where(inArray(players.id, [...ids]))),
    );
  }
  const catalogById = new Map(candidateCatalogRows.map((row) => [row.id, row]));
  const canonicalPlayers: FirstPartyRosPlayerAliasIdentity[] = candidatePlayers.map((candidate) => {
    const catalog = catalogById.get(candidate.playerId);
    return {
      playerId: candidate.playerId,
      fullName: catalog?.fullName ?? "",
      position: candidate.position,
      team: candidate.team,
      gsisId: catalog?.gsisId ?? null,
    };
  });

  const identityPlayerIds = [
    ...new Set([
      ...entryRows.map((row) => row.playerId),
      ...candidatePlayers.map((candidate) => candidate.playerId),
    ]),
  ];
  const externalIds: FirstPartyRosPlayerAliasExternalId[] = [];
  const gsisEvidence: FirstPartyRosPlayerAliasGsisEvidence[] = [];
  for (const ids of queryChunks(identityPlayerIds)) {
    const [externalRows, sourceRows] = await Promise.all([
      database
        .select({
          playerId: playerExternalIds.playerId,
          source: playerExternalIds.source,
          externalId: playerExternalIds.externalId,
        })
        .from(playerExternalIds)
        .where(
          and(
            inArray(playerExternalIds.playerId, [...ids]),
            inArray(playerExternalIds.source, [...ROS_ALIAS_EXTERNAL_SOURCES]),
          ),
        ),
      sleeperSourceId
        ? database
            .select({
              playerId: playerSourceObservations.playerId,
              gsisId: playerSourceObservations.gsisId,
            })
            .from(playerSourceObservations)
            .where(
              and(
                inArray(playerSourceObservations.playerId, [...ids]),
                eq(playerSourceObservations.sourceId, sleeperSourceId),
              ),
            )
        : Promise.resolve([]),
    ]);
    externalIds.push(...externalRows);
    gsisEvidence.push(
      ...sourceRows.flatMap((row) =>
        row.playerId ? [{ playerId: row.playerId, gsisId: row.gsisId }] : [],
      ),
    );
  }

  // One source-indexed bounded read for the whole multi-league request closes bridges outside
  // today's candidate/roster IDs. Normalize with the same helper as matching, not a second SQL
  // regex. A capped result disables only the new unbridged fallback, never existing safe joins.
  const needsYahooClosure = externalIds.some(
    (row) => row.source === "yahoo" || row.source === "sleeper-yahoo",
  );
  const yahooEvidence = needsYahooClosure
    ? firstPartyRosYahooEvidenceClosure({
        externalIds,
        sourceRows: await database
          .select({
            playerId: playerExternalIds.playerId,
            source: playerExternalIds.source,
            externalId: playerExternalIds.externalId,
          })
          .from(playerExternalIds)
          .where(inArray(playerExternalIds.source, ["yahoo", "sleeper-yahoo"]))
          .limit(ROS_ALIAS_YAHOO_EVIDENCE_LIMIT + 1),
      })
    : { complete: false, externalIds };

  return new Map(
    uniqueLeagueIds.map((leagueSeasonId) => [
      leagueSeasonId,
      firstPartyRosPlayerAliasPlan({
        leagueSeasonId,
        rosterPlayers: rosterPlayersByLeague.get(leagueSeasonId) ?? [],
        canonicalPlayers,
        externalIds: yahooEvidence.externalIds,
        yahooExternalEvidenceComplete: yahooEvidence.complete,
        gsisEvidence,
        initialIssues: initialIssuesByLeague.get(leagueSeasonId) ?? [],
      }),
    ]),
  );
}

async function prepareDatabaseFirstPartyRosTargets(
  options: {
    readonly database: RosReadDatabase;
    readonly liveCacheDirectory?: string;
    readonly onLiveReuse?: (event: {
      readonly kind: "calibration-hit" | "calibration-fit" | "target-hit" | "target-build";
      readonly physicalIdentity: string;
    }) => void;
    readonly scenarioCount?: number;
    readonly convergenceReferenceScenarioCount?: number;
    readonly buildLeagueTarget?: FirstPartyRosLeagueTargetBuilder;
    readonly pinnedAliasPlans: ReadonlyMap<string, FirstPartyRosPlayerAliasPlan>;
    readonly reuse: FirstPartyRosRefreshReuse;
    readonly buildArtifacts: readonly LoadedFirstPartyRosChampionArtifact[];
  },
  context: FirstPartyRosCandidateContext,
): Promise<() => Promise<Readonly<Record<string, readonly FirstPartyRosPublicationTarget[]>>>> {
  const database = options.database;
  const { season, window } = context;
  const targetsByArtifact: Record<string, FirstPartyRosPublicationTarget[]> = Object.fromEntries(
    options.buildArtifacts.map((artifact) => [artifact.artifactChecksum, []]),
  );
  const seasons = projectionHistorySeasons(season);

  const leagueRows = await database
    .select({ id: leagueSeasons.id, provider: leagueSeasons.provider })
    .from(leagueSeasons)
    .where(eq(leagueSeasons.season, season));
  if (leagueRows.length === 0) return () => Promise.resolve(targetsByArtifact);
  if (
    options.pinnedAliasPlans.size !== leagueRows.length ||
    leagueRows.some((league) => !options.pinnedAliasPlans.has(league.id))
  ) {
    throw new Error("ROS league identity scope changed before target assembly");
  }
  const ruleRows = await database
    .select({
      leagueSeasonId: scoringRules.leagueSeasonId,
      statKey: scoringRules.statKey,
      providerStatId: scoringRules.providerStatId,
      operation: scoringRules.operation,
      points: scoringRules.points,
      thresholdLow: scoringRules.thresholdLow,
      thresholdHigh: scoringRules.thresholdHigh,
      positionTypes: scoringRules.positionTypes,
    })
    .from(scoringRules)
    .innerJoin(leagueSeasons, eq(leagueSeasons.id, scoringRules.leagueSeasonId))
    .where(eq(leagueSeasons.season, season));

  // `excluded` is deliberately dropped here: this rail has no operator-facing channel of its own
  // (no logger in this file), and the ROS status surface derives its own per-position reasons from
  // its own normalization rather than reading these. It is returned so the reasons are available to
  // a caller and are covered by tests; if a diagnostics channel is ever added, this is where the
  // exclusions are already computed.
  const matches = options.buildArtifacts.map((artifact) => ({
    artifact,
    matched: firstPartyRosArtifactOwnedLeagues({
      artifact,
      artifacts: context.artifacts,
      leagues: enumerateFirstPartyRosScoringMatchedLeagues({
        artifactScoringProfileKey: artifact.scoringProfileKey,
        leagues: leagueRows,
        rules: ruleRows,
        availableStatIds: firstPartyAvailableProjectionComponents(),
      }).matched,
    }),
  }));
  if (matches.every(({ matched }) => matched.length === 0))
    return () => Promise.resolve(targetsByArtifact);
  options.reuse.project = createRosLiveProjectionReuse({
    profiles: matches.flatMap(({ matched }) => matched.map((league) => league.profile)),
  });

  const sourceKeys = firstPartyRosCandidateSourceKeys(season);
  const sources = await pinnedSourceChecksums(database, sourceKeys);
  const scheduleSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.schedules.${candidate}`);
    return source ? [source] : [];
  });
  if (scheduleSources.length === 0) return () => Promise.resolve(targetsByArtifact);
  const statSources = [...seasons].flatMap((candidate) => {
    const source = sources.get(`nflverse.stats-player-week.${candidate}`);
    return source ? [source] : [];
  });
  const snapSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.snap-counts.${candidate}`);
    return source ? [source] : [];
  });
  const rosterSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.weekly-rosters.${candidate}`);
    return source ? [source] : [];
  });
  const injurySources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.injuries.${candidate}`);
    return source ? [source] : [];
  });
  const teamStatSources = seasons.flatMap((candidate) => {
    const source = sources.get(`nflverse.stats-team-week.${candidate}`);
    return source ? [source] : [];
  });

  const [
    capturedSchedules,
    capturedWeekly,
    capturedSnaps,
    capturedRosters,
    capturedInjuries,
    capturedTeams,
  ] = await Promise.all([
    database
      .select({
        season: nflScheduleObservations.season,
        week: nflScheduleObservations.week,
        gameId: nflScheduleObservations.externalGameId,
        awayTeam: nflScheduleObservations.awayTeam,
        homeTeam: nflScheduleObservations.homeTeam,
        awayScore: nflScheduleObservations.awayScore,
        homeScore: nflScheduleObservations.homeScore,
        kickoffAt: nflScheduleObservations.kickoffAt,
        status: nflScheduleObservations.status,
        sourceAsOf: nflScheduleObservations.sourceAsOf,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          rosSourceVersionPredicate(
            scheduleSources,
            nflScheduleObservations.sourceId,
            nflScheduleObservations.inputChecksum,
          ),
          inArray(nflScheduleObservations.season, seasons),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      ),
    statSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerWeeklyStatObservations.playerId,
            position: players.primaryPosition,
            season: playerWeeklyStatObservations.season,
            week: playerWeeklyStatObservations.week,
            gameId: playerWeeklyStatObservations.gameId,
            team: playerWeeklyStatObservations.team,
            opponentTeam: playerWeeklyStatObservations.opponentTeam,
            components: playerWeeklyStatObservations.components,
            advanced: playerWeeklyStatObservations.advanced,
          })
          .from(playerWeeklyStatObservations)
          .innerJoin(players, eq(players.id, playerWeeklyStatObservations.playerId))
          .where(
            and(
              rosSourceVersionPredicate(
                statSources,
                playerWeeklyStatObservations.sourceId,
                playerWeeklyStatObservations.inputChecksum,
              ),
              inArray(playerWeeklyStatObservations.season, seasons),
              eq(playerWeeklyStatObservations.seasonType, "REG"),
            ),
          ),
    snapSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerSnapCountObservations.playerId,
            position: players.primaryPosition,
            season: playerSnapCountObservations.season,
            week: playerSnapCountObservations.week,
            gameId: playerSnapCountObservations.gameId,
            team: playerSnapCountObservations.team,
            opponentTeam: playerSnapCountObservations.opponentTeam,
            offenseShare: playerSnapCountObservations.offenseShare,
            specialTeamsShare: playerSnapCountObservations.specialTeamsShare,
          })
          .from(playerSnapCountObservations)
          .innerJoin(players, eq(players.id, playerSnapCountObservations.playerId))
          .where(
            and(
              rosSourceVersionPredicate(
                snapSources,
                playerSnapCountObservations.sourceId,
                playerSnapCountObservations.inputChecksum,
              ),
              inArray(playerSnapCountObservations.season, seasons),
              eq(playerSnapCountObservations.seasonType, "REG"),
            ),
          ),
    rosterSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            externalPlayerId: playerWeeklyRosterObservations.externalPlayerId,
            playerId: playerWeeklyRosterObservations.playerId,
            // The NFL roster feed is the fantasy-position authority for the live pool. The
            // canonical catalog intentionally records an NFL primary position, which can be CB
            // for a two-way fantasy WR (or FB for a provider-eligible RB/TE). Replacing the feed's
            // position with that catalog value would silently drop those players from ROS.
            position: playerWeeklyRosterObservations.position,
            season: playerWeeklyRosterObservations.season,
            week: playerWeeklyRosterObservations.week,
            team: playerWeeklyRosterObservations.team,
            status: playerWeeklyRosterObservations.rosterStatus,
          })
          .from(playerWeeklyRosterObservations)
          .where(
            and(
              rosSourceVersionPredicate(
                rosterSources,
                playerWeeklyRosterObservations.sourceId,
                playerWeeklyRosterObservations.inputChecksum,
              ),
              inArray(playerWeeklyRosterObservations.season, seasons),
            ),
          ),
    injurySources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            playerId: playerInjuryReportObservations.playerId,
            season: playerInjuryReportObservations.season,
            week: playerInjuryReportObservations.week,
            reportStatus: playerInjuryReportObservations.reportStatus,
            practiceStatus: playerInjuryReportObservations.practiceStatus,
          })
          .from(playerInjuryReportObservations)
          .innerJoin(players, eq(players.id, playerInjuryReportObservations.playerId))
          .where(
            and(
              rosSourceVersionPredicate(
                injurySources,
                playerInjuryReportObservations.sourceId,
                playerInjuryReportObservations.inputChecksum,
              ),
              inArray(playerInjuryReportObservations.season, seasons),
              eq(playerInjuryReportObservations.seasonType, "REG"),
            ),
          ),
    teamStatSources.length === 0
      ? Promise.resolve([])
      : database
          .select({
            season: teamWeeklyStatObservations.season,
            week: teamWeeklyStatObservations.week,
            gameId: teamWeeklyStatObservations.gameId,
            team: teamWeeklyStatObservations.team,
            opponentTeam: teamWeeklyStatObservations.opponentTeam,
            components: teamWeeklyStatObservations.components,
          })
          .from(teamWeeklyStatObservations)
          .where(
            and(
              rosSourceVersionPredicate(
                teamStatSources,
                teamWeeklyStatObservations.sourceId,
                teamWeeklyStatObservations.inputChecksum,
              ),
              inArray(teamWeeklyStatObservations.season, seasons),
              eq(teamWeeklyStatObservations.seasonType, "REG"),
            ),
          ),
  ]);

  return async () => {
    // Canonical order governs both identity and assembly, including duplicate/tie handling.
    const scheduleRows = canonicalRosLiveRows(capturedSchedules);
    const weeklyRows = canonicalRosLiveRows(capturedWeekly);
    const snapRows = canonicalRosLiveRows(capturedSnaps);
    const rosterRows = canonicalRosLiveRows(capturedRosters);
    const injuryRows = canonicalRosLiveRows(capturedInjuries);
    const teamRows = canonicalRosLiveRows(capturedTeams);
    const physicalIdentity = rosLivePhysicalIdentity({
      season,
      window,
      ...(options.scenarioCount === undefined ? {} : { scenarioCount: options.scenarioCount }),
      ...(options.convergenceReferenceScenarioCount === undefined
        ? {}
        : { convergenceReferenceScenarioCount: options.convergenceReferenceScenarioCount }),
      sources: sourceKeys
        .filter((key) => key !== "nflverse.players" && key !== "sleeper.players")
        .map((key) => ({
          key,
          id: sources.get(key)?.id ?? null,
          checksum: sources.get(key)?.checksum ?? null,
        })),
      rows: {
        schedules: scheduleRows,
        weekly: weeklyRows,
        snaps: snapRows,
        rosters: rosterRows,
        injuries: injuryRows,
        teams: teamRows,
      },
    });
    const liveOutcomeCache =
      options.liveCacheDirectory === undefined
        ? undefined
        : await prepareRosLiveOutcomeCache({
            rootDirectory: options.liveCacheDirectory,
            physicalIdentity,
          });
    const liveStore =
      options.liveCacheDirectory === undefined
        ? undefined
        : createRosLiveGenerationStore({
            directory: path.join(
              options.liveCacheDirectory,
              "generations",
              physicalIdentity,
              "metadata",
            ),
          });
    const calibrationStore =
      options.liveCacheDirectory === undefined
        ? undefined
        : createRosLiveGenerationStore({
            directory: path.join(options.liveCacheDirectory, "calibrations"),
          });
    const generation = await liveStore?.getOrCreateGeneration(
      physicalIdentity,
      context.now.toISOString(),
    );
    const asOfAt = generation === undefined ? context.now : new Date(generation.asOfAt);
    const durableProject =
      liveOutcomeCache === undefined
        ? undefined
        : createRosLiveOutcomeProjector({
            cache: liveOutcomeCache,
            profiles: matches.flatMap(({ matched }) => matched.map((league) => league.profile)),
          });
    const weekly: ProjectionWeeklyFact[] = weeklyRows.flatMap((row) =>
      row.playerId
        ? [
            {
              playerId: row.playerId,
              position: row.position,
              season: row.season,
              week: row.week,
              gameId: row.gameId,
              team: canonicalNflTeamCode(row.team),
              opponentTeam: canonicalNflTeamCode(row.opponentTeam),
              components: row.components,
              advanced: row.advanced,
            },
          ]
        : [],
    );
    const snaps: ProjectionSnapFact[] = snapRows.flatMap((row) =>
      row.playerId
        ? [
            {
              playerId: row.playerId,
              position: row.position,
              season: row.season,
              week: row.week,
              gameId: row.gameId,
              team: canonicalNflTeamCode(row.team),
              opponentTeam: canonicalNflTeamCode(row.opponentTeam),
              offenseShare: Number(row.offenseShare),
              specialTeamsShare: Number(row.specialTeamsShare),
            },
          ]
        : [],
    );
    const rosterUniverseRows: FirstPartyRosRosterUniverseRow[] = rosterRows.map((row) => ({
      externalPlayerId: row.externalPlayerId,
      playerId: row.playerId,
      position: row.position,
      season: row.season,
      week: row.week,
      team: canonicalNflTeamCode(row.team),
      status: row.status,
    }));
    const rosters: ProjectionRosterFact[] = rosterUniverseRows.flatMap((row) =>
      row.playerId
        ? [
            {
              playerId: row.playerId,
              position: row.position,
              season: row.season,
              week: row.week,
              team: row.team,
              status: row.status,
            },
          ]
        : [],
    );
    const injuries: ProjectionInjuryFact[] = injuryRows.flatMap((row) =>
      row.playerId
        ? [
            {
              playerId: row.playerId,
              season: row.season,
              week: row.week,
              reportStatus: row.reportStatus,
              practiceStatus: row.practiceStatus,
            },
          ]
        : [],
    );
    const teamWeekly: ProjectionTeamWeekFact[] = teamRows.map((row) => ({
      season: row.season,
      week: row.week,
      gameId: row.gameId,
      team: canonicalNflTeamCode(row.team),
      opponentTeam: canonicalNflTeamCode(row.opponentTeam),
      components: row.components,
    }));
    const schedules: ProjectionScheduleFact[] = scheduleRows.map((row) => ({
      season: row.season,
      week: row.week,
      gameId: row.gameId,
      awayTeam: canonicalNflTeamCode(row.awayTeam),
      homeTeam: canonicalNflTeamCode(row.homeTeam),
      awayScore: row.awayScore,
      homeScore: row.homeScore,
      kickoffAt: row.kickoffAt,
      status: row.status,
    }));

    const history = buildFirstPartyPlayerHistory(weekly, snaps, rosters, schedules, injuries);
    const defenseHistoryByDefinition = Object.fromEntries(
      DEFENSE_POINTS_ALLOWED_DEFINITIONS.map((definition) => [
        definition,
        buildFirstPartyDefenseHistory(teamWeekly, schedules, definition),
      ]),
    ) as Record<
      ProjectionDefensePointsAllowedDefinition,
      readonly FirstPartyTeamDefenseWeeklyStatLine[]
    >;
    const cutoff = season * 32 + window.asOfWeek;
    const featureHistory = history.filter((row) => row.season * 32 + row.week <= cutoff);
    const trainingHistory = history.filter((row) => row.season < season);
    const defenseFeatureHistoryByDefinition = {
      "yahoo-2022-v1": defenseHistoryByDefinition["yahoo-2022-v1"].filter(
        (row) => row.season * 32 + row.week <= cutoff,
      ),
      "espn-2019-v1": defenseHistoryByDefinition["espn-2019-v1"].filter(
        (row) => row.season * 32 + row.week <= cutoff,
      ),
    };
    const defenseTrainingHistoryByDefinition = {
      "yahoo-2022-v1": defenseHistoryByDefinition["yahoo-2022-v1"].filter(
        (row) => row.season < season,
      ),
      "espn-2019-v1": defenseHistoryByDefinition["espn-2019-v1"].filter(
        (row) => row.season < season,
      ),
    };
    // Availability/role calibration must be trained strictly before the current season so a live
    // forecast can never leak its own season into its publication decision.
    if (trainingHistory.length === 0) return targetsByArtifact;
    let calibration: FirstPartyProjectionCalibration;
    let availabilityCalibration: HistoricalRosAvailabilityCalibration;
    let roleCalibration: HistoricalRosRoleCalibration;
    let kickerCalibration: HistoricalRosKickerCalibration;
    let defenseCalibrationByDefinition: Readonly<
      Record<ProjectionDefensePointsAllowedDefinition, FirstPartyTeamDefenseCalibration>
    >;
    const trainingSchedules = schedules.filter((row) => row.season < season);
    const calibrationIdentity = rosLivePhysicalIdentity({
      season,
      window: { asOfWeek: 0, windowStartWeek: 1, windowEndWeek: 18 },
      sources: [],
      rows: {
        trainingHistory,
        yahooDefenseTrainingHistory: defenseTrainingHistoryByDefinition["yahoo-2022-v1"],
        espnDefenseTrainingHistory: defenseTrainingHistoryByDefinition["espn-2019-v1"],
        schedules: trainingSchedules,
      },
    });
    try {
      // Football-process fits use the model's fixed training loss, independent of every artifact's
      // league coefficients. Exact league evaluation still controls publication downstream.
      if (options.reuse.calibration === undefined) {
        const cachedCalibration = await calibrationStore?.readCalibration(calibrationIdentity);
        if (cachedCalibration?.state === "hit") {
          options.reuse.calibration = restoreRosLiveCalibration(cachedCalibration.value);
          options.onLiveReuse?.({ kind: "calibration-hit", physicalIdentity });
        } else {
          options.reuse.calibration = {
            player: calibrateFirstPartyRosPlayerHistory({
              trainingHistory,
              schedules: trainingSchedules,
            }),
            defenseByDefinition: Object.fromEntries(
              DEFENSE_POINTS_ALLOWED_DEFINITIONS.map((definition) => [
                definition,
                runFirstPartyTeamDefenseBacktest(defenseTrainingHistoryByDefinition[definition])
                  .calibration,
              ]),
            ) as Record<ProjectionDefensePointsAllowedDefinition, FirstPartyTeamDefenseCalibration>,
          };
          await calibrationStore?.writeCalibration(calibrationIdentity, options.reuse.calibration);
          options.onLiveReuse?.({ kind: "calibration-fit", physicalIdentity });
        }
      }
      const fitted = options.reuse.calibration.player;
      calibration = fitted.weekly;
      availabilityCalibration = fitted.availability;
      roleCalibration = fitted.role;
      // Total by contract (documented fallbacks, never throws), so the kicker calibration cannot
      // trip this league-wide fail-closed catch on a sparse corpus.
      kickerCalibration = fitted.kicker;
      defenseCalibrationByDefinition = options.reuse.calibration.defenseByDefinition;
    } catch (error) {
      // Cache integrity/storage failures must reach the queue's bounded retry diagnostics.
      if (liveStore !== undefined) throw error;
      // A calibration that cannot be fitted is an explicitly missing model input.
      return targetsByArtifact;
    }

    const futureWindowComplete = futureWindowIsComplete(schedules, season, window);
    const scheduleDates = scheduleRows
      .map((row) => row.sourceAsOf)
      .filter((value): value is Date => value instanceof Date);
    const sourceAsOf =
      scheduleDates.length === 0
        ? asOfAt
        : new Date(Math.max(...scheduleDates.map((value) => value.getTime())));

    const candidatePool = currentFantasyPlayerPool(rosters, schedules, season);
    if (candidatePool.length === 0) return targetsByArtifact;
    const unmatchedCandidates = unmatchedCurrentFantasyPlayers(rosterUniverseRows, season);
    const aliasPlansByLeague = options.pinnedAliasPlans;

    for (const { artifact, matched } of matches) {
      const targets = targetsByArtifact[artifact.artifactChecksum]!;
      const targetTemplates = new Map<
        string,
        Omit<FirstPartyRosPublicationTarget, "leagueSeasonId"> | null
      >();
      for (const league of matched) {
        const leagueScoringProfileKey = projectionScoringProfileKey(league.profile);
        // Profiles without active PA can share the explicit reference definition because those
        // components cannot affect their scores. Normalized PA rules always name their provider.
        const defenseDefinition =
          defensePointsAllowedDefinitionForProfile(league.profile) ?? "yahoo-2022-v1";
        const defenseFeatureHistory = defenseFeatureHistoryByDefinition[defenseDefinition];
        const defenseCalibration = defenseCalibrationByDefinition[defenseDefinition];
        const matchedUnresolvedCandidates = unmatchedCandidates.filter((candidate) =>
          candidate.positions.some((position) => league.matchedPositions.includes(position)),
        );
        const unmatchedCandidateCount = matchedUnresolvedCandidates.length;
        const templateKey = aggregateChecksum("live-ros-target-template-v1", [
          physicalIdentity,
          `as-of:${asOfAt.toISOString()}`,
          artifact.artifactChecksum,
          leagueScoringProfileKey,
          ...league.matchedPositions,
          "supported",
          ...league.supportedPositions,
          `unmatched:${unmatchedCandidateCount}`,
        ]);
        if (!targetTemplates.has(templateKey) && liveStore !== undefined) {
          const cachedTarget = await liveStore.readTargets(templateKey);
          if (cachedTarget.state === "hit") {
            targetTemplates.set(
              templateKey,
              restoreRosLiveTargetTemplate(cachedTarget.value, {
                scoringProfileKey: leagueScoringProfileKey,
                asOfAt: asOfAt.toISOString(),
                season,
                window,
              }),
            );
            options.onLiveReuse?.({ kind: "target-hit", physicalIdentity });
          }
        }
        if (targetTemplates.has(templateKey)) {
          const template = targetTemplates.get(templateKey);
          if (template !== null && template !== undefined) {
            targets.push(
              applyFirstPartyRosPlayerAliases(
                { leagueSeasonId: league.leagueSeasonId, ...template },
                aliasPlansByLeague.get(league.leagueSeasonId) ?? { aliases: [], issues: [] },
              ),
            );
          }
          continue;
        }
        const build =
          options.buildLeagueTarget ??
          ((target: FirstPartyRosLeagueTargetInput) =>
            durableProject === undefined
              ? buildFirstPartyRosLeagueTarget(target, options.reuse.project)
              : buildFirstPartyRosLeagueTargetAsync(target, durableProject));
        options.onLiveReuse?.({ kind: "target-build", physicalIdentity });
        const result = await build({
          artifact,
          leagueSeasonId: league.leagueSeasonId,
          scoringProfile:
            liveStore === undefined
              ? league.profile
              : { ...league.profile, id: `live-ros:${leagueScoringProfileKey}` },
          matchedPositions: league.matchedPositions,
          supportedPositions: league.supportedPositions,
          season,
          window,
          candidatePlayers: candidatePool,
          unmatchedCandidateCount,
          unmatchedCandidates: matchedUnresolvedCandidates,
          featureHistory,
          calibration,
          defenseFeatureHistory,
          defenseCalibration,
          availabilityCalibration,
          roleCalibration,
          kickerCalibration,
          injuries,
          schedules,
          futureWindowComplete,
          sourceAsOf,
          asOfAt,
          ...(options.scenarioCount === undefined ? {} : { scenarioCount: options.scenarioCount }),
          ...(options.convergenceReferenceScenarioCount === undefined
            ? {}
            : { convergenceReferenceScenarioCount: options.convergenceReferenceScenarioCount }),
        });
        if (result.target === null) {
          targetTemplates.set(templateKey, null);
          // Failed/incomplete work is not a reusable completed template.
          continue;
        }
        const { leagueSeasonId: ignoredLeagueSeasonId, ...template } = result.target;
        void ignoredLeagueSeasonId;
        targetTemplates.set(templateKey, template);
        await liveStore?.writeTargets(templateKey, {
          ...template,
          sourceAsOf: template.sourceAsOf.toISOString(),
        });
        targets.push(
          applyFirstPartyRosPlayerAliases(
            { leagueSeasonId: league.leagueSeasonId, ...template },
            aliasPlansByLeague.get(league.leagueSeasonId) ?? { aliases: [], issues: [] },
          ),
        );
      }
    }
    return targetsByArtifact;
  };
}

function futureWindowIsComplete(
  schedules: readonly ProjectionScheduleFact[],
  season: number,
  window: FirstPartyRosWindow,
): boolean {
  for (let week = window.windowStartWeek; week <= window.windowEndWeek; week += 1) {
    if (!schedules.some((game) => game.season === season && game.week === week)) return false;
  }
  return true;
}

/**
 * Builds the shared preseason/in-season ROS universe from the latest current-season NFL roster
 * facts, then adds one stable app-owned D/ST identity per scheduled team. Fantasy-team rosters are
 * intentionally irrelevant: an undrafted player and a free agent still need an ROS forecast.
 */
export function currentFantasyPlayerPool<
  Roster extends Pick<
    ProjectionRosterFact,
    "playerId" | "position" | "season" | "week" | "team" | "status"
  >,
  Schedule extends Pick<ProjectionScheduleFact, "season" | "awayTeam" | "homeTeam">,
>(
  rosters: readonly Roster[],
  schedules: readonly Schedule[],
  season: number,
): readonly FirstPartyRosCandidatePlayer[] {
  const latestByPlayer = new Map<string, (typeof rosters)[number]>();
  for (const row of rosters) {
    if (row.season !== season) continue;
    const existing = latestByPlayer.get(row.playerId);
    if (!existing || existing.week < row.week) latestByPlayer.set(row.playerId, row);
  }
  const players_ = [...latestByPlayer.values()].flatMap((row) => {
    const position = normalizePosition(row.position);
    const status = row.status?.trim().toUpperCase() ?? null;
    if (
      !["QB", "RB", "WR", "TE", "K"].includes(position) ||
      row.team.trim().length === 0 ||
      status === "CUT" ||
      status === "RET"
    ) {
      return [];
    }
    return [
      {
        playerId: row.playerId,
        position,
        team: canonicalNflTeamCode(row.team),
        ...(row.status === undefined ? {} : { rosterStatus: row.status }),
      },
    ];
  });
  const defenseTeams = [
    ...new Set(
      schedules
        .filter((game) => game.season === season)
        .flatMap((game) => [
          canonicalNflTeamCode(game.awayTeam),
          canonicalNflTeamCode(game.homeTeam),
        ]),
    ),
  ].sort();
  return [
    ...players_,
    ...defenseTeams.map((team) => ({
      playerId: firstPartyDefensePlayerId(team),
      position: "DST",
      team,
      rosterStatus: "active",
    })),
  ].sort(
    (left, right) =>
      left.position.localeCompare(right.position) || left.playerId.localeCompare(right.playerId),
  );
}
