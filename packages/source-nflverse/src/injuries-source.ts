import { parse } from "csv-parse/sync";

import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_DATA_REPOSITORY_URL,
  NflverseDatasetSourceError,
  assertAdmissionQuality,
  assertNflverseSeason,
  checkNflverseCsvRelease,
  type NflverseDatasetState,
  type NflverseFetchLike,
} from "./release-source.js";
import type { NflverseSeasonType } from "./weekly-stats-source.js";

export const NFLVERSE_INJURIES_SOURCE_KEY = "nflverse.injuries" as const;
export const NFLVERSE_INJURIES_ATTRIBUTION =
  "NFL injury reports provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_INJURIES_ATTRIBUTION_URL = NFLVERSE_DATA_REPOSITORY_URL;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50_000;
const ABSOLUTE_REJECTION_ALLOWANCE = 25;
const MAXIMUM_REJECTION_RATIO = 0.02;
const MINIMUM_ARTIFACT_ROWS = 16;
const MINIMUM_ARTIFACT_TEAMS = 4;

export type NflverseInjuryGameType = "REG" | "WC" | "DIV" | "CON" | "SB";
export type NflverseReportStatus = "out" | "doubtful" | "questionable" | "probable" | "note";
export type NflversePracticeStatus = "did-not-participate" | "limited" | "full" | "out" | "note";

export interface NflverseInjuryDesignation {
  readonly primaryInjury: string | null;
  readonly secondaryInjury: string | null;
  readonly status: NflverseReportStatus | null;
}

export interface NflversePracticeParticipation {
  readonly primaryInjury: string | null;
  readonly secondaryInjury: string | null;
  readonly status: NflversePracticeStatus | null;
}

export interface NflversePlayerInjuryReport {
  readonly season: number;
  readonly week: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameType: NflverseInjuryGameType;
  readonly team: string;
  readonly gsisId: string;
  readonly position: string;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly report: NflverseInjuryDesignation;
  readonly practice: NflversePracticeParticipation;
  /** Available on the 2009-2024 schema; normalized to UTC ISO-8601. */
  readonly dateModified: string | null;
}

export interface NflverseInjuryWeekCoverage {
  readonly week: number;
  readonly seasonType: NflverseSeasonType;
  readonly gameType: NflverseInjuryGameType;
  readonly teams: number;
  readonly players: number;
  readonly observations: number;
}

export interface NflverseInjuryRejections {
  readonly invalidIdentity: number;
  readonly invalidContext: number;
  readonly invalidReport: number;
  readonly invalidPractice: number;
  readonly invalidTimestamp: number;
  readonly emptyObservation: number;
  readonly duplicate: number;
}

interface NflverseInjuriesBaseResult {
  readonly checkedAt: string;
  readonly sourceKey: typeof NFLVERSE_INJURIES_SOURCE_KEY;
  readonly sourceUrl: string;
  readonly attribution: typeof NFLVERSE_INJURIES_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_INJURIES_ATTRIBUTION_URL;
  readonly license: typeof NFLVERSE_DATA_LICENSE;
  readonly season: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflverseInjuriesCheckResult =
  | (NflverseInjuriesBaseResult & {
      readonly state: "changed";
      readonly checksumSha256: string;
      readonly observations: readonly NflversePlayerInjuryReport[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
      readonly rejections: NflverseInjuryRejections;
      readonly coveredWeeks: readonly number[];
      readonly coveredSeasonTypes: readonly NflverseSeasonType[];
      readonly coveredTeams: readonly string[];
      readonly coveredReportStatuses: readonly NflverseReportStatus[];
      readonly coveredPracticeStatuses: readonly NflversePracticeStatus[];
      readonly datedSnapshots: number;
      readonly weekCoverage: readonly NflverseInjuryWeekCoverage[];
    })
  | (NflverseInjuriesBaseResult & { readonly state: "unchanged" });

export function buildNflverseInjuriesUrl(season: number): string {
  assertNflverseSeason(season, 2009);
  return `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  return nullableString(value, maximum) ?? undefined;
}

function team(value: unknown): string | null {
  const normalized = nullableString(value, 4)?.toUpperCase();
  return normalized && /^[A-Z]{2,4}$/u.test(normalized) ? normalized : null;
}

function position(value: unknown): string | null {
  const normalized = nullableString(value, 16)?.toUpperCase();
  return normalized && /^[A-Z0-9]+(?:[._/+-][A-Z0-9]+)*$/u.test(normalized) ? normalized : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function reportStatus(value: unknown): NflverseReportStatus | null | undefined {
  const normalized = nullableString(value, 32)?.toLowerCase();
  if (!normalized) return null;
  switch (normalized) {
    case "out":
    case "doubtful":
    case "questionable":
    case "probable":
    case "note":
      return normalized;
    default:
      return undefined;
  }
}

function practiceStatus(value: unknown): NflversePracticeStatus | null | undefined {
  const normalized = nullableString(value, 64)?.toLowerCase();
  if (!normalized) return null;
  switch (normalized) {
    case "did not participate in practice":
      return "did-not-participate";
    case "limited participation in practice":
      return "limited";
    case "full participation in practice":
      return "full";
    case "out (definitely will not play)":
      return "out";
    case "note":
      return "note";
    default:
      return undefined;
  }
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(normalized)) {
    return undefined;
  }
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function parseCsv(body: string): {
  readonly rows: Record<string, string>[];
  readonly hasSeasonType: boolean;
  readonly hasDateModified: boolean;
} {
  let rows: Record<string, string>[];
  try {
    rows = parse(body, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 64 * 1024,
    });
  } catch {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse injuries are malformed CSV");
  }
  if (rows.length === 0 || rows.length > MAX_ROWS) {
    throw new NflverseDatasetSourceError("INVALID_CSV", "nflverse injury row count is invalid");
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.has(required)) {
      throw new NflverseDatasetSourceError(
        "INVALID_CSV",
        `nflverse injuries omitted required column ${required}`,
      );
    }
  }
  return {
    rows,
    hasSeasonType: headers.has("season_type"),
    hasDateModified: headers.has("date_modified"),
  };
}

const REQUIRED_COLUMNS = [
  "season",
  "game_type",
  "team",
  "week",
  "gsis_id",
  "position",
  "full_name",
  "first_name",
  "last_name",
  "report_primary_injury",
  "report_secondary_injury",
  "report_status",
  "practice_primary_injury",
  "practice_secondary_injury",
  "practice_status",
] as const;

type RejectionReason = keyof NflverseInjuryRejections;

function normalizeRow(
  row: Record<string, string>,
  expectedSeason: number,
  schema: { readonly hasSeasonType: boolean; readonly hasDateModified: boolean },
): { readonly observation: NflversePlayerInjuryReport | null; readonly reason?: RejectionReason } {
  const gsisId = nullableString(row.gsis_id, 20);
  const playerPosition = position(row.position);
  const fullName = nullableString(row.full_name, 160);
  if (!gsisId || !/^00-\d{7}$/u.test(gsisId) || !playerPosition || !fullName) {
    return { observation: null, reason: "invalidIdentity" };
  }

  const season = integer(row.season, 2009, 2200);
  const week = integer(row.week, 1, 25);
  const gameType = nullableString(row.game_type, 4)?.toUpperCase();
  const playerTeam = team(row.team);
  if (
    season !== expectedSeason ||
    week === null ||
    !playerTeam ||
    (gameType !== "REG" &&
      gameType !== "WC" &&
      gameType !== "DIV" &&
      gameType !== "CON" &&
      gameType !== "SB")
  ) {
    return { observation: null, reason: "invalidContext" };
  }
  const seasonType: NflverseSeasonType = gameType === "REG" ? "REG" : "POST";
  const sourceSeasonType = schema.hasSeasonType
    ? nullableString(row.season_type, 4)?.toUpperCase()
    : null;
  if (schema.hasSeasonType && sourceSeasonType !== seasonType) {
    return { observation: null, reason: "invalidContext" };
  }

  const reportPrimaryInjury = optionalText(row.report_primary_injury, 160);
  const reportSecondaryInjury = optionalText(row.report_secondary_injury, 160);
  const normalizedReportStatus = reportStatus(row.report_status);
  if (
    reportPrimaryInjury === undefined ||
    reportSecondaryInjury === undefined ||
    normalizedReportStatus === undefined ||
    (reportSecondaryInjury !== null && reportPrimaryInjury === null) ||
    (normalizedReportStatus !== null && reportPrimaryInjury === null)
  ) {
    return { observation: null, reason: "invalidReport" };
  }

  const practicePrimaryInjury = optionalText(row.practice_primary_injury, 160);
  const practiceSecondaryInjury = optionalText(row.practice_secondary_injury, 160);
  const normalizedPracticeStatus = practiceStatus(row.practice_status);
  if (
    practicePrimaryInjury === undefined ||
    practiceSecondaryInjury === undefined ||
    normalizedPracticeStatus === undefined ||
    (practiceSecondaryInjury !== null && practicePrimaryInjury === null) ||
    (normalizedPracticeStatus === null) !== (practicePrimaryInjury === null)
  ) {
    return { observation: null, reason: "invalidPractice" };
  }
  if (reportPrimaryInjury === null && practicePrimaryInjury === null) {
    return { observation: null, reason: "emptyObservation" };
  }

  const dateModified = optionalTimestamp(schema.hasDateModified ? row.date_modified : null);
  if (dateModified === undefined) {
    return { observation: null, reason: "invalidTimestamp" };
  }

  return {
    observation: {
      season,
      week,
      seasonType,
      gameType,
      team: playerTeam,
      gsisId,
      position: playerPosition,
      fullName,
      firstName: nullableString(row.first_name, 80),
      lastName: nullableString(row.last_name, 80),
      report: {
        primaryInjury: reportPrimaryInjury,
        secondaryInjury: reportSecondaryInjury,
        status: normalizedReportStatus,
      },
      practice: {
        primaryInjury: practicePrimaryInjury,
        secondaryInjury: practiceSecondaryInjury,
        status: normalizedPracticeStatus,
      },
      dateModified,
    },
  };
}

function observationStateKey(observation: NflversePlayerInjuryReport): string {
  return [
    observation.report.primaryInjury,
    observation.report.secondaryInjury,
    observation.report.status,
    observation.practice.primaryInjury,
    observation.practice.secondaryInjury,
    observation.practice.status,
  ]
    .map((value) => value ?? "")
    .join("|");
}

function assertCompleteArtifact(observations: readonly NflversePlayerInjuryReport[]): {
  readonly coveredWeeks: readonly number[];
  readonly coveredSeasonTypes: readonly NflverseSeasonType[];
  readonly coveredTeams: readonly string[];
  readonly coveredReportStatuses: readonly NflverseReportStatus[];
  readonly coveredPracticeStatuses: readonly NflversePracticeStatus[];
  readonly datedSnapshots: number;
  readonly weekCoverage: readonly NflverseInjuryWeekCoverage[];
} {
  const coveredWeeks = [...new Set(observations.map((row) => row.week))].sort(
    (left, right) => left - right,
  );
  const coveredTeams = [...new Set(observations.map((row) => row.team))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    observations.length < MINIMUM_ARTIFACT_ROWS ||
    coveredTeams.length < MINIMUM_ARTIFACT_TEAMS ||
    coveredTeams.length > 32
  ) {
    throw new NflverseDatasetSourceError(
      "QUALITY_THRESHOLD",
      "nflverse injuries failed sparse-artifact coverage validation",
    );
  }

  let reachedPostseason = false;
  const weekCoverage: NflverseInjuryWeekCoverage[] = [];
  const postseasonMaximumTeams: Partial<Record<NflverseInjuryGameType, number>> = {
    WC: 12,
    DIV: 8,
    CON: 4,
    SB: 2,
  };
  for (const week of coveredWeeks) {
    const rows = observations.filter((row) => row.week === week);
    const gameTypes = [...new Set(rows.map((row) => row.gameType))];
    if (gameTypes.length !== 1) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse injuries mixed game types in week ${week}`,
      );
    }
    const gameType = gameTypes[0];
    if (!gameType) continue;
    if (gameType === "REG" && reachedPostseason) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        "nflverse injuries returned to regular season after the postseason",
      );
    }
    reachedPostseason ||= gameType !== "REG";
    const teams = new Set(rows.map((row) => row.team));
    const maximumTeams = gameType === "REG" ? 32 : (postseasonMaximumTeams[gameType] ?? 32);
    if (teams.size > maximumTeams) {
      throw new NflverseDatasetSourceError(
        "QUALITY_THRESHOLD",
        `nflverse injuries exceeded team coverage for ${gameType} week ${week}`,
      );
    }
    weekCoverage.push({
      week,
      seasonType: gameType === "REG" ? "REG" : "POST",
      gameType,
      teams: teams.size,
      players: new Set(rows.map((row) => row.gsisId)).size,
      observations: rows.length,
    });
  }

  return {
    coveredWeeks,
    coveredSeasonTypes: (["REG", "POST"] as const).filter((seasonType) =>
      observations.some((row) => row.seasonType === seasonType),
    ),
    coveredTeams,
    coveredReportStatuses: [
      ...new Set(
        observations
          .map((row) => row.report.status)
          .filter((status): status is NflverseReportStatus => status !== null),
      ),
    ].sort(),
    coveredPracticeStatuses: [
      ...new Set(
        observations
          .map((row) => row.practice.status)
          .filter((status): status is NflversePracticeStatus => status !== null),
      ),
    ].sort(),
    datedSnapshots: observations.filter((row) => row.dateModified !== null).length,
    weekCoverage,
  };
}

function parseInjuries(body: string, season: number) {
  const parsed = parseCsv(body);
  const observations: NflversePlayerInjuryReport[] = [];
  const rejectionCounts: Record<RejectionReason, number> = {
    invalidIdentity: 0,
    invalidContext: 0,
    invalidReport: 0,
    invalidPractice: 0,
    invalidTimestamp: 0,
    emptyObservation: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    const normalized = normalizeRow(row, season, parsed);
    if (!normalized.observation) {
      rejectionCounts[normalized.reason ?? "emptyObservation"] += 1;
      continue;
    }
    const observation = normalized.observation;
    const key = [
      observation.season,
      observation.week,
      observation.gameType,
      observation.team,
      observation.gsisId,
      observationStateKey(observation),
      observation.dateModified ?? "undated",
    ].join(":");
    if (seen.has(key)) {
      rejectionCounts.duplicate += 1;
      continue;
    }
    seen.add(key);
    observations.push(observation);
  }
  const rowsRejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);
  assertAdmissionQuality({
    datasetLabel: "nflverse injuries",
    rowsRead: parsed.rows.length,
    rowsAccepted: observations.length,
    rowsRejected,
    absoluteRejectionAllowance: ABSOLUTE_REJECTION_ALLOWANCE,
    maximumRejectionRatio: MAXIMUM_REJECTION_RATIO,
  });
  const coverage = assertCompleteArtifact(observations);
  observations.sort(
    (left, right) =>
      left.week - right.week ||
      left.gameType.localeCompare(right.gameType) ||
      left.team.localeCompare(right.team) ||
      left.gsisId.localeCompare(right.gsisId) ||
      (left.dateModified ?? "").localeCompare(right.dateModified ?? "") ||
      observationStateKey(left).localeCompare(observationStateKey(right)),
  );
  return {
    observations,
    rowsRead: parsed.rows.length,
    rowsRejected,
    rejections: rejectionCounts,
    ...coverage,
  };
}

export class NflverseInjuriesSource {
  readonly #fetch: NflverseFetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: NflverseFetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    season: number,
    previous: NflverseDatasetState,
  ): Promise<NflverseInjuriesCheckResult> {
    const sourceUrl = buildNflverseInjuriesUrl(season);
    const result = await checkNflverseCsvRelease({
      fetch: this.#fetch,
      now: this.#now,
      sourceUrl,
      previous,
      maximumBytes: MAX_RESPONSE_BYTES,
      datasetLabel: "nflverse injuries",
    });
    const base = {
      checkedAt: result.checkedAt,
      sourceKey: NFLVERSE_INJURIES_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_INJURIES_ATTRIBUTION,
      attributionUrl: NFLVERSE_INJURIES_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season,
      etag: result.etag,
      lastModified: result.lastModified,
      checksumSha256: result.checksumSha256,
    };
    if (result.state === "unchanged") return { state: "unchanged", ...base };
    return {
      state: "changed",
      ...base,
      checksumSha256: result.checksumSha256,
      ...parseInjuries(result.body, season),
    };
  }
}
